"""An async client used from one event loop after another opens fresh connections.

Each `asyncio.run` makes a new loop, which `scripts/gen_sync.py` cannot express,
so this test has no sync twin.
"""

import asyncio
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from dfo._client.client import AsyncClient


@contextmanager
def keep_alive_server() -> Iterator[str]:
    """Serve `{}` on every path over HTTP/1.1, keeping each connection open."""

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self) -> None:
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", "2")
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


def test_an_async_client_serves_one_loop_after_another() -> None:
    with keep_alive_server() as origin:
        client = AsyncClient(base_url=f"{origin}/api", api_key=False, cache=False)

        async def status() -> int:
            return (await client.request("GET", "/datasets/capabilities")).status_code

        assert asyncio.run(status()) == 200
        assert asyncio.run(status()) == 200
        asyncio.run(client.aclose())
