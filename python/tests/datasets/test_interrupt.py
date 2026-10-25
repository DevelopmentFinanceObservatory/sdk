"""Ctrl-C during a sync build notes that the build keeps running on the server.

`asyncio.run` delivers Ctrl-C as a cancellation of the main task, so the async
client has no note to add, and this test has no async twin.
"""

import httpx2
import pytest

import dfo._sync._datasets.fetch as fetch_module
from dfo._core.parse import parse_spec
from dfo._core.types import Spec
from dfo._datasets.interrupt import INTERRUPT_NOTE
from dfo._sync._datasets.resolve import fetch
from dfo._sync._http.transport import Transport
from tests._fetch_support import (
    BASE,
    Server,
    fake_build_dataset,
    json_response,
    posted_spec,
)
from tests._fetch_support import (
    operation as resource,
)


def interrupt(seconds: float) -> None:
    raise KeyboardInterrupt


def test_an_interrupted_build_notes_that_the_same_fetch_joins_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(fetch_module, "build_dataset", fake_build_dataset)
    monkeypatch.delenv("DFO_OFFLINE", raising=False)
    server = Server(json_response(202, resource("pending")))
    transport = Transport(
        base_url=BASE,
        api_key=False,
        http_transport=httpx2.MockTransport(server),
        sleep=interrupt,
    )
    spec = Spec(parse_spec(posted_spec()).spec_id, posted_spec()["definition"], "")
    with transport, pytest.raises(KeyboardInterrupt) as caught:
        fetch(transport, spec)
    assert caught.value.__notes__ == [INTERRUPT_NOTE]
    assert server.calls() == [f"POST {BASE}/datasets"]
