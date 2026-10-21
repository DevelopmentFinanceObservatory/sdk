"""Tests for build retries and long builds: the 504 rule, polling, pacing, resuming.

`scripts/gen_sync.py` derives `tests/_sync/test_operation.py` from this file, so
the sync client passes the same tests.
"""

import logging

import httpx2
import pytest

import dfo._fetch as fetch_module
from dfo import _errors
from dfo._errors import ContractError, DfoTimeoutError, NotFoundError, ServerError
from dfo._fetch import fetch, mint, operation
from dfo._parse import parse_spec
from dfo._transport import AsyncTransport
from dfo._types import Spec

from .._fetch_support import (
    BASE,
    NARROWED_ID,
    OP_ID,
    POSTED_ID,
    Server,
    fake_build_dataset,
    json_response,
    manifest,
    parquet,
    posted_spec,
    problem,
    redirect,
    resubmitted,
)
from .._fetch_support import (
    operation as resource,
)

pytestmark = pytest.mark.anyio

SENTENCE = "Germany's gross ODA disbursements to Nigeria for basic health care."
POLL = f"GET {BASE}/datasets/operations/{OP_ID}"


class Timeline:
    """A clock and a sleep that advances it at once, recording each wait."""

    def __init__(self) -> None:
        self.now = 1000.0
        self.sleeps: list[float] = []

    def clock(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


@pytest.fixture(autouse=True)
def fake_dataset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(fetch_module, "build_dataset", fake_build_dataset)
    monkeypatch.setattr(_errors, "_warned", set())
    monkeypatch.delenv("DFO_OFFLINE", raising=False)


def make(handler, timeline: Timeline | None = None, **options) -> AsyncTransport:
    timeline = timeline or Timeline()
    options.setdefault("api_key", False)
    options.setdefault("base_url", BASE)
    return AsyncTransport(
        http_transport=httpx2.MockTransport(handler),
        sleep=timeline.sleep,
        clock=timeline.clock,
        **options,
    )


def spec() -> Spec:
    return Spec(
        parse_spec(posted_spec()).spec_id, posted_spec()["definition"], SENTENCE
    )


def done(body: dict | None = None) -> httpx2.Response:
    return json_response(200, resource("done", body=body or manifest(POSTED_ID)))


def accepted(**members) -> httpx2.Response:
    headers = members.pop("headers", None)
    return json_response(202, resource("pending", **members), headers)


async def test_a_cut_off_build_is_rebuilt_once() -> None:
    timeline = Timeline()
    server = Server(
        problem(504, "timeout", retryable=True),
        json_response(200, manifest(POSTED_ID)),
        redirect(),
        parquet(),
    )
    async with make(server, timeline) as transport:
        built = await fetch(transport, spec())
    assert [call.split(" ")[0] for call in server.calls()[:2]] == ["POST", "POST"]
    assert server.body(0) == server.body(1)
    assert timeline.sleeps == []
    assert built.members[0].spec.spec_id == POSTED_ID


@pytest.mark.parametrize(
    "response",
    [
        httpx2.Response(201, json={}),
        httpx2.Response(200, content=b"<html>", headers={"content-type": "text/html"}),
    ],
    ids=["status", "not-json"],
)
async def test_a_build_answer_the_client_cannot_read_is_unexpected(
    response: httpx2.Response,
) -> None:
    async with make(Server(response)) as transport:
        with pytest.raises(ContractError) as caught:
            await fetch(transport, spec())
    assert (caught.value.code, caught.value.status) == (
        "unexpected_response",
        response.status_code,
    )


async def test_a_second_cut_off_raises() -> None:
    server = Server(
        problem(504, "timeout", retryable=True), problem(504, "timeout", retryable=True)
    )
    async with make(server) as transport:
        with pytest.raises(ServerError) as caught:
            await fetch(transport, spec())
    assert caught.value.code == "timeout"
    assert len(server.requests) == 2


async def test_a_read_timeout_on_the_build_counts_as_the_cut_off() -> None:
    server = Server(
        httpx2.ReadTimeout("slow"),
        httpx2.ReadTimeout("slow"),
    )
    async with make(server) as transport:
        with pytest.raises(DfoTimeoutError):
            await fetch(transport, spec())
    assert len(server.requests) == 2
    assert server.requests[0].extensions["timeout"]["read"] == 150.0


async def test_a_backlog_refusal_backs_off_within_the_retry_count() -> None:
    timeline = Timeline()
    busy = problem(503, "service_unavailable", retryable=True)
    server = Server(busy, busy, busy)
    async with make(server, timeline, max_retries=2) as transport:
        with pytest.raises(ServerError):
            await fetch(transport, spec())
    assert len(server.requests) == 3
    assert timeline.sleeps == [1.0, 2.0]


def refused(status: int, code: str, wait: str) -> httpx2.Response:
    """A retryable refusal whose `Retry-After` header asks for `wait`."""
    response = problem(status, code, retryable=True)
    return json_response(status, response.json(), {"retry-after": wait})


async def test_a_backlog_refusal_waits_for_its_retry_after() -> None:
    timeline = Timeline()
    busy = refused(503, "service_unavailable", "4")
    server = Server(
        busy, busy, json_response(200, manifest(POSTED_ID)), redirect(), parquet()
    )
    async with make(server, timeline, max_retries=2) as transport:
        await fetch(transport, spec())
    assert timeline.sleeps == [4.0, 4.0]


async def test_a_429_poll_waits_for_its_retry_after() -> None:
    timeline = Timeline()
    server = Server(
        accepted(retry_after_ms=1000),
        refused(429, "rate_limited", "6"),
        done(),
        redirect(),
        parquet(),
    )
    async with make(server, timeline) as transport:
        await fetch(transport, spec())
    assert timeline.sleeps == [1.0, 6.0]


async def test_a_long_build_polls_at_the_servers_pacing_then_finishes() -> None:
    timeline = Timeline()
    server = Server(
        accepted(retry_after_ms=1500),
        json_response(
            200,
            resource("running", progress={"rows_written": 10, "estimate_rows": 99}),
        ),
        json_response(
            200,
            resource("running", retry_after_ms=3000),
            {"retry-after": "7"},
        ),
        json_response(200, resource("running"), {"retry-after": "5"}),
        json_response(200, resource("running")),
        done(),
        redirect(),
        parquet(),
    )
    async with make(server, timeline) as transport:
        built = await fetch(transport, spec())
    assert server.calls()[1:6] == [POLL] * 5
    assert timeline.sleeps == [1.5, 1.0, 3.0, 5.0, 2.0]
    assert built.members[0].sentence == SENTENCE


async def test_a_429_poll_waits_without_spending_retries() -> None:
    limited = problem(429, "rate_limited", retryable=True)
    busy = problem(503, "service_unavailable", retryable=True)
    server = Server(
        accepted(), limited, limited, limited, busy, busy, done(), redirect(), parquet()
    )
    async with make(server, max_retries=2) as transport:
        built = await fetch(transport, spec())
    assert built.members[0].spec.spec_id == POSTED_ID


async def test_poll_failures_beyond_the_retry_count_raise() -> None:
    busy = problem(503, "service_unavailable", retryable=True)
    server = Server(accepted(), busy, busy, busy)
    async with make(server, max_retries=2) as transport:
        with pytest.raises(ServerError):
            await fetch(transport, spec())
    assert len(server.requests) == 4


async def test_a_retryable_failed_operation_is_resubmitted_once() -> None:
    failed = problem(500, "operation_failed", retryable=True)
    server = Server(accepted(), failed, accepted(), done(), redirect(), parquet())
    async with make(server) as transport:
        await fetch(transport, spec())
    assert server.calls()[2] == f"POST {BASE}/datasets"
    assert server.body(2) == server.body(0)

    server = Server(accepted(), failed, accepted(), failed)
    async with make(server) as transport:
        with pytest.raises(ServerError) as caught:
            await fetch(transport, spec())
    assert caught.value.code == "operation_failed"
    assert len(server.requests) == 4


async def test_a_failed_operation_body_raises_its_problem() -> None:
    failed = resource("failed")
    failed["error"] = {"code": "upstream_error", "status": 502, "retryable": False}
    server = Server(accepted(), json_response(200, failed))
    async with make(server) as transport:
        with pytest.raises(ServerError) as caught:
            await fetch(transport, spec())
    assert (caught.value.code, caught.value.status) == ("upstream_error", 502)

    del failed["error"]["status"]
    server = Server(accepted(), json_response(200, failed))
    async with make(server) as transport:
        with pytest.raises(ServerError) as caught:
            await fetch(transport, spec())
    assert caught.value.status == 500


async def test_the_deadline_names_the_call_that_resumes_the_build() -> None:
    timeline = Timeline()
    server = Server(
        accepted(retry_after_ms=8000),
        json_response(200, resource("running", retry_after_ms=8000)),
    )
    async with make(server, timeline) as transport:
        with pytest.raises(DfoTimeoutError) as caught:
            await fetch(transport, spec(), timeout=10.0)
    assert f'client.operation("{OP_ID}").result()' in str(caught.value)
    assert caught.value.code == "deadline_exceeded"
    assert timeline.sleeps == [8.0]


async def test_mint_returns_an_operation_and_progress_is_logged(
    caplog: pytest.LogCaptureFixture,
) -> None:
    server = Server(
        accepted(progress={"rows_written": 0, "estimate_rows": 500000}),
        json_response(
            200,
            resource("running", progress={"rows_written": 9, "estimate_rows": 500000}),
        ),
        done(),
        redirect(),
        parquet(),
    )
    async with make(server) as transport:
        with caplog.at_level(logging.INFO, logger="dfo"):
            started = await mint(transport, spec())
            assert (started.operation_id, started.status) == (OP_ID, "pending")
            assert await started.done() is False
            assert started.progress is not None
            assert started.progress.rows_written == 9
            built = await started.result()
    assert built.members[0].sentence == SENTENCE
    assert OP_ID in caplog.text


async def test_an_inline_mint_is_already_done() -> None:
    server = Server(json_response(200, manifest(POSTED_ID)), redirect(), parquet())
    async with make(server) as transport:
        started = await mint(transport, spec(), progress=False)
        assert started.operation_id is None
        assert await started.done() is True
        built = await started.result()
    assert len(server.requests) == 3
    assert built.members[0].content_version == manifest(POSTED_ID)["content_version"]


async def test_a_resumed_operation_asks_search_for_its_sentence() -> None:
    body = manifest(NARROWED_ID)
    server = Server(
        json_response(200, resource("running")),
        done(body),
        json_response(200, resubmitted()),
        redirect(),
        parquet(),
    )
    async with make(server) as transport:
        resumed = await operation(transport, OP_ID)
        built = await resumed.result()
    assert server.calls()[:2] == [POLL, POLL]
    assert server.calls()[2] == f"POST {BASE}/search/resolve"
    assert built.members[0].spec.spec_id == NARROWED_ID
    assert "2020 to 2023" in built.members[0].sentence


async def test_resuming_an_unknown_operation_raises() -> None:
    server = Server(problem(404, "operation_not_found"))
    async with make(server) as transport:
        with pytest.raises(NotFoundError):
            await operation(transport, OP_ID)
