"""The errors and warnings a DFO client raises.

Each error class groups codes by what the caller does next. An error the client
raises itself goes through `client_error`, which takes one of the `ClientCode`
constants `dfo._core.codes` builds from the contract's `client-codes.json`, so the
code, its class and its retryable flag come from one row. A warning the client
issues itself goes through `client_warning`, which takes one of the `WarningCode`
constants built from `warning-codes.json`. `dfo._core.refusals` reads a server
refusal into its class. Every message and every error's `detail` drops the
characters that steer a terminal or reorder text, since both can quote the
server.
"""

import copy
import os
import sys
import warnings
from collections.abc import Hashable, Mapping
from dataclasses import dataclass
from typing import Any, override

from dfo._core.text import printable, single_line
from dfo._core.types import Gap
from dfo._generated.error_map import ClientErrorCode
from dfo._generated.wire import Alternative, ProblemIssue

# An error's code: one the client raises itself, or any refusal code a server
# sends, including one this client does not list.
type ErrorCode = ClientErrorCode | str

# Every warning skips the frames under the `dfo` package directory, so it names the
# caller's line.
_PACKAGE_PREFIX = os.path.dirname(os.path.dirname(__file__)) + os.sep


class DfoError(Exception):
    """The base of every error a DFO client raises.

    `str` and `repr` end the message with one bracket naming the code and the
    trace id, as in `No registry entry exists for code 'x'. [code_not_found ·
    trace 4f2a91c0]`, on a line of its own after a message of several lines.
    Either is left out when the error has none.

    Attributes:
        code: The refusal's code from the server, or the client's own code from
            the contract's `client-codes.json` for an error it raises itself.
        status: The HTTP status, or None when no response arrived.
        detail: The server's explanation of this occurrence, or None.
        trace_id: The request's trace id, to quote when reporting a fault.
        retryable: Whether the same call can succeed later.
        problem: The parsed problem document, or None.
        docs_url: The page that documents the code, or None.
        retry_after: The wait the response's `Retry-After` header asked for, in
            seconds, or None.
        pinned: The versions, `cv_…`, a pin call pinned before it failed, in
            the Dataset's member order. They stay pinned. Empty for every other
            call.
    """

    pinned: tuple[str, ...] = ()

    def __init__(
        self,
        message: str,
        /,
        *,
        code: ErrorCode | None = None,
        status: int | None = None,
        detail: str | None = None,
        trace_id: str | None = None,
        retryable: bool = False,
        problem: Mapping[str, Any] | None = None,
        docs_url: str | None = None,
        retry_after: float | None = None,
    ) -> None:
        super().__init__(printable(message))
        self.code: ErrorCode | None = code
        self.status = status
        self.detail: str | None = None if detail is None else printable(detail)
        self.trace_id = trace_id
        self.retryable = retryable
        self.problem = problem
        self.docs_url = docs_url
        self.retry_after = retry_after

    @override
    def __str__(self) -> str:
        labels = [self.code] if self.code else []
        if self.trace_id:
            labels.append(f"trace {self.trace_id}")
        return _with_suffix(message_of(self), labels)

    @override
    def __repr__(self) -> str:
        return f"{type(self).__name__}({str(self)!r})"


def message_of(error: BaseException, /) -> str:
    """The message without the bracket `str` adds."""
    return error.args[0] if error.args else ""


def _with_suffix(message: str, labels: list[str]) -> str:
    """`message` with the bracket of `labels` after it: on its last line, or on a
    line of its own when the message has several. Each label is shown on one line
    without control characters, since a code or trace id can be server text."""
    if not labels:
        return message
    shown = " · ".join(single_line(label) for label in labels)
    return f"{message}{'\n' if '\n' in message else ' '}[{shown}]"


class InvalidRequestError(DfoError):
    """The request is malformed. The caller fixes it.

    Attributes:
        issues: The problem document's `issues`, each naming a member of the
            request and what is wrong with it, such as the role a
            `role_incompatible` refusal could not bind. Empty when the server
            sent none.
        alternatives: The problem document's `alternatives`, the graph nodes the
            server offers in place of what the request named. Empty when the
            server sent none.
    """

    issues: tuple[ProblemIssue, ...] = ()
    alternatives: tuple[Alternative, ...] = ()


class NotFoundError(DfoError):
    """A spec, version, operation or other id is unknown. The caller checks it."""


