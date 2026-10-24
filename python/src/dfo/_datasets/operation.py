"""Build requests and long-build operations: posting, polling and resuming a build.

A build posts to `/datasets`. The server answers a build within its synchronous
limits with the manifest, and a larger one with a 202 operation that the client
polls at `/datasets/operations/{id}` until it is done or the deadline passes.

This layer owns build retries. The build request is sent with
no transport retries and reads for up to 150 seconds within the call's deadline.
Every retryable refusal of the build shares the transport's retry count, and
once a synchronous cut-off (a 504, or the read timing out) refuses it, the build
is posted once more only, whatever that post answers. Each retry waits for the
refusal's `Retry-After`, else the transport's backoff for that attempt, from 0.5
to 8 seconds. A `Retry-After` past `RETRY_AFTER_MAX_S` raises the refusal at
once. A retryable failed operation is resubmitted once, and a failed
operation whose document carries no `error` fails with `operation_failed`.

Polls wait for `retry_after_ms` when the resource carries it, else for the
`Retry-After` header, either clamped to `POLL_INTERVAL_MIN_S` through
`POLL_INTERVAL_MAX_S`, else back off from 1 to 8 seconds. A refused poll that
keeps polling waits for its `Retry-After` when it carries one, whatever its
status, and one past `RETRY_AFTER_MAX_S` raises at once. A refused poll that is
not retryable raises its error at once, a 429
included. A retryable 429 spends no retry; any other retryable refused poll,
one that times out included, spends one of the transport's retries, which a poll
that answers restores.
"""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

import httpx2

from dfo._core.codes import DEADLINE_EXCEEDED, INVALID_ARGUMENT, UNEXPECTED_RESPONSE
from dfo._core.errors import DfoError, DfoTimeoutError, client_error
from dfo._core.refusals import describing, problem_error, trace_id_of
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
from dfo._datasets.dataset import Dataset
from dfo._datasets.progress import ProgressRenderer
from dfo._http.transport import (
    POLL_INTERVAL_MAX_S,
    POLL_INTERVAL_MIN_S,
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


class Finish(Protocol):
    """Turns a done build's manifest into the dataset an operation returns."""

    async def __call__(
        self, manifest: Wire, trace_id: str | None, deadline: float | None, /
    ) -> Dataset:
        """Download, check and assemble the dataset for `manifest`, read from
        the response whose trace id is `trace_id`."""
        ...


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
    body = response_json(response)
    trace_id = trace_id_of(response, body)
    with describing(trace_id):
        state = read_operation(body)
    return Reply(None, state, retry_after(response), trace_id)


def _problem_status(problem: object) -> int:
    """A failed operation's problem's own status, or 500 when it carries none."""
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


def _fits(transport: AsyncTransport, wait: float, deadline: float | None) -> bool:
    return deadline is None or transport.now() + wait < deadline


def _poll_interval(seconds: float) -> float:
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
        body: Wire | None = None,
        on_progress: ProgressHook | None = None,
    ) -> None:
        """Start from the server's answer to a build request.

        Args:
            transport: The transport polls go through.
            reply: The answer to the build request, or the first poll.
            body: The build request, resubmitted once when the operation fails
                with a retryable refusal. None for a resumed operation.
            on_progress: Called with each progress the server reports.
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
    def transport(self) -> AsyncTransport:
        """The transport polls go through."""
        return self._transport

    @property
    def operation_id(self) -> str | None:
        """The operation's id, or None for a build the server finished inline."""
        return None if self._state is None else self._state.operation_id

    @property
    def progress(self) -> Progress | None:
        """The progress the server last reported, or None."""
        return None if self._state is None else self._state.progress

    @property
    def trace_id(self) -> str | None:
        """The trace id of the response the build was last read from."""
        return self._trace_id

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

    async def done(self) -> bool:
        """Whether the build has finished, polling once when it had not."""
        if not self._finished():
            await self._poll(None)
        return self._finished()

    async def wait(self, deadline: float | None) -> Wire:
        """Poll until the build is done and return its manifest.

        Raises:
            DfoTimeoutError: The build was still running at `deadline`.
            DfoError: The build failed.
        """
        while not self._finished():
            wait = self._next_wait()
            if not _fits(self._transport, wait, deadline):
                raise self._still_running()
            self._poll_waits.append(wait)
            await self._transport.sleep(wait)
            await self._poll(deadline)
        if self._error is not None:
            raise self._error
        assert self._manifest is not None
        return self._manifest

    def _finished(self) -> bool:
        return self._manifest is not None or self._error is not None

    def _next_wait(self) -> float:
        if (refused := self._refused_wait) is not None:
            self._refused_wait = None
            return refused
        if self._state is not None and self._state.retry_after is not None:
            return _poll_interval(self._state.retry_after)
        if self._header_wait is not None:
            return _poll_interval(self._header_wait)
        wait = poll_backoff(self._backoff_step)
        self._backoff_step += 1
        return wait

    def _still_running(self) -> DfoTimeoutError:
        options = {} if self._body is None else self._body.get("options", {})
        arguments = f'"{self.operation_id}"'
        if options.get("layout") == "frame":
            arguments += ', layout="frame"'
        if options.get("without_party_totals") is True:
            arguments += ", without_party_totals=True"
        return client_error(
            DEADLINE_EXCEEDED,
            f"The build is still running at the deadline. Resume it with "
            f"client.operation({arguments}).result()",
        )

    def _take(self, reply: Reply) -> None:
        self._state = reply.state if reply.state is not None else self._state
        self._header_wait = reply.retry_after
        self._trace_id = reply.trace_id
        state = reply.state
        if reply.manifest is not None or state is None:
            self._manifest = reply.manifest
            return
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
        elif state.progress is not None and self._on_progress is not None:
            self._on_progress(state.operation_id, state.progress, self._trace_id)

    async def _poll(self, deadline: float | None) -> None:
        operation_id = self.operation_id
        assert operation_id is not None
        try:
            response = await self._transport.request(
                "GET",
                f"/datasets/operations/{operation_id}",
                deadline=deadline,
                max_retries=0,
            )
        except DfoError as error:
            await self._poll_failed(error, deadline)
            return
        if response.status_code != 200:
            raise client_error(
                UNEXPECTED_RESPONSE,
                f"GET /datasets/operations/{operation_id} answered HTTP "
                f"{response.status_code}; a poll answers 200",
                status=response.status_code,
                trace_id=trace_id_of(response),
            )
        self._retries = 0
        self._take(_operation_reply(response))
        if self._error is not None:
            await self._failed(self._error, deadline)

    async def _poll_failed(self, error: DfoError, deadline: float | None) -> None:
        """Keep polling after a refused poll, or raise when that cannot help."""
        if error.code == _OPERATION_FAILED:
            await self._failed(error, deadline)
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

    async def _failed(self, error: DfoError, deadline: float | None) -> None:
        """Resubmit a build that failed retryably, once. Otherwise hold the error."""
        if not error.retryable or self._body is None or self._resubmissions:
            self._error = error
            return
        self._resubmissions += 1
        self._error = None
        self._take(await post_build(self._transport, self._body, deadline=deadline))


