"""Tests for build retries and long builds: the 504 rule, polling, pacing, waiting.

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
    InvalidRequestError,
    NotFoundError,
    RateLimitError,
    ServerError,
)
from dfo._core.json_text import JSON_MAX_DEPTH
from dfo._core.parse import parse_spec
from dfo._core.timeouts import CLIENT_TIMEOUT, CallTimeout
from dfo._core.types import Spec
from dfo._datasets.cache import sha256_digest
from dfo._datasets.operation import resume
from dfo._datasets.resolve import fetch
from dfo._http.transport import AsyncTransport
from tests._fetch_support import (
    BASE,
    CUT,
    CUT_DATA,
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


async def resumed(transport: AsyncTransport) -> None:
    """Read the operation `OP_ID` by its id, as the contract's `operation` step
    does."""
    await resume(transport, OP_ID, on_progress=lambda *_: None)


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
    ("status", "code", "after", "wait"),
    [
        (429, "rate_limited", "6", 6.0),
        (503, "service_unavailable", "6", 6.0),
        (429, "rate_limited", "0", 1.0),
        (503, "service_unavailable", "0", 1.0),
    ],
)
async def test_a_refused_poll_waits_for_its_retry_after_from_one_second(
    status: int, code: str, after: str, wait: float
) -> None:
    timeline = Timeline()
    server = Server(
        accepted(retry_after_ms=1000),
        refused(status, code, after),
        done(),
        redirect(),
        parquet(),
    )
    async with make(server, timeline) as transport:
        await fetch(transport, spec())
    assert timeline.sleeps == [1.0, wait]


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


@pytest.mark.parametrize("status", ["cancelled", "queued", ""])
@pytest.mark.parametrize("reply", ["accepted", "poll", "resumed"])
async def test_an_operation_status_outside_the_contract_raises_on_its_read(
    status: str, reply: str
) -> None:
    unknown = json_response(200, resource(status))
    responses = {
        "accepted": [json_response(202, resource(status))],
        "poll": [accepted(), unknown],
        "resumed": [unknown],
    }[reply]
    server = Server(*responses)
    async with make(server) as transport:
        with pytest.raises(ContractError) as caught:
            if reply == "resumed":
                await resumed(transport)
            else:
                await fetch(transport, spec())
    assert (caught.value.code, caught.value.pointer) == (
        "contract_violation",
        "/operation/status",
    )
    assert len(server.requests) == len(responses)


@pytest.mark.parametrize("reply", ["poll", "resumed"])
async def test_a_poll_answering_for_another_operation_raises(reply: str) -> None:
    other = json_response(200, named("op_" + "b" * 64, "running"))
    responses = [accepted(), other] if reply == "poll" else [other]
    server = Server(*responses)
    async with make(server) as transport:
        with pytest.raises(ContractError) as caught:
            if reply == "resumed":
                await resumed(transport)
            else:
                await fetch(transport, spec())
    assert (caught.value.code, caught.value.pointer) == (
        "contract_violation",
        "/operation/operation_id",
    )
    assert len(server.requests) == len(responses)


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
    async with make(server, max_retries=2, attempt_timeout=30.0) as transport:
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


@pytest.mark.parametrize("status", [200, 302, 600, "502", True, None])
async def test_a_failed_operations_error_status_outside_4xx_and_5xx_is_a_violation(
    status: object,
) -> None:
    failed = resource("failed")
    failed["error"] = {"code": "upstream_error", "status": status}
    server = Server(accepted(), json_response(200, failed))
    async with make(server) as transport:
        with pytest.raises(ContractError) as caught:
            await fetch(transport, spec())
    assert (caught.value.code, caught.value.pointer) == (
        "contract_violation",
        "/error/status",
    )


@pytest.mark.parametrize("member", ["status", "error_status"])
async def test_a_refused_operation_status_is_quoted_capped_and_redacted(
    member: str,
) -> None:
    key = "dfo_k_4f8Kq2ZtR7mWx1NcB9vLp3YhD6sGa0Ue2wanxe"
    text = f"{key} " + "x" * 2000
    if member == "status":
        refused = resource(text)
    else:
        refused = resource("failed")
        refused["error"] = {"code": "upstream_error", "status": text}
    server = Server(accepted(), json_response(200, refused))
    async with make(server, api_key=key) as transport:
        with pytest.raises(ContractError) as caught:
            await fetch(transport, spec())
    assert str(caught.value).startswith("The ")
    assert key not in str(caught.value)
    assert "[redacted]" in str(caught.value)
    assert len(str(caught.value)) < 1200


@pytest.mark.parametrize(
    ("client_timeout", "timeout"),
    [(None, 1.0), (1.0, CLIENT_TIMEOUT), (100.0, 1.0)],
    ids=["call", "client", "call-over-client"],
)
async def test_the_poll_at_the_deadline_runs_for_one_attempt(
    client_timeout: float | None, timeout: CallTimeout
) -> None:
    # The backoff's first wait of 1 s reaches the deadline, so the client waits
    # until it and polls once more with the client's own attempt timeout.
    timeline = Timeline()
    server = Server(accepted(), json_response(200, resource("running")))
    async with make(
        server, timeline, timeout=client_timeout, attempt_timeout=30.0
    ) as transport:
        with pytest.raises(DfoTimeoutError) as caught:
            await fetch(transport, spec(), timeout=timeout)
    assert timeline.sleeps == [1.0]
    assert server.calls()[1] == POLL
    assert server.requests[1].extensions["timeout"]["read"] == 30.0
    assert caught.value.code == "deadline_exceeded"


def _failed_retryably() -> dict[str, object]:
    failed = resource("failed")
    failed["error"] = {"code": "upstream_error", "status": 502, "retryable": True}
    return failed


@pytest.mark.parametrize(
    ("poll", "code"),
    [
        (problem(500, "operation_failed", retryable=True), "operation_failed"),
        (json_response(200, _failed_retryably()), "upstream_error"),
    ],
    ids=["refused", "read-failed"],
)
async def test_a_retryable_failure_read_at_the_deadline_raises_without_resubmitting(
    poll: httpx2.Response, code: str
) -> None:
    timeline = Timeline()
    server = Server(accepted(), poll, accepted(), done(), redirect(), parquet())
    async with make(server, timeline, attempt_timeout=30.0) as transport:
        with pytest.raises(ServerError) as caught:
            await fetch(transport, spec(), timeout=1.0)
    assert (caught.value.code, caught.value.retryable) == (code, True)
    assert server.calls() == [f"POST {BASE}/datasets", POLL]


@pytest.mark.parametrize("finishes", [True, False], ids=["done", "running"])
async def test_a_poll_cut_by_the_deadline_spends_no_retry(finishes: bool) -> None:
    # The first poll runs into the deadline and times out. With no retries to
    # spend it still gets the poll at the deadline, which reads the build.
    timeline = Timeline()
    last = (
        (done(), redirect(), parquet())
        if finishes
        else (json_response(200, resource("running")),)
    )
    server = Server(accepted(), httpx2.ReadTimeout("cut"), *last)

    def handler(request: httpx2.Request) -> httpx2.Response:
        if len(server.requests) == 1:
            timeline.now += 4.0
        return server(request)

    async with make(
        handler, timeline, max_retries=0, attempt_timeout=30.0
    ) as transport:
        if finishes:
            built = await fetch(transport, spec(), timeout=5.0)
            assert built.members[0].sentence == SENTENCE
        else:
            with pytest.raises(DfoTimeoutError) as caught:
                await fetch(transport, spec(), timeout=5.0)
            assert caught.value.code == "deadline_exceeded"
    assert timeline.sleeps == [1.0, 0.0]
    assert server.calls()[1:3] == [POLL] * 2
    assert server.requests[2].extensions["timeout"]["read"] == 30.0


async def test_a_build_done_at_the_deadline_downloads_one_attempt_per_request() -> None:
    timeline = Timeline()
    server = Server(accepted(), done(), redirect(), parquet())
    async with make(server, timeline, attempt_timeout=30.0) as transport:
        built = await fetch(transport, spec(), timeout=1.0)
    assert built.members[0].sentence == SENTENCE
    assert timeline.sleeps == [1.0]
    # The poll, the files route and the signed download each get the client's
    # timeout, past the deadline.
    assert [r.extensions["timeout"]["read"] for r in server.requests[1:]] == [30.0] * 3


async def test_a_download_failing_after_the_deadline_says_the_build_is_done() -> None:
    timeline = Timeline()
    server = Server(accepted(), done(), httpx2.ReadTimeout("slow"))
    async with make(server, timeline) as transport:
        with pytest.raises(DfoTimeoutError) as caught:
            await fetch(transport, spec(), timeout=1.0)
    assert (caught.value.code, caught.value.retryable) == ("deadline_exceeded", True)
    assert "The same fetch downloads it again" in str(caught.value)
    assert isinstance(caught.value.__cause__, DfoTimeoutError)
    # The files route is asked once, with no retry.
    assert len(server.requests) == 3


@pytest.mark.parametrize(
    ("options", "client_options", "whose"),
    [
        ({"timeout": 10.0}, {}, "call's"),
        ({"timeout": 10.0, "layout": "frame"}, {}, "call's"),
        ({"timeout": 10.0, "party_totals": True}, {}, "call's"),
        ({}, {"timeout": 10.0}, "client's"),
    ],
    ids=["long", "frame", "party-totals", "client-timeout"],
)
async def test_the_deadline_says_the_same_fetch_joins_the_build(
    options: dict, client_options: dict, whose: str
) -> None:
    timeline = Timeline()
    running = json_response(200, resource("running", retry_after_ms=8000))
    server = Server(accepted(retry_after_ms=8000), running, running)
    async with make(server, timeline, **client_options) as transport:
        with pytest.raises(DfoTimeoutError) as caught:
            await fetch(transport, spec(), **options)
    assert (caught.value.code, caught.value.retryable) == ("deadline_exceeded", True)
    assert f"after 10 s, the {whose} timeout. The same fetch joins it" in str(
        caught.value
    )
    # The last wait ends at the deadline, and the poll there still reads running.
    assert timeline.sleeps == [8.0, 2.0]
    assert len(server.requests) == 3


async def test_a_default_fetch_waits_past_thirty_minutes_for_its_build() -> None:
    # The server paces polls at the 60 s ceiling; 31 running polls take the
    # build past 1,800 s, which the default fetch waits out.
    timeline = Timeline()
    running = json_response(200, resource("running", retry_after_ms=60000))
    server = Server(
        accepted(retry_after_ms=60000),
        *[running] * 31,
        done(),
        redirect(),
        parquet(),
    )
    async with make(server, timeline) as transport:
        built = await fetch(transport, spec())
    assert sum(timeline.sleeps) > 1800.0
    assert built.members[0].sentence == SENTENCE


async def test_a_long_builds_progress_is_logged(
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
            built = await fetch(transport, spec())
    assert built.members[0].sentence == SENTENCE
    assert OP_ID in caplog.text


async def test_a_long_build_selects_the_party_totals_cut() -> None:
    server = Server(
        accepted(),
        done(manifest(POSTED_ID, data=CUT_DATA)),
        redirect(),
        parquet(CUT_DATA),
    )
    async with make(server) as transport:
        built = await fetch(transport, spec())
    assert server.body(0)["options"] == {
        "format": "parquet",
        "bundle": False,
        "without_party_totals": True,
    }
    (member,) = built.members
    assert (member.digest, member.rendering) == (sha256_digest(CUT_DATA), CUT)


async def test_resuming_an_unknown_operation_raises() -> None:
    server = Server(problem(404, "operation_not_found"))
    async with make(server) as transport:
        with pytest.raises(NotFoundError):
            await resumed(transport)


@pytest.mark.parametrize("operation_id", ["../search/resolve", *HOSTILE_IDS])
async def test_an_id_that_is_not_an_operation_id_is_never_read(
    operation_id: str,
) -> None:
    server = Server()
    async with make(server) as transport:
        with pytest.raises(InvalidRequestError) as caught:
            await resume(transport, operation_id, on_progress=lambda *_: None)
    assert caught.value.code == "invalid_argument"
    assert server.requests == []
