"""How a server refusal maps to its error class, and the trace id an error carries.

A code maps through `dfo._generated.error_map.ACTIONS`, generated from the contract's
`actions.json`. A code the website proxy answers itself maps on the status
`proxy-codes.json` gives it, and any other code maps on its HTTP status. A refusal
whose body carries no code, or a code that is not lower-case snake case, takes
`refusal_without_code`, with the class of its status, and a trace id the body
lacks comes from the response's `x-dfo-trace-id` header. The stored problem
document, like the message and detail, has the client's key replaced by
`[redacted]`.

An error the client raises itself on reading a response, `unexpected_response`,
`contract_violation`, or a `DataWarning` or `SearchWarning`, carries that
response's trace id, read the same way: the body's `trace_id`, else the header.
`answer_declined` and `answer_incomplete` carry the trace id of the Search
response that gave the answer. Any other client error describes the caller's
input or a storage-host fetch and carries none.
"""

import re
from collections.abc import Generator, Mapping
from contextlib import contextmanager
from copy import copy
from typing import Any, assert_never
from urllib.parse import urljoin

import httpx2

from dfo._core.codes import CONTRACT_VIOLATION, UNEXPECTED_RESPONSE
from dfo._core.errors import (
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
    recast,
    status_class,
)
from dfo._core.json_text import loads
from dfo._core.text import origin_of, printable, redacted
from dfo._generated.error_map import (
    ACTIONS,
    PROXY_STATUSES,
    REFUSAL_WITHOUT_CODE,
    Action,
)

TRACE_HEADER = "x-dfo-trace-id"

# The media types a response's body is read as JSON under when it is not one the
# client asked for. They cover a refusal's problem document and the website
# proxy's body.
_JSON_TYPES = frozenset({"application/problem+json", "application/json"})

# The client codes of errors that describe a response the client read.
_RESPONSE_CODES = frozenset({UNEXPECTED_RESPONSE.code, CONTRACT_VIOLATION.code})

# A code, a refusal's or a registry's, is lower-case snake case. Other text in a
# refusal code's place is no code.
CODE = re.compile(r"[a-z][a-z0-9_]*")

# Statuses worth another attempt when the body does not say `retryable`.
_RETRYABLE_STATUSES = frozenset({408, 429, 500, 502, 503, 504})

# The website proxy's `retry` value for a refusal that clears on its own.
_PROXY_RETRY = "retry_after_delay"

# The codes of a 404 that matched no route, the API's own and a body without one.
_NO_ROUTE = frozenset({"not_found", REFUSAL_WITHOUT_CODE})

# The code of a refusal of the request's method. The contract maps it to
# "upgrade", which holds for a route the client wraps. On a raw request the
# caller chose the method.
_METHOD_NOT_ALLOWED = "method_not_allowed"


def error_class(code: str | None, status: int | None) -> type[DfoError]:
    """Return the class for a refusal, from its code's action, else from the status
    the website proxy answers its code with, else from `status`."""
    if code is not None and (action := ACTIONS.get(code)) is not None:
        return _class_for_action(action)
    if code is not None and (proxy_status := PROXY_STATUSES.get(code)) is not None:
        return status_class(proxy_status)
    return status_class(status)


def maps_to_class(code: str) -> bool:
    """Whether the contract maps `code` to a class whatever the status, because it
    has an action or the website proxy answers it with a fixed status."""
    return code in ACTIONS or code in PROXY_STATUSES


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


def _code_and_detail(
    value: object, detail: str | None
) -> tuple[str | None, str | None]:
    """A body's code, when `value` is lower-case snake case, and its detail.

    Other text in the code's place is no code. It opens the detail instead, so
    the caller still reads it.
    """
    text = _text(value)
    if text is None or CODE.fullmatch(text):
        return text, detail
    return None, text if detail is None else f"{text}: {detail}"


def _redacted_body(body: Mapping[str, Any], key: str) -> dict[str, Any]:
    """A copy of `body` with `key` replaced by `[redacted]` in every string
    value, at any depth."""
    top = dict(body)
    pending: list[dict[Any, Any] | list[Any]] = [top]
    while pending:
        container = pending.pop()
        slots: list[tuple[Any, Any]] = (
            list(container.items())
            if isinstance(container, dict)
            else list(enumerate(container))
        )
        for slot, value in slots:
            if isinstance(value, str):
                container[slot] = redacted(value, key)
            elif isinstance(value, dict | list):
                container[slot] = inner = copy(value)
                pending.append(inner)
    return top


