"""Concurrent fetches of one artifact download it once, async tasks and threads alike,
and a fetch waits for another only until its deadline.

Concurrency has no sync form in `scripts/gen_sync.py`, so the async tests run the
async client on one loop and the sync tests run the sync client on threads.
"""

import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx2
import pytest

import dfo._datasets.fetch as fetch_module
import dfo._datasets.resolve as resolve_module
import dfo._sync._datasets.fetch as sync_fetch_module
import dfo._sync._datasets.resolve as sync_resolve_module
from dfo._core.errors import DfoTimeoutError
from dfo._core.refs import DatasetRef, RefMember
from dfo._core.types import Spec
from dfo._datasets.cache import Cache, sha256_digest
from dfo._datasets.resolve import fetch
from dfo._http.hooks import KeyedLock
from dfo._http.transport import AsyncTransport
from dfo._sync._datasets.resolve import fetch as sync_fetch
from dfo._sync._http.transport import Transport
from tests._fetch_support import (
    BASE,
    DATA,
    LONG,
    NARROWED_CV,
    NARROWED_ID,
    POSTED_ID,
    SIGNED,
    fake_build_dataset,
    json_response,
    manifest,
    parquet,
    posted_spec,
    redirect,
)

FETCHES = 10
SENTENCE = "Germany's gross ODA disbursements to Nigeria for basic health care."


@pytest.fixture(autouse=True)
def fake_dataset(monkeypatch: pytest.MonkeyPatch) -> None:
    for module in (
        fetch_module,
        resolve_module,
        sync_fetch_module,
        sync_resolve_module,
    ):
        monkeypatch.setattr(module, "build_dataset", fake_build_dataset)
    monkeypatch.delenv("DFO_OFFLINE", raising=False)


class Routes:
    """Answers builds, snapshots, files routes and signed fetches, counting the
    signed fetches."""

    def __init__(self) -> None:
        self.downloads = 0
        self._count = threading.Lock()

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        if request.url.host == httpx2.URL(SIGNED).host:
            with self._count:
                self.downloads += 1
            return parquet()
        if "/files/" in request.url.path:
            return redirect()
        if request.method == "POST":
            return json_response(200, manifest(POSTED_ID))
        return json_response(200, manifest())


def targets() -> dict[str, Spec | DatasetRef]:
    body = manifest()
    member = RefMember(
        parts=(),
        sentence=SENTENCE,
        spec=Spec(NARROWED_ID, body["definition"], SENTENCE),
        content_version=NARROWED_CV,
        digest=sha256_digest(DATA),
        rendering=LONG,
    )
    return {
        "spec": Spec(POSTED_ID, posted_spec()["definition"], SENTENCE),
        "ref": DatasetRef((member,)),
    }


@pytest.mark.parametrize("target", ["spec", "ref"])
def test_concurrent_async_fetches_download_one_file_once(
    tmp_path: Path, target: str
) -> None:
    routes = Routes()
    cache = Cache(tmp_path, env={})

    async def main() -> list[object]:
        transport = AsyncTransport(
            base_url=BASE, api_key=False, http_transport=httpx2.MockTransport(routes)
        )
        async with transport:
            fetches = [
                fetch(transport, targets()[target], cache=cache, progress=False)
                for _ in range(FETCHES)
            ]
            return await asyncio.gather(*fetches)

    built = asyncio.run(main())
    assert routes.downloads == 1
    assert len(built) == FETCHES
    assert cache.get_bytes(sha256_digest(DATA)) == DATA


@pytest.mark.parametrize("target", ["spec", "ref"])
def test_concurrent_threads_download_one_file_once(tmp_path: Path, target: str) -> None:
    # The threads start their fetches together, so they look for the file at once.
    start = threading.Barrier(FETCHES, timeout=10)
    routes = Routes()
    cache = Cache(tmp_path, env={})

    def one(transport: Transport) -> object:
        start.wait()
        return sync_fetch(transport, targets()[target], cache=cache, progress=False)

    with (
        Transport(
            base_url=BASE, api_key=False, http_transport=httpx2.MockTransport(routes)
        ) as transport,
        ThreadPoolExecutor(FETCHES) as pool,
    ):
        built = list(pool.map(one, [transport] * FETCHES))
    assert routes.downloads == 1
    assert len(built) == FETCHES


def test_a_wait_for_another_fetch_ends_at_the_deadline() -> None:
    lock = KeyedLock()

    async def wait_as_a_task() -> None:
        async with lock.hold("digest"), lock.hold("digest", timeout=0.01):
            pass

    with lock.hold("digest"), ThreadPoolExecutor(1) as pool:
        waiter = pool.submit(lambda: lock.hold("digest", timeout=0.01).__enter__())
        with pytest.raises(DfoTimeoutError) as in_a_thread:
            waiter.result()
    with pytest.raises(DfoTimeoutError) as in_a_task:
        asyncio.run(wait_as_a_task())
    assert in_a_thread.value.code == in_a_task.value.code == "deadline_exceeded"
    with lock.hold("digest"):
        pass
