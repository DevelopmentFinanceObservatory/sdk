"""How a server refusal maps to its error class, and the trace id an error carries.

A code maps through `dfo._error_map.ACTIONS`, generated from the contract's
`actions.json`; a code the map lacks maps on its HTTP status. A refusal whose body
carries no code takes `refusal_without_code`, with the class of its status, and a
trace id the body lacks comes from the response's `x-dfo-trace-id` header.

An error the client raises itself on reading a response, `unexpected_response`,
`contract_violation`, or a `DataWarning` or `SearchWarning`, carries that
response's trace id, read the same way: the body's `trace_id`, else the header.
`answer_declined` and `answer_incomplete` carry the trace id of the Search
response that gave the answer. Any other client error describes the caller's
input or a storage-host fetch and carries none.
"""

from collections.abc import Generator
from contextlib import contextmanager
from typing import assert_never
from urllib.parse import urljoin

import httpx2

from dfo._error_map import (
    ACTIONS,
    CONTRACT_VIOLATION,
    REFUSAL_WITHOUT_CODE,
    UNEXPECTED_RESPONSE,
    Action,
)
from dfo._errors import (
    AuthenticationError,
    ContractError,
    DfoError,
    IncompleteAnswerError,
    InvalidRequestError,
    NotFoundError,
    PermissionDeniedError,
    QuotaExceededError,
    RateLimitError,
    ServerError,
    VersionUnavailableError,
    status_class,
)

TRACE_HEADER = "x-dfo-trace-id"

# The media types a response's body is read as JSON under when it is not one the
# client asked for: a refusal's problem document, or the website proxy's body.
_JSON_TYPES = frozenset({"application/problem+json", "application/json"})

# The client codes of errors that describe a response the client read.
_RESPONSE_CODES = frozenset({UNEXPECTED_RESPONSE.code, CONTRACT_VIOLATION.code})

# Statuses worth another attempt when the body does not say `retryable`.
_RETRYABLE_STATUSES = frozenset({408, 429, 500, 502, 503, 504})

# The website proxy's `retry` value for a refusal that clears on its own.
_PROXY_RETRY = "retry_after_delay"


def error_class(code: str | None, status: int | None) -> type[DfoError]:
    """Return the class for a refusal: on its code when known, else on its status."""
    if code is not None and (action := ACTIONS.get(code)) is not None:
        return _class_for_action(action)
    return status_class(status)


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


def _text(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def json_body(response: httpx2.Response) -> object:
    """A response's body as JSON when its media type is a JSON one, else None."""
    media_type = response.headers.get("content-type", "").split(";")[0].strip()
    if not response.content or media_type.lower() not in _JSON_TYPES:
        return None
    try:
        return response.json()
    except ValueError:
        return None


def trace_id_of(response: httpx2.Response, body: object = None) -> str | None:
    """A response's trace id: the body's `trace_id`, else the `x-dfo-trace-id`
    header, else None.

    Args:
        response: The response.
        body: Its decoded body, when the caller has decoded it; None reads the
            body as `json_body` does.
    """
    if body is None:
        body = json_body(response)
    found = body.get("trace_id") if isinstance(body, dict) else None
    return _text(found) or _text(response.headers.get(TRACE_HEADER))


@contextmanager
def describing(trace_id: str | None) -> Generator[None]:
    """Give `trace_id` to an error raised inside that describes the response
    it names, unless the error carries a trace id already.

    A `DataWarning` or `SearchWarning` is built with its response's trace id, so
    it passes through untouched.
    """
    try:
        yield
    except DfoError as error:
        if error.trace_id is None and error.code in _RESPONSE_CODES:
            error.trace_id = trace_id
        raise


def problem_error(
    status: int,
    body: object,
    *,
    reason: str,
    origin: str,
    retry_after: float | None = None,
    trace_id: str | None = None,
    fallback_code: str | None = None,
) -> DfoError:
    """Build the error for a refused response.

    Args:
        status: The response's HTTP status.
        body: The parsed JSON body, or None when the body is not JSON.
        reason: The HTTP reason phrase, the message when the body gives none.
        origin: The API's origin, which a root-relative `type` resolves against.
        retry_after: The wait the response's `Retry-After` header asked for.
        trace_id: The response's `x-dfo-trace-id` header, used when the body
            carries no trace id.
        fallback_code: The code of a body that carries none, such as a failed
            operation's; None takes `refusal_without_code`.

    Returns:
        The error, of the class the code or else the status maps to. A problem
        document's `retryable` outranks the status; the website proxy's
        `{error, retry, detail}` body maps `error` as the code. A body with
        neither code takes `fallback_code`, else `refusal_without_code`.
    """
    problem = body if isinstance(body, dict) else None
    code = detail = docs_url = None
    retryable = status in _RETRYABLE_STATUSES
    if problem is not None and "code" not in problem and "error" in problem:
        code = _text(problem.get("error"))
        detail = _text(problem.get("detail"))
        retryable = problem.get("retry") == _PROXY_RETRY
    elif problem is not None:
        code = _text(problem.get("code"))
        detail = _text(problem.get("detail")) or _text(problem.get("title"))
        trace_id = _text(problem.get("trace_id")) or trace_id
        if isinstance(flag := problem.get("retryable"), bool):
            retryable = flag
        if type_ := _text(problem.get("type")):
            docs_url = urljoin(origin + "/", type_)
    message = detail or reason or f"HTTP {status}"
    code = code or fallback_code
    if code is not None:
        message = f"{message} ({code})"
    return error_class(code, status)(
        message,
        code=code or REFUSAL_WITHOUT_CODE,
        status=status,
        detail=detail,
        trace_id=trace_id,
        retryable=retryable,
        problem=problem,
        docs_url=docs_url,
        retry_after=retry_after,
    )