class IncompleteAnswerError(DfoError):
    """A part of the question has no reading. The caller chooses or takes the rest.

    Attributes:
        answer: The answer whose fetch raised it, or None for a server refusal.
        gaps: The parts with no reading, each with its kind, message and options.
            Choose through `answer`, or fetch a candidate alone with
            `dfo.fetch(candidate.spec)`.
    """

    answer: Any = None
    gaps: tuple[Gap, ...] = ()


class DeclinedError(DfoError):
    """Search declined the question or answered with the catalogue."""


class VersionUnavailableError(DfoError):
    """A stored version cannot be rebuilt. The caller takes the newest version.

    Attributes:
        newest_version: The version a fresh build in the ref's rendering
            answered, or else the newest plain build of the spec the server
            lists, or None when it names none. A party-totals cut answers a
            version of its own, so this is not comparable with the
            `content_version` of a cut ref: two different versions need not
            mean newer data.
    """

    newest_version: str | None = None


class AuthenticationError(DfoError):
    """A key is missing, unknown, revoked or expired. The caller logs in."""


class PermissionDeniedError(DfoError):
    """The key lacks a scope. The caller asks for it."""


class RateLimitError(DfoError):
    """The caller is over the rate limit after the client's retries. It waits."""


class QuotaExceededError(DfoError):
    """The caller is over the build quota. It waits for the reset."""


class ServerError(DfoError):
    """The server failed after the client's retries. The caller reports the trace id."""


class ContractError(DfoError):
    """A field the client acts on is missing or renamed. The caller upgrades.

    Attributes:
        pointer: The JSON Pointer, into the response body, of the member the
            client found missing or null, or None when no one member is at fault.
    """

    pointer: str | None = None


class NetworkError(DfoError, ConnectionError):
    """The connection failed. The caller retries later."""


class DfoTimeoutError(DfoError, TimeoutError):
    """A deadline passed. The caller extends the timeout or resumes."""


class DfoWarning(UserWarning):
    """The base of every warning a DFO client issues.

    `str` ends the message with its code in brackets, as in `The materialised
    frame holds zero observations. [empty_result]`, on a line of its own after a
    message of several lines. The trace id stays out, so the `warnings` module
    shows one text once however many responses carry it.

    Attributes:
        code: The client's own code from the contract's `warning-codes.json`, or
            the server's code for a `DataWarning` or `SearchWarning`.
        trace_id: For a `DataWarning` or `SearchWarning`, the trace id of the
            response that carried it, to quote when reporting it. None for any
            other warning.
    """

    def __init__(
        self, message: str, /, *, code: str | None = None, trace_id: str | None = None
    ) -> None:
        super().__init__(printable(message))
        self.code = code
        self.trace_id = trace_id

    @override
    def __str__(self) -> str:
        return _with_suffix(message_of(self), [self.code] if self.code else [])

    @override
    def __repr__(self) -> str:
        return f"{type(self).__name__}({str(self)!r})"


class DataWarning(DfoWarning):
    """A warning the server attached to a dataset's manifest.

    Attributes:
        code: The warning code.
        severity: The server's severity for it.
    """

    def __init__(
        self, message: str, /, *, code: str, severity: str, trace_id: str | None = None
    ) -> None:
        super().__init__(message, code=code, trace_id=trace_id)
        self.severity = severity


class SearchWarning(DfoWarning):
    """A departure, skipped operation or default Search applied to an answer.

    Attributes:
        code: The warning or departure code, or None when the readings differ
            from the question in several ways.
    """


class SeriesLeftOutWarning(DfoWarning):
    """An operation behind a Dataset dropped series for missing data.

    Each fetch of a derived Dataset that left series out issues one, and
    `Dataset.left_out` lists them. `warnings.filterwarnings("error",
    category=SeriesLeftOutWarning)` turns it into a raise, as `strict=True` does.
    """


class DfoDeprecationWarning(DfoWarning, DeprecationWarning):
    """A call, or a route the server marked, that goes away in a later release."""


_STATUS_CLASSES: dict[int, type[DfoError]] = {
    401: AuthenticationError,
    403: PermissionDeniedError,
    404: NotFoundError,
    408: DfoTimeoutError,
    410: NotFoundError,
    429: RateLimitError,
}


def status_class(status: int | None) -> type[DfoError]:
    """Return the class a refusal maps to on its HTTP status alone."""
    if status is None:
        return DfoError
    if (cls := _STATUS_CLASSES.get(status)) is not None:
        return cls
    if status >= 500:
        return ServerError
    if status >= 400:
        return InvalidRequestError
    return DfoError


