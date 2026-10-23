"""Tests for build retries and long builds: the 504 rule, polling, pacing, resuming.

`scripts/gen_sync.py` derives `tests/_sync/datasets/test_operation.py` from this
file, so the sync client passes the same tests.
"""

import logging

import httpx2
import pytest

import dfo._datasets.fetch as fetch_module
import dfo._datasets.resolve as resolve_module
from dfo._core import errors as _errors
from dfo._core.errors import (
    ContractError,
    DfoError,
    DfoTimeoutError,
    NotFoundError,
    RateLimitError,
    ServerError,
)
from dfo._core.json_text import JSON_MAX_DEPTH
from dfo._core.parse import parse_spec
from dfo._core.types import Spec
from dfo._datasets.cache import sha256_digest
from dfo._datasets.fetch import mint, operation
from dfo._datasets.resolve import fetch
from dfo._http.transport import AsyncTransport
from tests._fetch_support import (
    BASE,
    CUT,
    CUT_DATA,
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
    with_cut,
)
from tests._fetch_support import (
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
    monkeypatch.setattr(resolve_module, "build_dataset", fake_build_dataset)
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


@pytest.mark.parametrize(
    ("headers", "sleeps"), [(None, [0.5]), ({"retry-after": "9"}, [9.0])]
)
async def test_a_cut_off_build_is_rebuilt_once_after_its_wait(
    headers: dict[str, str] | None, sleeps: list[float]
) -> None:
    timeline = Timeline()
    server = Server(
        problem(504, "timeout", retryable=True, headers=headers),
        json_response(200, manifest(POSTED_ID)),
        redirect(),
        parquet(),
    )
    async with make(server, timeline) as transport:
        built = await fetch(transport, spec())
    assert [call.split(" ")[0] for call in server.calls()[:2]] == ["POST", "POST"]
    assert server.body(0) == server.body(1)
    assert timeline.sleeps == sleeps
    assert built.members[0].spec.spec_id == POSTED_ID


@pytest.mark.parametrize(
    "response",
    [
        httpx2.Response(201, json={}),
        httpx2.Response(200, content=b"<html>", headers={"content-type": "text/html"}),
        httpx2.Response(
            200, content=b"[" * (JSON_MAX_DEPTH + 1) + b"]" * (JSON_MAX_DEPTH + 1)
        ),
    ],
    ids=["status", "not-json", "nested-past-the-depth-bound"],
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
    assert timeline.sleeps == [0.5, 1.0]


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


@pytest.mark.parametrize(
    ("status", "code"), [(429, "rate_limited"), (503, "service_unavailable")]
)
async def test_a_refused_poll_waits_for_its_retry_after(status: int, code: str) -> None:
    timeline = Timeline()
    server = Server(
        accepted(retry_after_ms=1000),
        refused(status, code, "6"),
        done(),
        redirect(),
        parquet(),
    )
    async with make(server, timeline) as transport:
        await fetch(transport, spec())
    assert timeline.sleeps == [1.0, 6.0]


@pytest.mark.parametrize(
    ("before", "sleeps"), [((), []), ((accepted(),), [1.0])], ids=["build", "poll"]
)
async def test_a_retry_after_past_the_ceiling_raises_at_once(
    before: tuple[httpx2.Response, ...], sleeps: list[float]
) -> None:
    timeline = Timeline()
    server = Server(*before, refused(503, "service_unavailable", "61"), done())
    async with make(server, timeline) as transport:
        with pytest.raises(ServerError) as caught:
            await fetch(transport, spec())
    assert (caught.value.code, caught.value.retry_after) == ("service_unavailable", 61)
    assert timeline.sleeps == sleeps
    assert len(server.requests) == len(before) + 1


@pytest.mark.parametrize(
    ("members", "wait"),
    [
        ({"retry_after_ms": 0}, 1.0),
        ({"retry_after_ms": 86_400_000}, 60.0),
        ({"headers": {"retry-after": "0"}}, 1.0),
        ({"headers": {"retry-after": "86400"}}, 60.0),
    ],
    ids=["zero-ms", "a-day-ms", "zero-header", "a-day-header"],
)
async def test_the_servers_poll_interval_is_clamped_to_one_to_sixty_seconds(
    members: dict, wait: float
) -> None:
    timeline = Timeline()
    server = Server(accepted(**members), done(), redirect(), parquet())
    async with make(server, timeline) as transport:
        await fetch(transport, spec())
    assert timeline.sleeps == [wait]


# Ids a hostile or broken server could name, each of which would reach the poll
# path: an injected query, a path out of the operations route, and an encoded one.
HOSTILE_IDS = ["op_x?foo=1", "../../search/resolve", "op_%2e%2e", "op_" + "A" * 64]


def named(operation_id: str, status: str = "pending") -> dict:
    body = resource(status)
    body["operation"]["operation_id"] = operation_id
    return body


@pytest.mark.parametrize("operation_id", HOSTILE_IDS)
@pytest.mark.parametrize("reply", ["accepted", "poll"])
async def test_an_operation_id_that_is_not_an_id_is_never_polled(
    operation_id: str, reply: str
) -> None:
    hostile = named(operation_id, "pending" if reply == "accepted" else "running")
    responses = [json_response(202, hostile)]
    if reply == "poll":
        responses = [accepted(), json_response(200, hostile)]
    server = Server(*responses)
    async with make(server) as transport:
        with pytest.raises(ContractError) as caught:
            await fetch(transport, spec())
    assert (caught.value.code, caught.value.pointer) == (
        "contract_violation",
        "/operation/operation_id",
    )
    assert len(server.requests) == len(responses)
    assert all(operation_id not in str(request.url) for request in server.requests)


@pytest.mark.parametrize(
    "content_version", ["x", "../../etc", "cv_" + "A" * 32, "cv_" + "a" * 32 + "\n"]
)
@pytest.mark.parametrize("reply", ["inline", "operation"])
async def test_a_manifest_whose_version_is_not_a_version_id_is_refused(
    content_version: str, reply: str
) -> None:
    body = manifest(POSTED_ID, content_version)
    response = (
        json_response(200, body)
        if reply == "inline"
        else json_response(202, resource("done", body=body))
    )
    server = Server(response)
    async with make(server) as transport:
        with pytest.raises(ContractError) as caught:
            await fetch(transport, spec())
    pointer = "/content_version" if reply == "inline" else "/manifest/content_version"
    assert (caught.value.code, caught.value.pointer) == ("contract_violation", pointer)
    assert len(server.requests) == 1


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


@pytest.mark.parametrize(
    ("failure", "error"),
    [
        (problem(503, "service_unavailable", retryable=True), ServerError),
        (httpx2.ReadTimeout("hung"), DfoTimeoutError),
    ],
    ids=["refused", "hung"],
)
async def test_poll_failures_beyond_the_retry_count_raise(
    failure: httpx2.Response | Exception, error: type[Exception]
) -> None:
    server = Server(accepted(), failure, failure, failure)
    async with make(server, max_retries=2, timeout=30.0) as transport:
        with pytest.raises(error):
            await fetch(transport, spec())
    assert len(server.requests) == 4
    assert server.requests[1].extensions["timeout"]["read"] == 30.0


@pytest.mark.parametrize(
    ("status", "code", "error"),
    [(408, "request_timeout", DfoTimeoutError), (429, "rate_limited", RateLimitError)],
)
async def test_a_poll_refused_for_good_raises_that_refusal_at_once(
    status: int, code: str, error: type[DfoError]
) -> None:
    timeline = Timeline()
    final = problem(status, code, retryable=False)
    server = Server(
        accepted(), json_response(status, final.json(), {"retry-after": "3"}), done()
    )
    async with make(server, timeline) as transport:
        with pytest.raises(error) as caught:
            await fetch(transport, spec())
    assert (caught.value.code, caught.value.status) == (code, status)
    assert len(server.requests) == 2


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


async def test_a_failed_operation_without_an_error_fails_with_operation_failed() -> (
    None
):
    failed = json_response(200, resource("failed"), {"x-dfo-trace-id": "trace-op"})
    server = Server(accepted(), failed, accepted(), failed)
    async with make(server) as transport:
        with pytest.raises(ServerError) as caught:
            await fetch(transport, spec())
    assert (caught.value.code, caught.value.status) == ("operation_failed", 500)
    assert caught.value.trace_id == "trace-op"
    assert server.calls()[2] == f"POST {BASE}/datasets"
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


@pytest.mark.parametrize(
    ("options", "arguments"),
    [
        ({}, f'"{OP_ID}"'),
        ({"layout": "frame"}, f'"{OP_ID}", layout="frame"'),
        ({"without_party_totals": True}, f'"{OP_ID}", without_party_totals=True'),
    ],
)
async def test_the_deadline_names_the_call_that_resumes_the_build(
    options: dict, arguments: str
) -> None:
    timeline = Timeline()
    server = Server(
        accepted(retry_after_ms=8000),
        json_response(200, resource("running", retry_after_ms=8000)),
    )
    async with make(server, timeline) as transport:
        with pytest.raises(DfoTimeoutError) as caught:
            await fetch(transport, spec(), timeout=10.0, **options)
    assert f"client.operation({arguments}).result()" in str(caught.value)
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


async def test_mint_and_resume_select_the_party_totals_cut() -> None:
    minted = with_cut(manifest(POSTED_ID))
    resumed = with_cut(manifest(NARROWED_ID))
    server = Server(
        json_response(200, minted),
        redirect(),
        parquet(CUT_DATA),
        done(resumed),
        json_response(200, resubmitted()),
        redirect(),
        parquet(CUT_DATA),
    )
    async with make(server) as transport:
        started = await mint(transport, spec(), without_party_totals=True)
        built = await started.result()
        assert server.body(0)["options"] == {
            "format": "parquet",
            "bundle": False,
            "without_party_totals": True,
        }
        later = await operation(transport, OP_ID, without_party_totals=True)
        again = await later.result()
    for dataset in (built, again):
        (member,) = dataset.members
        assert (member.digest, member.rendering) == (sha256_digest(CUT_DATA), CUT)


async def test_resuming_an_unknown_operation_raises() -> None:
    server = Server(problem(404, "operation_not_found"))
    async with make(server) as transport:
        with pytest.raises(NotFoundError):
            await operation(transport, OP_ID)
