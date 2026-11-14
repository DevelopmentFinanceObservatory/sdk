"""Shared pieces of the fetch and operation tests: mock servers, bodies, fakes.

Nothing here awaits, so the async tests and the sync tests generated from them
use the same helpers.
"""

import copy
import dataclasses
import json
import socket
import threading
import time
from collections.abc import AsyncIterator, Iterator, Mapping, Sequence
from contextlib import contextmanager, nullcontext
from dataclasses import dataclass, field
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import httpx2

from dfo._core.types import Rendering
from dfo._datasets.cache import sha256_digest
from tests._data import CONTRACT, load

BASE = "https://api.example.org/api/v1"
ORIGIN = "https://api.example.org"
SIGNED = "https://storage.googleapis.com/bucket/object?X-Goog-Signature=redacted"
DATA = b"PAR1 long layout PAR1"
FRAME = b"PAR1 frame layout PAR1"
POSTED_ID = "spec_774d6c001a6250aa67ca676ab067895e"
NARROWED_ID = "spec_cb5baa4161de718f18583060674dbca6"
NARROWED_CV = "cv_bf242138f8d0a892c97da9373d1626f4"
OP_ID = "op_" + "a" * 64
LONG = Rendering("parquet", False)
CUT = Rendering("parquet", False, without_party_totals=True)
CUT_DATA = b"PAR1 long layout without party totals PAR1"


def json_response(
    status: int, body: object, headers: Mapping[str, str] | None = None
) -> httpx2.Response:
    content_type = "application/problem+json" if status >= 400 else "application/json"
    return httpx2.Response(
        status,
        headers={"content-type": content_type, **(headers or {})},
        content=json.dumps(body).encode(),
    )


def problem(
    status: int,
    code: str,
    *,
    retryable: bool = False,
    headers: Mapping[str, str] | None = None,
) -> httpx2.Response:
    return json_response(
        status,
        {
            "type": f"/codes/{code}",
            "title": code,
            "status": status,
            "detail": f"refused with {code}",
            "code": code,
            "trace_id": "trace",
            "retryable": retryable,
        },
        headers,
    )


class Body(httpx2.SyncByteStream, httpx2.AsyncByteStream):
    """A response body served piece by piece, counting the pieces read."""

    def __init__(self, pieces: Sequence[bytes] | Iterator[bytes]) -> None:
        self._pieces = iter(pieces)
        self.read = 0

    def __iter__(self) -> Iterator[bytes]:
        for piece in self._pieces:
            self.read += 1
            yield piece

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for piece in self:
            yield piece


def redirect(location: str = SIGNED) -> httpx2.Response:
    return httpx2.Response(302, headers={"location": location})


def parquet(data: bytes = DATA) -> httpx2.Response:
    return httpx2.Response(
        200, headers={"content-type": "application/vnd.apache.parquet"}, content=data
    )


def manifest(
    spec_id: str = NARROWED_ID,
    content_version: str = NARROWED_CV,
    data: bytes = DATA,
    *,
    layout: Any = 3,
    warnings: Sequence[Mapping[str, str]] = (),
    retention: Mapping[str, Any] | None = None,
    size: int | None = None,
    party_totals: bool = False,
) -> dict[str, Any]:
    """The recorded narrowed manifest, renamed and pointed at `data`, whose
    artifact names `size` as its `bytes` when given. Its artifact is the
    party-totals cut a default fetch builds unless `party_totals` keeps them."""
    body = load("probe-mint-narrowed.json")
    body["definition"]["spec_id"] = spec_id
    body["content_version"] = content_version
    body["warnings"] = list(warnings)
    digest = sha256_digest(data)
    body["artifacts"] = [
        {
            "artifact_digest": "sha256:" + "0" * 64,
            "rendering": {"statistics": "series"},
            "url": f"/api/datasets/{spec_id}/{content_version}/files/sha256:{'0' * 64}",
        },
        {
            "artifact_digest": digest,
            "rendering": {"format": "parquet", "bundle": False, "layout": layout},
            "url": f"/api/datasets/{spec_id}/{content_version}/files/{digest}",
        },
    ]
    if not party_totals:
        body["artifacts"][1]["rendering"]["without_party_totals"] = True
    if size is not None:
        body["artifacts"][1]["bytes"] = size
    if retention is not None:
        body["retention"] = dict(retention)
    return body


def with_cut(body: dict[str, Any], data: bytes = CUT_DATA) -> dict[str, Any]:
    """`body` with a party-totals cut of its Parquet artifact listed after it, as
    the server lists a cut that leaves nothing out under the plain version."""
    digest = sha256_digest(data)
    spec_id, content_version = body["definition"]["spec_id"], body["content_version"]
    body["artifacts"].append(
        {
            "artifact_digest": digest,
            "rendering": {
                **body["artifacts"][1]["rendering"],
                "without_party_totals": True,
            },
            "url": f"/api/datasets/{spec_id}/{content_version}/files/{digest}",
        }
    )
    return body