def _docs_url(origin: str, type_: str) -> str | None:
    """The page a problem document's `type` names, resolved against the API's
    origin, or None unless it is an https URL on that origin with no control
    character."""
    try:
        url = urljoin(origin + "/", type_)
    except ValueError:
        return None
    if not origin.startswith("https://") or origin_of(url) != origin:
        return None
    return url if printable(url) == url else None


def _at_pointer(message: str, pointer: str | None) -> str:
    """`message` naming the field a problem document's `pointer` names, unless
    the pointer is empty or the message names it already."""
    if pointer is None or pointer in message:
        return message
    return f"{message.rstrip('.')} at {pointer}"


def json_body(response: httpx2.Response) -> object:
    """A response's body as JSON when its media type is a JSON one, else None."""
    media_type = response.headers.get("content-type", "").split(";")[0].strip()
    if not response.content or media_type.lower() not in _JSON_TYPES:
        return None
    try:
        return loads(response.content)
    except ValueError:  # not JSON, or nested past JSON_MAX_DEPTH
        return None


def trace_id_of(response: httpx2.Response, body: object = None) -> str | None:
    """A response's trace id, from the body's `trace_id`, else the `x-dfo-trace-id`
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
    route: str | None = None,
    key: str | None = None,
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
        route: The method and URL refused. A 404 that matched no route names
            it and points at `base_url`, the likely fault.
        key: The client's key, replaced by `[redacted]` wherever the server's
            text quotes it.

    Returns:
        The error, of the class the code or else the status maps to. A problem
        document's `retryable` outranks the status, and its `pointer` is named
        in the message. The website proxy's `{error, retry, detail}` body maps
        `error` as the code, and its `retry`, when present, outranks the
        status. A body with neither code, or with text that is not lower-case
        snake case in the code's place, takes `fallback_code`, else
        `refusal_without_code`; such text opens the detail. An
        `InvalidRequestError` carries the problem document's `issues` and
        `alternatives`.
    """
    problem = body if isinstance(body, dict) else None
    if problem is not None and key:
        problem = _redacted_body(problem, key)
    code = detail = page = pointer = None
    retryable = status in _RETRYABLE_STATUSES
    if problem is not None and "code" not in problem and "error" in problem:
        code, detail = _code_and_detail(
            problem.get("error"), _text(problem.get("detail"))
        )
        if "retry" in problem:
            retryable = problem.get("retry") == _PROXY_RETRY
    elif problem is not None:
        code, detail = _code_and_detail(
            problem.get("code"),
            _text(problem.get("detail")) or _text(problem.get("title")),
        )
        pointer = _text(problem.get("pointer"))
        trace_id = _text(problem.get("trace_id")) or trace_id
        if isinstance(flag := problem.get("retryable"), bool):
            retryable = flag
        if type_ := _text(problem.get("type")):
            page = _docs_url(origin, type_)
    if detail is not None:
        detail = redacted(detail, key)
    message = _at_pointer(detail or reason or f"HTTP {status}", pointer)
    code = code or fallback_code
    if (
        route is not None
        and status == 404
        and (code or REFUSAL_WITHOUT_CODE) in _NO_ROUTE
    ):
        message = f"{message.rstrip('.')}. {route} matched no route; check base_url"
    if code is not None:
        message = f"{message} ({code})"
    message = redacted(message, key)
    error = error_class(code, status)(
        message,
        code=code or REFUSAL_WITHOUT_CODE,
        status=status,
        detail=detail,
        trace_id=trace_id,
        retryable=retryable,
        problem=problem,
        docs_url=page,
        retry_after=retry_after,
    )
    if isinstance(error, InvalidRequestError) and problem is not None:
        error.issues = tuple(_objects(problem.get("issues")))
        error.alternatives = tuple(
            entry
            for entry in _objects(problem.get("alternatives"))
            if isinstance(entry.get("ref"), str) and isinstance(entry.get("label"), str)
        )
    return error


def _objects(value: object) -> list[Any]:
    """The entries of `value` that are JSON objects, when it is a list."""
    return (
        [entry for entry in value if isinstance(entry, dict)]
        if isinstance(value, list)
        else []
    )


def caller_refusal(error: DfoError) -> DfoError:
    """The error a raw request raises for `error`. A refused method is the caller's
    to fix and becomes an `InvalidRequestError`. Any other error stays as it is."""
    if error.code != _METHOD_NOT_ALLOWED or isinstance(error, InvalidRequestError):
        return error
    return recast(error, InvalidRequestError)
