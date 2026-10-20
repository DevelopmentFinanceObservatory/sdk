"""The errors and warnings a DFO client raises, and how a refusal maps to its class.

Each error class groups the refusal codes by what the caller does next. A code
maps through `dfo._error_map`, generated from the contract's `actions.json`; a
code the map lacks maps on its HTTP status.
"""

import os
import warnings
from collections.abc import Hashable, Mapping
from typing import Any, assert_never
from urllib.parse import urljoin

from dfo._error_map import ACTIONS, Action

# Every warning skips the client's own frames, so it names the caller's line.
_PACKAGE_PREFIX = os.path.dirname(__file__) + os.sep

# Statuses worth another attempt when the body does not say `retryable`.
_RETRYABLE_STATUSES = frozenset({408, 429, 500, 502, 503, 504})

# The website proxy's `retry` value for a refusal that clears on its own.
_PROXY_RETRY = "retry_after_delay"


class DfoError(Exception):
    """The base of every error a DFO client raises.

    Attributes:
        code: The refusal code from the problem document, or None.
        status: The HTTP status, or None when no response arrived.
        detail: The server's explanation of this occurrence, or None.
        trace_id: The request's trace id, to quote when reporting a fault.
        retryable: Whether the same call can succeed later.
        problem: The parsed problem document, or None.
        docs_url: The page that documents the code, or None.
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
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.detail = detail
        self.trace_id = trace_id
        self.retryable = retryable
        self.problem = problem
        self.docs_url = docs_url


class InvalidRequestError(DfoError):
    """The request is malformed; the caller fixes it."""


class NotFoundError(DfoError):
    """A spec, version, operation or other id is unknown; the caller checks it."""


class IncompleteAnswerError(DfoError):
    """A part of the question has no reading; the caller chooses or takes the rest."""


class DeclinedError(DfoError):
    """Search declined the question or answered with the catalogue."""


class VersionUnavailableError(DfoError):
    """A stored version cannot be rebuilt; the caller takes the newest version."""


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
    """A field the client acts on is missing or renamed; the caller upgrades."""


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
    429: RateLimitError,
}


def error_class(code: str | None, status: int | None) -> type[DfoError]:
    """Return the class for a refusal: on its code when known, else on its status."""
    if code is not None and (action := ACTIONS.get(code)) is not None:
        return _class_for_action(action)
    return _class_for_status(status)


# One return per action keeps the match exhaustive, so ty fails on a new action.
def _class_for_action(action: Action) -> type[DfoError]:  # noqa: PLR0911
    match action:
        case "fix_request":
            return InvalidRequestError
        case "check_id":
            return NotFoundError
        case "choose" | "ask_data_question":
            return IncompleteAnswerError
        case "take_newest_version":
            return VersionUnavailableError
        case "log_in":
            return AuthenticationError
        case "request_scope":
            return PermissionDeniedError
        case "wait":
            return RateLimitError
        case "wait_for_reset":
            return QuotaExceededError
        case "report":
            return ServerError
        case "upgrade":
            return ContractError
        case _:
            assert_never(action)


def _class_for_status(status: int | None) -> type[DfoError]:
    if status is None:
        return DfoError
    if (cls := _STATUS_CLASSES.get(status)) is not None:
        return cls
    if status >= 500:
        return ServerError
    if status >= 400:
        return InvalidRequestError
    return DfoError


def _text(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def problem_error(status: int, body: object, *, reason: str, origin: str) -> DfoError:
    """Build the error for a refused response.

    Args:
        status: The response's HTTP status.
        body: The parsed JSON body, or None when the body is not JSON.
        reason: The HTTP reason phrase, the message when the body gives none.
        origin: The API's origin, which a root-relative `type` resolves against.

    Returns:
        The error, of the class the code or else the status maps to. A problem
        document's `retryable` outranks the status; the website proxy's
        `{error, retry, detail}` body maps `error` as the code.
    """
    problem = body if isinstance(body, dict) else None
    code = detail = trace_id = docs_url = None
    retryable = status in _RETRYABLE_STATUSES
    if problem is not None and "code" not in problem and "error" in problem:
        code = _text(problem.get("error"))
        detail = _text(problem.get("detail"))
        retryable = problem.get("retry") == _PROXY_RETRY
    elif problem is not None:
        code = _text(problem.get("code"))
        detail = _text(problem.get("detail")) or _text(problem.get("title"))
        trace_id = _text(problem.get("trace_id"))
        if isinstance(flag := problem.get("retryable"), bool):
            retryable = flag
        if type_ := _text(problem.get("type")):
            docs_url = urljoin(origin + "/", type_)
    message = detail or reason or f"HTTP {status}"
    if code is not None:
        message = f"{message} ({code})"
    return error_class(code, status)(
        message,
        code=code,
        status=status,
        detail=detail,
        trace_id=trace_id,
        retryable=retryable,
        problem=problem,
        docs_url=docs_url,
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
