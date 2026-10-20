"""The errors and warnings a DFO client raises.

Each error class groups codes by what the caller does next. An error the client
raises itself goes through `client_error`, which takes one of the `ClientCode`
constants `dfo._error_map` generates from the contract's `client-codes.json`, so
the code and its class come from one row. `dfo._refusals` reads a server refusal
into its class.
"""

import os
import warnings
from collections.abc import Hashable, Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    # `dfo._types` raises through this module, so the import is for types only.
    from dfo._types import Gap

# Every warning skips the client's own frames, so it names the caller's line.
_PACKAGE_PREFIX = os.path.dirname(__file__) + os.sep


class DfoError(Exception):
    """The base of every error a DFO client raises.

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
    """

    def __init__(
        self,
        message: str,
        /,
        *,
        code: str | None = None,
        status: int | None = None,
        detail: str | None = None,
        trace_id: str | None = None,
        retryable: bool = False,
        problem: Mapping[str, Any] | None = None,
        docs_url: str | None = None,
        retry_after: float | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.detail = detail
        self.trace_id = trace_id
        self.retryable = retryable
        self.problem = problem
        self.docs_url = docs_url
        self.retry_after = retry_after


class InvalidRequestError(DfoError):
    """The request is malformed; the caller fixes it."""


class NotFoundError(DfoError):
    """A spec, version, operation or other id is unknown; the caller checks it."""


class IncompleteAnswerError(DfoError):
    """A part of the question has no reading; the caller chooses or takes the rest.

    Attributes:
        answer: The answer whose fetch raised it, or None for a server refusal.
        gaps: The parts with no reading, each with its kind, message and options.
    """

    answer: Any = None
    gaps: "tuple[Gap, ...]" = ()


class DeclinedError(DfoError):
    """Search declined the question or answered with the catalogue."""


class VersionUnavailableError(DfoError):
    """A stored version cannot be rebuilt; the caller takes the newest version.

    Attributes:
        newest_version: The newest version of the spec the server holds, or None
            when it names none.
    """

    newest_version: str | None = None


class AuthenticationError(DfoError):
    """A key is missing, unknown, revoked or expired; the caller logs in."""


class PermissionDeniedError(DfoError):
    """The key lacks a scope; the caller asks for it."""


class RateLimitError(DfoError):
    """The caller is over the rate limit after the client's retries; it waits."""


class QuotaExceededError(DfoError):
    """The caller is over the build quota; it waits for the reset."""


class ServerError(DfoError):
    """The server failed after the client's retries; the caller reports the trace id."""


class ContractError(DfoError):
    """A field the client acts on is missing or renamed; the caller upgrades.

    Attributes:
        pointer: The JSON Pointer, into the response body, of the member the
            client found missing or null, or None when no one member is at fault.
    """

    pointer: str | None = None


class NetworkError(DfoError, ConnectionError):
    """The connection failed; the caller retries later."""


class DfoTimeoutError(DfoError, TimeoutError):
    """A deadline passed; the caller extends the timeout or resumes."""


class DfoWarning(UserWarning):
    """The base of every warning a DFO client issues."""


class DataWarning(DfoWarning):
    """A warning the server attached to a dataset's manifest.

    Attributes:
        code: The warning code.
        severity: The server's severity for it.
    """

    def __init__(self, message: str, /, *, code: str, severity: str) -> None:
        super().__init__(message)
        self.code = code
        self.severity = severity


class SearchWarning(DfoWarning):
    """A departure, skipped operation or default Search applied to an answer.

    Attributes:
        code: The warning or departure code, or None.
    """

    def __init__(self, message: str, /, *, code: str | None = None) -> None:
        super().__init__(message)
        self.code = code


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
    """A code the client raises itself, with the error class its contract row names.

    Attributes:
        code: The code, as `client-codes.json` lists it.
        error_class: The class an error with this code is raised as.
    """

    code: str
    error_class: type[E]


def client_error[E: DfoError](
    code: ClientCode[E],
    message: str,
    /,
    *,
    status: int | None = None,
    detail: str | None = None,
    trace_id: str | None = None,
    retryable: bool = False,
    docs_url: str | None = None,
    retry_after: float | None = None,
) -> E:
    """Build the error for a condition the client detects itself.

    Args:
        code: The contract row: the code and the class it raises.
        message: What the caller reads.
        status: The HTTP status of the response the condition was found in.
        detail: The explanation of this occurrence.
        trace_id: The response's trace id.
        retryable: Whether the same call can succeed later.
        docs_url: The page that documents the condition.
        retry_after: The wait a response asked for, in seconds.
    """
    return code.error_class(
        message,
        code=code.code,
        status=status,
        detail=detail,
        trace_id=trace_id,
        retryable=retryable,
        docs_url=docs_url,
        retry_after=retry_after,
    )


_warned: set[Hashable] = set()


def warn(warning: Warning, /) -> None:
    """Issue `warning` against the first frame outside the client."""
    warnings.warn(warning, skip_file_prefixes=(_PACKAGE_PREFIX,))


def warn_once(key: Hashable, warning: Warning, /) -> None:
    """Issue `warning` the first time this process sees `key`."""
    if key in _warned:
        return
    _warned.add(key)
    warn(warning)