@dataclass(frozen=True, slots=True)
class ClientCode[E: DfoError]:
    """A code the client raises itself, with the class and flag its row names.

    Attributes:
        code: The code, as `client-codes.json` lists it.
        error_class: The class an error with this code is raised as.
        retryable: Whether an error with this code can succeed later.
    """

    code: str
    error_class: type[E]
    retryable: bool


@dataclass(frozen=True, slots=True)
class WarningCode[W: DfoWarning]:
    """A code the client issues a warning with, and the class its row names.

    Attributes:
        code: The code, as `warning-codes.json` lists it.
        warning_class: The class a warning with this code is issued as.
    """

    code: str
    warning_class: type[W]


def client_error[E: DfoError](
    code: ClientCode[E],
    message: str,
    /,
    *,
    status: int | None = None,
    detail: str | None = None,
    trace_id: str | None = None,
    docs_url: str | None = None,
    retry_after: float | None = None,
) -> E:
    """Build the error for a condition the client detects itself.

    Args:
        code: The contract row: the code, the class it raises and whether the
            same call can succeed later.
        message: What the caller reads.
        status: The HTTP status of the response the condition was found in.
        detail: The explanation of this occurrence.
        trace_id: The response's trace id.
        docs_url: The page that documents the condition.
        retry_after: The wait a response asked for, in seconds.
    """
    return code.error_class(
        message,
        code=code.code,
        status=status,
        detail=detail,
        trace_id=trace_id,
        retryable=code.retryable,
        docs_url=docs_url,
        retry_after=retry_after,
    )


def recast[E: DfoError](
    error: DfoError, cls: type[E], /, *, message: str | None = None, **overrides: Any
) -> E:
    """Copy `error` as a `cls`, keeping every `DfoError` field `overrides` leaves out.

    Args:
        error: The error to copy.
        cls: The class of the copy.
        message: The copy's message, or None to keep the error's own.
        overrides: `DfoError` fields the copy takes in place of the error's.
    """
    fields: dict[str, Any] = {
        "code": error.code,
        "status": error.status,
        "detail": error.detail,
        "trace_id": error.trace_id,
        "retryable": error.retryable,
        "problem": error.problem,
        "docs_url": error.docs_url,
        "retry_after": error.retry_after,
    }
    return cls(message_of(error) if message is None else message, **fields | overrides)


def with_hint[E: DfoError](error: E, /, *hints: str) -> E:
    """A copy of `error` whose message ends with `hints`, each a sentence.

    The copy keeps the class and every attribute, such as the code, the trace id,
    a `ContractError`'s pointer and an `InvalidRequestError`'s issues and
    alternatives.
    """
    hinted = copy.copy(error)
    hinted.args = (printable(f"{message_of(error).rstrip('. \n')}. {' '.join(hints)}"),)
    return hinted


def client_warning[W: DfoWarning](code: WarningCode[W], message: str, /) -> W:
    """Build the warning for a condition the client notices itself.

    Args:
        code: The contract row: the code and the class it issues.
        message: What the caller reads.
    """
    return code.warning_class(message, code=code.code)


# The hashes of the keys `warn_once` has seen, and the registry in which the
# `warnings` module records each warning text it has shown, which it would
# otherwise keep in the caller's module for good. At `_WARNED_MAX` entries each
# starts again, so a server that sends a new warning text with every response
# cannot grow either without bound. A warning seen before the restart can show
# once more.
_WARNED_MAX = 1024
_warned: set[int] = set()
_registry: dict[Any, Any] = {}


def warn(warning: Warning, /) -> None:
    """Issue `warning` against the first frame outside the client, recorded in
    the client's own bounded registry."""
    frame = sys._getframe(1)
    while frame.f_back is not None and frame.f_code.co_filename.startswith(
        _PACKAGE_PREFIX
    ):
        frame = frame.f_back
    if len(_registry) >= _WARNED_MAX:
        _registry.clear()
    warnings.warn_explicit(
        warning,
        type(warning),
        frame.f_code.co_filename,
        frame.f_lineno,
        module=frame.f_globals.get("__name__", "<string>"),
        registry=_registry,
    )


def warn_once(key: Hashable, warning: Warning, /) -> None:
    """Issue `warning` the first time this process sees `key`."""
    marker = hash(key)
    if marker in _warned:
        return
    if len(_warned) >= _WARNED_MAX:
        _warned.clear()
    _warned.add(marker)
    warn(warning)
