"""Build requests and long builds: posting a build and polling it to the end.

A build posts to `/datasets`. The server answers a build within its synchronous
limits with the manifest, and a larger one with a 202 operation that the client
polls at `/datasets/operations/{id}` until it is done or failed. The operation
id is a hash of the request, so a repeated identical build joins the running
one. A fetch with no timeout polls until the server ends the build, which it
always does: each dispatch has a deadline and a build whose lease goes stale is
marked failed.

This layer owns build retries. The build request is sent with
no transport retries and reads for up to 150 seconds within the call's deadline.
Every retryable refusal of the build shares the transport's retry count, and
once a synchronous cut-off (a 504, or the read timing out) refuses it, the build
is posted once more only, whatever that post answers. Each retry waits for the
refusal's `Retry-After`, else the transport's backoff for that attempt, from 0.5
to 8 seconds. A `Retry-After` past `RETRY_AFTER_MAX_S` raises the refusal at
once. A retryable failed operation is resubmitted once, and a failed
operation whose document carries no `error` fails with `operation_failed`.

Polls wait for a refused poll's `Retry-After`, whatever its status, else for
`retry_after_ms` when the resource carries it, else for the last answered
poll's `Retry-After` header, any of them clamped to `POLL_INTERVAL_MIN_S`
through `POLL_INTERVAL_MAX_S`, else back off from 1 to 8 seconds. A refused
poll whose `Retry-After` is past `RETRY_AFTER_MAX_S` raises at once. A refused
poll that is not retryable raises its error at once, a 429 included. A
retryable 429 spends no retry; any other retryable refused poll, one that times
out included, spends one of the transport's retries, which a poll that answers
restores. A poll the deadline cut off spends no retry, since the deadline cut
it and not the server. The poll at the deadline follows.

A fetch's `timeout` sets its deadline. A wait that would pass the deadline ends
at it, and the poll after it runs for one attempt of the transport's timeout.
The build is still running at the deadline only when that poll does not read it
done or failed. When it reads the build done, each request that finishes the
build, the files route and the signed download included, runs for one attempt
of the transport's timeout, so `fetch(timeout=t)` can run past `t` by one
timeout for the poll and one for each of those requests. Once the deadline has
passed, `still_running` and `finishing` raise `deadline_exceeded` saying the
build keeps running on the server, or is done there.

A poll, the 202 answer to a build and a resumed read check the operation
resource. A status outside `pending`, `running`, `done` and `failed`, a failed
operation whose error's `status` is not an integer from 400 to 599, and a poll
that answers for another operation each raise `contract_violation`.
"""

from __future__ import annotations

from collections.abc import Callable, Generator
from contextlib import contextmanager
from dataclasses import dataclass

import httpx2

from dfo._core.codes import DEADLINE_EXCEEDED, INVALID_ARGUMENT, UNEXPECTED_RESPONSE
from dfo._core.errors import DfoError, DfoTimeoutError, client_error, recast
from dfo._core.parse import violation
from dfo._core.refusals import describing, problem_error, sent_key, trace_id_of
from dfo._core.types import OPERATION_ID, Wire, matches
from dfo._datasets.build import (
    BUILD_READ_TIMEOUT,
    OperationState,
    Progress,
    check_served_manifest,
    poll_backoff,
    read_operation,
    response_json,
)
from dfo._datasets.progress import ProgressRenderer
from dfo._http.transport import (
    RETRY_AFTER_MAX_S,
    AsyncTransport,
    retry_after,
)

type ProgressHook = Callable[[str, Progress, str | None], None]

_DONE = "done"
_FAILED = "failed"
_OPERATION_FAILED = "operation_failed"
# The status a failed operation's error takes when its problem names none.
_FAILED_STATUS = 500


@dataclass(frozen=True, slots=True)
class Reply:
    """The server's answer to a build request, a manifest or an operation.

    Attributes:
        manifest: The manifest of a build that finished inline, or None.
        state: The operation of a build that runs on, or None.
        retry_after: The wait the `Retry-After` header asks for, in seconds.
        trace_id: The response's trace id.
    """

    manifest: Wire | None
    state: OperationState | None
    retry_after: float | None = None
    trace_id: str | None = None


def progress_hook(renderer: ProgressRenderer) -> ProgressHook:
    """The hook that shows each progress the server reports through `renderer`."""

    def show(operation_id: str, progress: Progress, trace_id: str | None) -> None:
        renderer.update(
            operation_id=operation_id,
            rows_written=progress.rows_written,
            estimate_rows=progress.estimate_rows,
            trace_id=trace_id,
        )

    return show


