"""The module functions `dfo.search`, `dfo.fetch` and `dfo.configure`, over a default
client.

The default client is built on first use, under a lock, so importing `dfo` reads
neither the environment nor the network. `configure` replaces it. An answer from
`dfo.search` reads the default client when each of its requests runs, so it stays
usable after `configure`. A replaced client closes once nothing uses it, since
another thread may still be in a call on it, and the default client closes at exit.
A forked child drops the client it inherited without closing it, since the parent
still owns those connections, and builds its own on first use.
"""

import os
import threading
import weakref
from collections.abc import Mapping, Sequence
from os import PathLike

from dfo._answer import SEARCH_TIMEOUT
from dfo._build import Layout, Window
from dfo._dataset import Dataset
from dfo._hooks import HeaderProvider
from dfo._keys import ApiKeyArgument
from dfo._sync._answer import Answer
from dfo._sync._client import Client
from dfo._sync._fetch import Session
from dfo._sync._search import search as _search
from dfo._types import DatasetRef, Spec

_lock = threading.Lock()
_client: Client | None = None
# Close each default client when it is collected, or at exit if it never is.
_closers: list[weakref.finalize] = []


def default_client() -> Client:
    """The default client, built with no options on first use."""
    client = _client
    if client is not None:
        return client
    with _lock:
        if _client is None:
            _install(Client())
        assert _client is not None
        return _client


def _install(client: Client) -> None:
    global _client  # noqa: PLW0603  # the module holds the one default client
    _client = client
    _closers[:] = [closer for closer in _closers if closer.alive]
    _closers.append(weakref.finalize(client, client._current().transport.close))


def _session() -> Session:
    return default_client()._current()


def configure(
    *,
    api_key: ApiKeyArgument = None,
    base_url: str | None = None,
    timeout: float = 30.0,
    max_retries: int = 2,
    cache_dir: str | PathLike[str] | None = None,
    cache: bool = True,
    default_headers: Mapping[str, str] | None = None,
    header_provider: HeaderProvider | None = None,
) -> None:
    """Replace the client `dfo.search` and `dfo.fetch` use.

    Takes `dfo.Client`'s options. Answers already returned by `dfo.search` use
    the new client for their next request.

    Raises:
        ValueError: The base URL, timeout or retry count is invalid.
        AuthenticationError: The key lookup failed.
    """
    client = Client(
        api_key=api_key,
        base_url=base_url,
        timeout=timeout,
        max_retries=max_retries,
        cache_dir=cache_dir,
        cache=cache,
        default_headers=default_headers,
        header_provider=header_provider,
    )
    with _lock:
        _install(client)


def search(question: str, /, *, timeout: float | None = SEARCH_TIMEOUT) -> Answer:
    """Ask Search what a question means, part by part, with the default client.

    Args:
        question: The question, in your words.
        timeout: The longest the call waits, retries included, in seconds; None
            waits as long as Search takes.

    Raises:
        ContractError: The answer lacks a member the client acts on.
    """
    return _search(_session, question, timeout=timeout)


def fetch(
    target: Spec | DatasetRef,
    /,
    *,
    window: Window | None = None,
    entities: Mapping[str, Sequence[str]] | None = None,
    facets: Mapping[str, str | None] | None = None,
    layout: Layout | None = None,
    strict: bool = False,
    timeout: float | None = 1800.0,
    progress: bool | None = None,
) -> Dataset:
    """Fetch a spec's latest version, or the exact versions a ref names, with the
    default client.

    Takes `Client.fetch`'s arguments.

    Raises:
        InvalidRequestError: A ref is narrowed or given another layout.
        VersionUnavailableError: A ref's version can no longer be fetched.
        DfoTimeoutError: The deadline passed; a long build's message names the
            call that resumes it.
        DfoError: The server refused a request.
    """
    return default_client().fetch(
        target,
        window=window,
        entities=entities,
        facets=facets,
        layout=layout,
        strict=strict,
        timeout=timeout,
        progress=progress,
    )


def _reset_after_fork() -> None:
    global _lock, _client  # noqa: PLW0603  # a child starts with neither
    _lock = threading.Lock()
    _client = None
    for closer in _closers:
        closer.detach()
    _closers.clear()


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_reset_after_fork)