# The spellings a server may serve the party-totals cut in, by name.
SERVED_CUTS: dict[str, dict[str, bool]] = {
    "without_party_totals": {"without_party_totals": True},
    "party_totals": {"party_totals": False},
    "both": {"without_party_totals": True, "party_totals": False},
}


def respelled(body: dict[str, Any], spelling: str) -> dict[str, Any]:
    """`body` with each artifact rendering that is the cut spelling it as
    `SERVED_CUTS[spelling]`, which readers take as the same cut."""
    for artifact in body["artifacts"]:
        rendering = artifact["rendering"]
        if rendering.pop("without_party_totals", None) is True:
            rendering.update(SERVED_CUTS[spelling])
    return body


def files_path(body: Mapping[str, Any]) -> str:
    """The files route of `body`'s Parquet artifact, under the origin."""
    return ORIGIN + body["artifacts"][1]["url"]


def operation(
    status: str,
    *,
    retry_after_ms: int | None = None,
    progress: Mapping[str, int] | None = None,
    body: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    envelope: dict[str, Any] = {"operation_id": OP_ID, "status": status}
    if status in ("pending", "running"):
        envelope["poll"] = f"/api/datasets/operations/{OP_ID}"
    if retry_after_ms is not None:
        envelope["retry_after_ms"] = retry_after_ms
    if progress is not None:
        envelope["progress"] = dict(progress)
    resource: dict[str, Any] = {"operation": envelope}
    if body is not None:
        resource["manifest"] = body
    return resource


def resubmitted(spec_id: str = NARROWED_ID) -> dict[str, Any]:
    """The recorded identity resubmit answer, naming `spec_id`."""
    answer = load("probe-resubmit-identity.json")
    spec = answer["parts"][0]["spec"]
    spec["spec_id"] = spec_id
    spec["definition"]["spec_id"] = spec_id
    return answer


def posted_spec() -> dict[str, Any]:
    """The definite part's spec of the recorded answer `search-1.json`."""
    return load("search-1.json")["parts"][0]["spec"]


class Server:
    """Serves queued responses and records the requests that took them."""

    def __init__(self, *responses: httpx2.Response | Exception) -> None:
        self.responses = list(responses)
        self.requests: list[httpx2.Request] = []

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        if not self.responses:
            raise AssertionError(f"unexpected {request.method} {request.url}")
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response

    def calls(self) -> list[str]:
        return [f"{r.method} {r.url.copy_with(query=None)}" for r in self.requests]

    def body(self, index: int) -> Any:
        return json.loads(self.requests[index].content)


class Replay:
    """Serves a contract scenario's exchanges in order, matching each request."""

    def __init__(self, name: str, base_url: str = BASE) -> None:
        directory = CONTRACT / "scenarios"
        self.record = json.loads((directory / f"{name}.json").read_text())
        self.directory = directory
        self.base_url = base_url
        self.origin = "/".join(base_url.split("/")[:3])
        self.exchanges = list(self.record["exchanges"])
        self.requests: list[httpx2.Request] = []

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        if not self.exchanges:
            raise AssertionError(f"no exchange left for {request.method} {request.url}")
        exchange = self.exchanges.pop(0)
        expected = exchange["request"]
        target = (
            self.base_url + expected["path"]
            if "path" in expected
            else self.origin + expected["origin_path"]
            if "origin_path" in expected
            else expected["url"]
        )
        assert (request.method, str(request.url)) == (expected["method"], target)
        for key, value in expected.get("json", {}).items():
            assert json.loads(request.content)[key] == value, key
        answer = exchange["response"]
        if "body_file" in answer:
            content = (self.directory / answer["body_file"]).read_bytes()
        elif "json" in answer:
            content = json.dumps(answer["json"]).encode()
        else:
            content = b""
        return httpx2.Response(
            answer["status"], headers=answer.get("headers", {}), content=content
        )


@dataclass
class FakeCache:
    """The cache interface over dicts, recording what fetches store. A manifest's
    key leaves out the rendering's `without_party_totals`, as the cache layout
    rule's does."""

    files: dict[str, bytes] = field(default_factory=dict)
    manifests: dict[tuple[str, str, Rendering], dict[str, Any]] = field(
        default_factory=dict
    )

    times: dict[str, datetime] = field(default_factory=dict)

    def get_bytes(self, digest: str, /) -> bytes | None:
        return self.files.get(digest)

    def put_bytes(
        self, digest: str, data: bytes, /, *, fetched_at: datetime | None = None
    ) -> None:
        assert sha256_digest(data) == digest
        self.files[digest] = data
        if fetched_at is not None:
            self.times[digest] = fetched_at

    def fetched_at(self, digest: str, /) -> datetime | None:
        return self.times.get(digest)

    def discard(self, digest: str, /) -> None:
        self.files.pop(digest, None)
        self.times.pop(digest, None)

    def downloading(
        self, digest: str, /, *, timeout: float | None = None
    ) -> nullcontext[None]:
        return nullcontext()

    def merging(
        self, spec_id: str, content_version: str, rendering: Rendering, /
    ) -> nullcontext[None]:
        return nullcontext()

    def get_manifest(
        self, spec_id: str, content_version: str, rendering: Rendering, /
    ) -> dict[str, Any] | None:
        return self.manifests.get((spec_id, content_version, _keyed(rendering)))

    def put_manifest(
        self,
        spec_id: str,
        content_version: str,
        rendering: Rendering,
        manifest: Mapping[str, Any],
        /,
    ) -> None:
        self.manifests[(spec_id, content_version, _keyed(rendering))] = copy.deepcopy(
            dict(manifest)
        )

    def manifest_candidates(
        self, spec_id: str, rendering: Rendering, /
    ) -> list[dict[str, Any]]:
        stored = [
            manifest
            for (stored_id, _, stored_rendering), manifest in self.manifests.items()
            if (stored_id, stored_rendering) == (spec_id, _keyed(rendering))
        ]
        return sorted(stored, key=lambda body: body["prepared_at"], reverse=True)


def _keyed(rendering: Rendering) -> Rendering:
    """The rendering as a manifest's cache key names it, without party totals."""
    return dataclasses.replace(rendering, without_party_totals=False)


@dataclass
class Built:
    """What the fake `build_dataset` received."""

    members: list[Any]
    layout: str
    complete: bool
    missing: tuple[Any, ...]
    stale: bool
    question: str | None = None


def fake_build_dataset(
    members: Sequence[Any],
    *,
    layout: str,
    complete: bool,
    missing: Any,
    stale: bool,
    cache: Any = None,
    caller: str = "dfo",
    question: str | None = None,
) -> Built:
    return Built(list(members), layout, complete, tuple(missing), stale, question)


type LiveResponse = tuple[int, Mapping[str, str], bytes]


@dataclass
class LiveServer:
    """A real HTTP server on 127.0.0.1 that answers each path with a fixed response.

    It exercises httpx2's own URL handling, which `httpx2.MockTransport` skips.

    Attributes:
        origin: The server's `http://127.0.0.1:<port>`.
        seen: Each request's method, path and headers, in order.
    """

    origin: str
    seen: list[tuple[str, str, dict[str, str]]]


@contextmanager
def live_server(responses: Mapping[str, LiveResponse]) -> Iterator[LiveServer]:
    """Serve `responses` by request path (query included) until the block ends."""
    seen: list[tuple[str, str, dict[str, str]]] = []

    class Handler(BaseHTTPRequestHandler):
        def _answer(self) -> None:
            length = int(self.headers.get("content-length") or 0)
            self.rfile.read(length)
            seen.append((self.command, self.path, dict(self.headers.items())))
            status, headers, body = responses.get(self.path, (404, {}, b""))
            self.send_response(status)
            for name, value in headers.items():
                self.send_header(name, value)
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            self._answer()

        def do_POST(self) -> None:
            self._answer()

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield LiveServer(f"http://127.0.0.1:{server.server_address[1]}", seen)
    finally:
        server.shutdown()
        server.server_close()


@contextmanager
def stalling_server(*, first_chunk_after: float) -> Iterator[str]:
    """Serve one response that sends its headers, one body chunk after
    `first_chunk_after` seconds, and then nothing until the block ends.

    Yields:
        The server's `http://127.0.0.1:<port>`.
    """
    done = threading.Event()
    listener = socket.create_server(("127.0.0.1", 0))

    def serve() -> None:
        connection, _ = listener.accept()
        with connection:
            connection.recv(65536)
            connection.sendall(
                b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n"
                b"transfer-encoding: chunked\r\n\r\n"
            )
            time.sleep(first_chunk_after)
            connection.sendall(b"1\r\n{\r\n")
            done.wait()

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{listener.getsockname()[1]}"
    finally:
        done.set()
        thread.join(timeout=5)
        listener.close()


@contextmanager
def silent_server(*, close_after: float) -> Iterator[str]:
    """Accept one connection, send nothing on it, and close it after
    `close_after` seconds, so a client that waits on the TLS handshake fails
    then rather than hanging.

    Yields:
        The server's `https://127.0.0.1:<port>`.
    """
    listener = socket.create_server(("127.0.0.1", 0))

    def serve() -> None:
        connection, _ = listener.accept()
        with connection:
            time.sleep(close_after)

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    try:
        yield f"https://127.0.0.1:{listener.getsockname()[1]}"
    finally:
        thread.join(timeout=close_after + 5)
        listener.close()