def _reply(response: httpx2.Response) -> Reply:
    if response.status_code == 200:
        manifest = response_json(response)
        trace_id = trace_id_of(response, manifest)
        with describing(trace_id):
            check_served_manifest(manifest)
        return Reply(manifest, None, trace_id=trace_id)
    if response.status_code == 202:
        return _operation_reply(response)
    raise client_error(
        UNEXPECTED_RESPONSE,
        f"POST /datasets answered HTTP {response.status_code}; "
        "a build answers 200 or 202",
        status=response.status_code,
        trace_id=trace_id_of(response),
    )


def _operation_reply(response: httpx2.Response) -> Reply:
    """A response carrying an operation resource, read and checked."""
    state, trace_id = _operation_state(response)
    return Reply(None, state, retry_after(response), trace_id)


def _operation_state(response: httpx2.Response) -> tuple[OperationState, str | None]:
    """The operation resource a response carries, checked, and its trace id."""
    body = response_json(response)
    trace_id = trace_id_of(response, body)
    with describing(trace_id):
        return read_operation(body, key=sent_key(response)), trace_id


def _poll_reply(response: httpx2.Response, operation_id: str) -> Reply:
    """A poll's answer, the resource of the operation `operation_id`.

    Raises:
        ContractError: The poll answered a status other than 200
            (`unexpected_response`), or for another operation
            (`contract_violation`), or `read_operation` refuses the resource.
    """
    if response.status_code != 200:
        raise client_error(
            UNEXPECTED_RESPONSE,
            f"GET /datasets/operations/{operation_id} answered HTTP "
            f"{response.status_code}; a poll answers 200",
            status=response.status_code,
            trace_id=trace_id_of(response),
        )
    state, trace_id = _operation_state(response)
    if (answered := state.operation_id) != operation_id:
        error = violation(
            f"The poll of {operation_id} answered for {answered}",
            pointer="/operation/operation_id",
        )
        error.trace_id = trace_id
        raise error
    return Reply(None, state, retry_after(response), trace_id)


def _problem_status(problem: object) -> int:
    """A failed operation's problem's own status, or 500 when it carries none.
    `read_operation` has checked that a status given is 400 to 599."""
    status = problem.get("status") if isinstance(problem, dict) else None
    if isinstance(status, int) and not isinstance(status, bool):
        return status
    return _FAILED_STATUS


def _is_cut_off(error: DfoError) -> bool:
    """Whether the server, or the read, cut a synchronous build off."""
    if not error.retryable:
        return False
    return error.status == 504 or (
        isinstance(error, DfoTimeoutError) and error.status is None
    )


# The bounds the poll interval a long build's server asks for is clamped to.
POLL_INTERVAL_MIN_S = 1.0
POLL_INTERVAL_MAX_S = 60.0


def poll_interval(seconds: float) -> float:
    """The server's poll interval, held between `POLL_INTERVAL_MIN_S` and
    `POLL_INTERVAL_MAX_S`."""
    return min(max(seconds, POLL_INTERVAL_MIN_S), POLL_INTERVAL_MAX_S)


async def post_build(
    transport: AsyncTransport, body: Wire, *, deadline: float | None
) -> Reply:
    """Post a build request, owning its retries.

    Args:
        transport: The transport to send it through.
        body: The `POST /datasets` body.
        deadline: The clock reading the build must answer by.

    Raises:
        DfoError: The refusal, once the retries the build allows are spent.
        ContractError: The server answered a status other than 200 or 202.
    """
    cut_off = False
    retries = 0
    while True:
        try:
            response = await transport.request(
                "POST",
                "/datasets",
                json=body,
                timeout=BUILD_READ_TIMEOUT,
                deadline=deadline,
                max_retries=0,
            )
        except DfoError as error:
            allowed = (
                error.retryable and retries < transport.max_retries and not cut_off
            )
            wait = transport.refusal_wait(error, retries, deadline)
            if not allowed or wait is None:
                raise
            await transport.sleep(wait)
            retries += 1
            cut_off = _is_cut_off(error)
            continue
        return _reply(response)


