"""The callables a transport takes for its clock, its sleep and extra headers, the
offload that keeps blocking work off the event loop, and the locks both flavours
take.

The async and sync transports take the same hooks in their own flavour, so the
async source names the `Async` alias and `scripts/gen_sync.py` swaps in the
sync one. Async sources run disk reads, writes, hashing and Parquet decoding
through `async_offload`, which runs them on a worker thread; their sync twins
call `sync_offload`, which runs them in place. `KeyedLock` serves `async with`
in an async source and `with` in its sync twin, and `event_loop` names the loop
an async httpx2 client sends on.
"""

import asyncio
import os
import threading
import time
from collections.abc import Awaitable, Callable, Hashable, Mapping
from dataclasses import dataclass
from typing import Any

import httpx2

from dfo._core.codes import DEADLINE_EXCEEDED
from dfo._core.errors import DfoError, client_error

type Clock = Callable[[], float]
type Sleep = Callable[[float], None]
type AsyncSleep = Callable[[float], Awaitable[None]]
type HeaderProvider = Callable[[], Mapping[str, str]]
type AsyncHeaderProvider = Callable[[], Awaitable[Mapping[str, str]]]

monotonic: Clock = time.monotonic
sync_sleep: Sleep = time.sleep
async_sleep: AsyncSleep = asyncio.sleep


async def async_offload[**P, R](
    function: Callable[P, R], /, *args: P.args, **kwargs: P.kwargs
) -> R:
    """Run a blocking call on a worker thread, so the event loop keeps running."""
    return await asyncio.to_thread(function, *args, **kwargs)


def sync_offload[**P, R](
    function: Callable[P, R], /, *args: P.args, **kwargs: P.kwargs
) -> R:
    """Run a blocking call on the calling thread, as the sync client does."""
    return function(*args, **kwargs)


def event_loop(client: httpx2.AsyncClient | httpx2.Client, /) -> object | None:
    """The running event loop an async client sends on, or None for a sync client."""
    if isinstance(client, httpx2.AsyncClient):
        return asyncio.get_running_loop()
    return None


class KeyedLock:
    """One holder per key at a time, among threads or among one loop's tasks.

    `with lock.hold(key)` blocks a thread, and `async with lock.hold(key)` waits
    as a task, so an async source and its sync twin share one call. Each key's
    lock lives while it has holders or waiters. A forked child starts with no
    locks and a fresh guard over them, since a parent thread may hold either at
    the fork.
    """

    __slots__ = ("_guard", "_locks")

    def __init__(self) -> None:
        self._reset()
        if hasattr(os, "register_at_fork"):
            os.register_at_fork(after_in_child=self._reset)

    def _reset(self) -> None:
        self._guard = threading.Lock()
        self._locks: dict[Hashable, _Entry[Any]] = {}

    def hold(self, key: Hashable, /, *, timeout: float | None = None) -> "Hold":
        """A context manager, sync or async, that holds `key`'s lock.

        Entering it waits up to `timeout` seconds, or without limit for None.

        Raises:
            DfoTimeoutError: The wait passed `timeout` (`deadline_exceeded`).
        """
        return Hold(self, key, timeout)

    def _enter[L](self, key: Hashable, make: Callable[[], L]) -> "_Entry[L]":
        with self._guard:
            entry = self._locks.get(key)
            if entry is None:
                entry = self._locks[key] = _Entry(make())
            entry.holders += 1
            return entry

    def _leave(self, key: Hashable, entry: "_Entry[Any]") -> None:
        with self._guard:
            entry.holders -= 1
            if entry.holders == 0:
                del self._locks[key]


@dataclass(slots=True)
class _Entry[L]:
    lock: L
    holders: int = 0


class Hold:
    """One hold of a `KeyedLock` key, entered once, sync or async."""

    __slots__ = ("_held", "_key", "_owner", "_timeout")

    def __init__(self, owner: KeyedLock, key: Hashable, timeout: float | None) -> None:
        self._owner = owner
        self._key = key
        self._timeout = timeout
        self._held: tuple[Hashable, _Entry[Any]] | None = None

    def __enter__(self) -> None:
        key = ("thread", self._key)
        entry = self._owner._enter(key, threading.Lock)
        try:
            wait = -1 if self._timeout is None else max(self._timeout, 0)
            if not entry.lock.acquire(timeout=wait):
                raise _waited_too_long()
        except BaseException:
            self._owner._leave(key, entry)
            raise
        self._held = key, entry

    def __exit__(self, *exc_info: object) -> None:
        self._release()

    async def __aenter__(self) -> None:
        # An asyncio lock serves one loop, so each loop holds its own.
        key = (asyncio.get_running_loop(), self._key)
        entry = self._owner._enter(key, asyncio.Lock)
        try:
            async with asyncio.timeout(self._timeout):
                await entry.lock.acquire()
        except TimeoutError:
            self._owner._leave(key, entry)
            raise _waited_too_long() from None
        except BaseException:
            self._owner._leave(key, entry)
            raise
        self._held = key, entry

    async def __aexit__(self, *exc_info: object) -> None:
        self._release()

    def _release(self) -> None:
        assert self._held is not None
        key, entry = self._held
        entry.lock.release()
        self._owner._leave(key, entry)


def _waited_too_long() -> DfoError:
    return client_error(
        DEADLINE_EXCEEDED,
        "The call's deadline passed while it waited for another call to finish",
    )