class AsyncOperation:
    """A long dataset build, running on the server or already done.

    `client.mint(spec)` returns one, and `client.operation("op_...")` resumes one
    from another process. `operation_id` is None for a build the server finished
    inline.
    """

    def __init__(
        self,
        poller: Poller,
        finish: Finish,
        *,
        renderer: ProgressRenderer | None = None,
    ) -> None:
        """Wrap a build's poller and the step that turns its manifest into data.

        Args:
            poller: Polls the build.
            finish: Turns the done build's manifest into the dataset.
            renderer: Shows the poller's progress. `result` ends its line.
        """
        self._poller = poller
        self._finish = finish
        self._renderer = renderer
        self._transport = poller.transport

    @property
    def operation_id(self) -> str | None:
        """The operation's id, or None for a build the server finished inline."""
        return self._poller.operation_id

    @property
    def progress(self) -> Progress | None:
        """The progress the server last reported, or None."""
        return self._poller.progress

    @property
    def status(self) -> str:
        """`pending`, `running`, `done` or `failed`, as last read."""
        return self._poller.status

    async def done(self) -> bool:
        """Whether the build has finished, polling once when it had not."""
        return await self._poller.done()

    async def result(self, timeout: float | None = 1800.0) -> Dataset:
        """Wait for the build and return its dataset.

        Args:
            timeout: The longest to wait, in seconds, polls and downloads
                included; None waits without limit. In the synchronous client,
                platform name resolution can run past this bound; the
                asynchronous client can cancel it.

        Raises:
            InvalidRequestError: `timeout` is not None or a finite number above
                0 (`invalid_argument`).
            DfoTimeoutError: The build was still running at the deadline. The
                message names the call that resumes it.
            DfoError: The build failed.
        """
        deadline = self._transport.deadline(timeout)
        try:
            manifest = await self._poller.wait(deadline)
        finally:
            if self._renderer is not None:
                self._renderer.close()
        return await self._finish(manifest, self._poller.trace_id, deadline)

    def __repr__(self) -> str:
        return f"<Operation {self.operation_id or 'inline'} {self.status}>"


async def resume(
    transport: AsyncTransport,
    operation_id: str,
    *,
    on_progress: ProgressHook | None = None,
) -> Poller:
    """Read a running build's operation by id, to poll it from this process.

    An operation that already reads `failed` holds its error, which the
    operation's `result` raises.

    Raises:
        InvalidRequestError: `operation_id` is not `op_` and 64 hex digits
            (`invalid_argument`); no request is sent.
        NotFoundError: The server holds no operation with that id.
    """
    if not matches(OPERATION_ID, operation_id):
        raise client_error(
            INVALID_ARGUMENT,
            f"{operation_id!r} is not an operation id, which is op_ and 64 "
            "lowercase hex digits, as Operation.operation_id gives",
        )
    response = await transport.request("GET", f"/datasets/operations/{operation_id}")
    return Poller(transport, _operation_reply(response), on_progress=on_progress)
