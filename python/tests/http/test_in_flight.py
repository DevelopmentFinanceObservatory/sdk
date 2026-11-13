"""Tests for what bounds a request in flight: an async header provider that never
answers, and a client closed while it waits.

These run on the real clock, since the provider bound and the close race real
waits, so each test keeps its waits to a fraction of a second.
"""

import asyncio
import time

import httpx2
import pytest

from dfo._core.errors import DfoTimeoutError, NetworkError
from dfo._http.transport import AsyncTransport
from tests._fetch_support import stalling_server

BASE = "https://api.example.org/api"
TIMEOUT = 0.2


def _unsent(request: httpx2.Request) -> httpx2.Response:
    raise AssertionError(f"{request.url} was sent")


def test_an_async_header_provider_is_bounded_by_the_attempts_timeout() -> None:
    async def never() -> dict[str, str]:
        await asyncio.Event().wait()
        return {}

    async def main() -> DfoTimeoutError:
        transport = AsyncTransport(
            base_url=BASE,
            api_key=False,
            attempt_timeout=TIMEOUT,
            header_provider=never,
            http_transport=httpx2.MockTransport(_unsent),
        )
        async with transport:
            with pytest.raises(DfoTimeoutError) as caught:
                await transport.request("GET", "/datasets/schema")
        return caught.value

    start = time.monotonic()
    error = asyncio.run(main())
    assert error.code == "deadline_exceeded"
    assert time.monotonic() - start < 10 * TIMEOUT


def test_a_header_providers_own_timeout_error_passes_through() -> None:
    async def fails() -> dict[str, str]:
        raise TimeoutError("token service")

    async def main() -> None:
        transport = AsyncTransport(
            base_url=BASE,
            api_key=False,
            attempt_timeout=TIMEOUT,
            header_provider=fails,
            http_transport=httpx2.MockTransport(_unsent),
        )
        async with transport:
            await transport.request("GET", "/datasets/schema")

    with pytest.raises(TimeoutError, match="token service"):
        asyncio.run(main())


def test_a_client_closed_mid_request_raises_a_network_error_naming_the_close() -> None:
    async def main(url: str) -> NetworkError:
        transport = AsyncTransport(base_url=url, api_key=False, max_retries=2)
        sent = asyncio.create_task(transport.request("GET", "/datasets/schema"))
        await asyncio.sleep(TIMEOUT)
        await transport.aclose()
        with pytest.raises(NetworkError) as caught:
            await sent
        return caught.value

    with stalling_server(first_chunk_after=0) as url:
        error = asyncio.run(main(url))
    assert error.code == "network_error"
    assert "closed while the request was in flight" in str(error)
