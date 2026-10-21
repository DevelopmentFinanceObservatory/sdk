"""Shared pieces of the fetch and operation tests: mock servers, bodies, fakes.

Nothing here awaits, so the async tests and the sync tests generated from them
use the same helpers; `SlowBody` serves both flavours of client.
"""

import copy
import json
import threading
from collections.abc import AsyncIterator, Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import httpx2

from dfo._cache import sha256_digest
from dfo._types import Rendering

from ._data import CONTRACT, load

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
) -> dict[str, Any]:
    """The recorded narrowed manifest, renamed and pointed at `data`."""
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
    if retention is not None:
        body["retention"] = dict(retention)
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
    """The cache interface over dicts, recording what fetches store."""

    files: dict[str, bytes] = field(default_factory=dict)
    manifests: dict[tuple[str, str, Rendering], dict[str, Any]] = field(
        default_factory=dict
    )

    def get_bytes(self, digest: str, /) -> bytes | None:
        return self.files.get(digest)

    def put_bytes(self, digest: str, data: bytes, /) -> None:
        assert sha256_digest(data) == digest
        self.files[digest] = data

    def get_manifest(
        self, spec_id: str, content_version: str, rendering: Rendering, /
    ) -> dict[str, Any] | None:
        return self.manifests.get((spec_id, content_version, rendering))

    def put_manifest(
        self,
        spec_id: str,
        content_version: str,
        rendering: Rendering,
        manifest: Mapping[str, Any],
        /,
    ) -> None:
        self.manifests[(spec_id, content_version, rendering)] = copy.deepcopy(
            dict(manifest)
        )

    def latest_manifest(
        self, spec_id: str, rendering: Rendering, /
    ) -> dict[str, Any] | None:
        stored = [
            manifest
            for (stored_id, _, stored_rendering), manifest in self.manifests.items()
            if (stored_id, stored_rendering) == (spec_id, rendering)
        ]
        return max(stored, key=lambda body: body["prepared_at"], default=None)


@dataclass
class Built:
    """What the fake `build_dataset` received."""

    members: list[Any]
    layout: str
    complete: bool
    missing: tuple[Any, ...]
    stale: bool


def fake_build_dataset(
    members: Sequence[Any], *, layout: str, complete: bool, missing: Any, stale: bool
) -> Built:
    return Built(list(members), layout, complete, tuple(missing), stale)


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


class SlowBody(httpx2.SyncByteStream, httpx2.AsyncByteStream):
    """A response body whose second chunk arrives `seconds` after its first.

    `advance` moves the test's clock, so a deadline can pass mid-read.
    """

    def __init__(self, advance: Callable[[float], None], seconds: float) -> None:
        self._advance = advance
        self._seconds = seconds

    def __iter__(self) -> Iterator[bytes]:
        yield b'{"part": '
        self._advance(self._seconds)
        yield b"1}"

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for chunk in self:
            yield chunk