class Poller:
    """Polls one build until it is done, at the server's pacing.

    `operation_id` is None for a build the server finished inline.
    """

    def __init__(
        self,
        transport: AsyncTransport,
        reply: Reply,
        *,
        on_progress: ProgressHook,
        body: Wire | None = None,
    ) -> None:
        """Start from the server's answer to a build request.

        Args:
            transport: The transport polls go through.
            reply: The answer to the build request, or the first poll.
            on_progress: Called with each progress the server reports.
            body: The build request, resubmitted once when the operation fails
                with a retryable refusal. None for a resumed operation.
        """
        self._transport = transport
        self._body = body
        self._on_progress = on_progress
        self._manifest: Wire | None = None
        self._state: OperationState | None = None
        self._header_wait: float | None = None
        self._refused_wait: float | None = None
        self._trace_id: str | None = None
        self._error: DfoError | None = None
        self._backoff_step = 0
        self._retries = 0
        self._resubmissions = 0
        self._poll_waits: list[float] = []
        self._take(reply)

    @property
    def operation_id(self) -> str | None:
        """The operation's id, or None for a build the server finished inline."""
        return None if self._state is None else self._state.operation_id

    @property
    def poll_waits(self) -> tuple[float, ...]:
        """The waits taken before each poll, in seconds, in order."""
        return tuple(self._poll_waits)

    @property
    def resubmissions(self) -> int:
        """How many times the build was posted again after a failed operation."""
        return self._resubmissions

    @property
    def status(self) -> str:
        """`pending`, `running`, `done` or `failed`, as last read."""
        if self._error is not None:
            return _FAILED
        if self._manifest is not None:
            return _DONE
        assert self._state is not None
        return self._state.status

    async def wait(self, deadline: float | None) -> Built:
        """Poll until the build is done and return it.

        A wait that would pass `deadline` ends at it, and the poll after it runs
        for one attempt of the transport's timeout. The returned build's
        `at_deadline` says whether that poll found the build finished. It is
        False for a build already finished before this call.

        Raises:
            DfoTimeoutError: The poll at `deadline` read the build running
                (`deadline_exceeded`), or was refused retryably.
            DfoError: The build failed. A retryable failure the poll at
                `deadline` reads raises as it is, with no resubmission.
        """
        at_deadline = False
        while not self._finished():
            wait = self._next_wait()
            last = False
            if deadline is not None:
                left = max(deadline - self._transport.now(), 0.0)
                last = wait >= left
                wait = min(wait, left)
            self._poll_waits.append(wait)
            await self._transport.sleep(wait)
            await self._poll(deadline, last=last)
            at_deadline = last
            if last and not self._finished():
                raise client_error(
                    DEADLINE_EXCEEDED, "The build is still running at the deadline"
                )
        if self._error is not None:
            raise self._error
        assert self._manifest is not None
        return Built(self._manifest, self._trace_id, at_deadline)

    def _finished(self) -> bool:
        return self._manifest is not None or self._error is not None

    def _next_wait(self) -> float:
        if (refused := self._refused_wait) is not None:
            self._refused_wait = None
            return poll_interval(refused)
        if self._state is not None and self._state.retry_after is not None:
            return poll_interval(self._state.retry_after)
        if self._header_wait is not None:
            return poll_interval(self._header_wait)
        wait = poll_backoff(self._backoff_step)
        self._backoff_step += 1
        return wait

    def _take(self, reply: Reply) -> None:
        self._header_wait = reply.retry_after
        self._trace_id = reply.trace_id
        if (state := reply.state) is None:
            self._manifest = reply.manifest
            return
        self._state = state
        if state.status == _DONE:
            self._manifest = state.manifest
        elif state.status == _FAILED:
            key = self._transport.key.key
            self._error = problem_error(
                _problem_status(state.error),
                state.error,
                reason="The build failed",
                origin=self._transport.origin,
                trace_id=self._trace_id,
                fallback_code=_OPERATION_FAILED,
                key=None if key is None else key.reveal(),
            )
        elif state.progress is not None:
            self._on_progress(state.operation_id, state.progress, self._trace_id)

    async def _poll(self, deadline: float | None, *, last: bool = False) -> None:
        """Poll once within `deadline`, or, for the `last` poll at the deadline,
        for one attempt of the transport's timeout. A resubmitted build keeps to
        `deadline`."""
        operation_id = self.operation_id
        assert operation_id is not None
        bound = None if last else deadline
        try:
            response = await self._transport.request(
                "GET",
                f"/datasets/operations/{operation_id}",
                deadline=bound,
                max_retries=0,
            )
        except DfoError as error:
            # A poll the deadline cut off spends no retry, since the poll at the
            # deadline follows it. An attempt's own timeout spends one.
            if (
                bound is not None
                and error.code == DEADLINE_EXCEEDED.code
                and self._transport.now() >= bound
            ):
                return
            await self._poll_failed(error, deadline, last=last)
            return
        self._retries = 0
        self._take(_poll_reply(response, operation_id))
        if self._error is not None:
            await self._failed(self._error, deadline, last=last)

    async def _poll_failed(
        self, error: DfoError, deadline: float | None, *, last: bool
    ) -> None:
        """Keep polling after a refused poll, or raise when that cannot help."""
        if error.code == _OPERATION_FAILED:
            await self._failed(error, deadline, last=last)
            return
        if not error.retryable or (
            error.retry_after is not None and error.retry_after > RETRY_AFTER_MAX_S
        ):
            raise error
        self._refused_wait = error.retry_after
        if error.status == 429:
            return
        if self._retries >= self._transport.max_retries:
            raise error
        self._retries += 1

    async def _failed(
        self, error: DfoError, deadline: float | None, *, last: bool
    ) -> None:
        """Resubmit a build that failed retryably, once, unless the `last` poll
        at the deadline read the failure. Otherwise hold the error."""
        if not error.retryable or self._body is None or self._resubmissions or last:
            self._error = error
            return
        self._resubmissions += 1
        self._error = None
        self._take(await post_build(self._transport, self._body, deadline=deadline))


