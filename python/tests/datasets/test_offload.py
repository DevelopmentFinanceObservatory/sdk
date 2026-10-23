"""The async fetch runs its disk reads and writes, hashing and decoding off the loop.

The sync client calls the same steps in place, so these tests have no sync twin.
"""

import asyncio
import threading
from collections import defaultdict
from collections.abc import Callable
from typing import Any

import httpx2
import pytest

import dfo._datasets.fetch as fetch_module
import dfo._datasets.resolve as resolve_module
from dfo._core.refs import DatasetRef, RefMember
from dfo._core.types import Spec
from dfo._datasets.cache import sha256_digest
from dfo._datasets.resolve import fetch
from dfo._http.hooks import async_offload
from dfo._http.transport import AsyncTransport
from tests._fetch_support import (
    BASE,
    DATA,
    LONG,
    NARROWED_CV,
    NARROWED_ID,
    POSTED_ID,
    FakeCache,
    Server,
    fake_build_dataset,
    json_response,
    manifest,
    parquet,
    posted_spec,
    redirect,
)

SENTENCE = "Germany's gross ODA disbursements to Nigeria for basic health care."


class Threads:
    """The threads each spied call ran on, by name."""

    def __init__(self) -> None:
        self.seen: defaultdict[str, set[int]] = defaultdict(set)

    def spy[**P, R](self, name: str, function: Callable[P, R]) -> Callable[P, R]:
        def call(*args: P.args, **kwargs: P.kwargs) -> R:
            self.seen[name].add(threading.get_ident())
            return function(*args, **kwargs)

        return call


def spied_cache(threads: Threads) -> FakeCache:
    cache = FakeCache()
    for name in ("get_bytes", "put_bytes", "get_manifest", "put_manifest"):
        setattr(cache, name, threads.spy(name, getattr(cache, name)))
    return cache


@pytest.fixture
def threads(monkeypatch: pytest.MonkeyPatch) -> Threads:
    threads = Threads()
    monkeypatch.setattr(
        fetch_module, "sha256_digest", threads.spy("sha256", sha256_digest)
    )
    decode = threads.spy("build_dataset", fake_build_dataset)
    monkeypatch.setattr(fetch_module, "build_dataset", decode)
    monkeypatch.setattr(resolve_module, "build_dataset", decode)
    monkeypatch.delenv("DFO_OFFLINE", raising=False)
    return threads


def run(server: Server, target: Spec | DatasetRef, cache: FakeCache) -> int:
    """Fetch `target` on a fresh event loop and return the loop's thread."""

    async def main() -> int:
        transport = AsyncTransport(
            base_url=BASE, api_key=False, http_transport=httpx2.MockTransport(server)
        )
        async with transport:
            await fetch(transport, target, cache=cache, progress=False)
        return threading.get_ident()

    return asyncio.run(main())


def test_offload_runs_a_call_on_a_worker_thread() -> None:
    async def main() -> tuple[int, int]:
        return threading.get_ident(), await async_offload(threading.get_ident)

    loop, worker = asyncio.run(main())
    assert loop != worker


def test_a_spec_fetch_reads_hashes_stores_and_decodes_off_the_loop(
    threads: Threads,
) -> None:
    spec = Spec(posted_spec()["spec_id"], posted_spec()["definition"], SENTENCE)
    server = Server(json_response(200, manifest(POSTED_ID)), redirect(), parquet())
    loop = run(server, spec, spied_cache(threads))
    names = {"get_bytes", "put_bytes", "get_manifest", "put_manifest", "sha256"}
    assert names | {"build_dataset"} <= threads.seen.keys()
    assert all(loop not in seen for seen in threads.seen.values())


def test_a_cached_ref_reads_and_decodes_off_the_loop(threads: Threads) -> None:
    cache = spied_cache(threads)
    FakeCache.put_bytes(cache, sha256_digest(DATA), DATA)
    body: dict[str, Any] = manifest()
    FakeCache.put_manifest(cache, NARROWED_ID, NARROWED_CV, LONG, body)
    member = RefMember(
        parts=(),
        sentence=SENTENCE,
        spec=Spec(NARROWED_ID, body["definition"], SENTENCE),
        content_version=NARROWED_CV,
        digest=sha256_digest(DATA),
        rendering=LONG,
    )
    loop = run(Server(), DatasetRef((member,)), cache)
    assert {"get_bytes", "get_manifest", "build_dataset"} <= threads.seen.keys()
    assert all(loop not in seen for seen in threads.seen.values())
