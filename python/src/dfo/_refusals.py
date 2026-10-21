"""How a server refusal maps to its error class.

A code maps through `dfo._error_map.ACTIONS`, generated from the contract's
`actions.json`; a code the map lacks maps on its HTTP status. A refusal whose body
carries no code takes `refusal_without_code`, with the class of its status, and a
trace id the body lacks comes from the response's `x-dfo-trace-id` header.
"""

from typing import assert_never
from urllib.parse import urljoin

from dfo._error_map import ACTIONS, REFUSAL_WITHOUT_CODE, Action
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