@dataclass(frozen=True, slots=True)
class Built:
    """A done build, as one call read it.

    Attributes:
        manifest: The build's manifest.
        trace_id: The trace id of the response that carried the manifest.
        at_deadline: Whether this call's poll at its deadline read the build
            done, which leaves its download no time within that deadline. False
            when an earlier poll, or an earlier call, read it.
    """

    manifest: Wire
    trace_id: str | None
    at_deadline: bool = False


def _passed(
    transport: AsyncTransport, error: DfoTimeoutError, deadline: float | None
) -> bool:
    """Whether `error` is the call's deadline passing, rather than an attempt's
    own timeout before it."""
    return (
        error.code == DEADLINE_EXCEEDED.code
        and deadline is not None
        and transport.now() >= deadline
    )


@contextmanager
def still_running(
    transport: AsyncTransport, deadline: float | None, timeout: float | None
) -> Generator[None]:
    """Raise a build's deadline passing as a build that keeps running on the server.

    `timeout` is the caller's, in seconds, which set `deadline`.

    Raises:
        DfoTimeoutError: The deadline passed while the build was posted or
            polled (`deadline_exceeded`, retryable).
    """
    try:
        yield
    except DfoTimeoutError as error:
        if not _passed(transport, error, deadline):
            raise
        raise recast(
            error,
            DfoTimeoutError,
            message=(
                f"The build is still running on the server{_after(timeout)}. "
                "The same fetch joins it if one started."
            ),
        ) from error


@contextmanager
def finishing(
    transport: AsyncTransport,
    built: Built,
    deadline: float | None,
    *,
    timeout: float | None,
) -> Generator[tuple[AsyncTransport, float | None]]:
    """The transport and deadline that download a done build's data.

    A build this call's poll at its deadline read done finishes without the
    deadline, each request sent once for one attempt of the transport's timeout.
    `timeout` is the caller's, in seconds, which set `deadline`.

    Raises:
        DfoTimeoutError: The deadline passed while the build's data was
            downloaded (`deadline_exceeded`, retryable).
    """
    try:
        if built.at_deadline:
            yield transport.single_attempt(), None
        else:
            yield transport, deadline
    except DfoTimeoutError as error:
        cut = error.code == DEADLINE_EXCEEDED.code and built.at_deadline
        if not cut and not _passed(transport, error, deadline):
            raise
        raise recast(
            error,
            DfoTimeoutError,
            message=(
                "The build is done on the server, but its download ran out of "
                f"time{_after(timeout)}. The same fetch downloads it again."
            ),
        ) from error


def _after(timeout: float | None) -> str:
    """` after 25 s` for a 25-second timeout, or nothing when it is unknown."""
    return "" if timeout is None else f" after {timeout:g} s"


async def resume(
    transport: AsyncTransport,
    operation_id: str,
    *,
    on_progress: ProgressHook,
) -> Poller:
    """Read a running build's operation by id, to poll it from this process.

    An operation that already reads `failed` holds its error, which the
    poller's `wait` raises.

    Raises:
        InvalidRequestError: `operation_id` is not `op_` and 64 hex digits
            (`invalid_argument`); no request is sent.
        NotFoundError: The server holds no operation with that id.
    """
    if not matches(OPERATION_ID, operation_id):
        raise client_error(
            INVALID_ARGUMENT,
            f"{operation_id!r} is not an operation id, which is op_ and 64 "
            "lowercase hex digits",
        )
    response = await transport.request("GET", f"/datasets/operations/{operation_id}")
    return Poller(
        transport,
        _poll_reply(response, operation_id),
        on_progress=on_progress,
    )
