"""How a server refusal maps to its error class, and the trace id an error carries.

A refusal's body is read as a problem document when it parses as a JSON object,
whatever its media type, as a success body is. A code maps through
`dfo._generated.error_map.ACTIONS`, generated from the contract's `actions.json`.
A code the website proxy answers itself maps on the status `proxy-codes.json`
gives it, and any other code maps on its HTTP status. A refusal whose body
carries no code, or a code that is not lower-case snake case of at most
`CODE_MAX_LENGTH` characters, takes `refusal_without_code`, with the class of its
status. Its message and detail read `HTTP <status> with no refusal code: <text>`,
where the text is the body's string `detail`, else `title`, else the `error`
member older servers sent, else the text in the code's place, or `HTTP <status>
with no refusal code.` when the body has none of them. A message quotes at most
`MESSAGE_TEXT_MAX` characters of the server's text, and the error's `detail`
keeps it whole. A trace id is an HTTP token. One the body lacks comes from the
response's `x-dfo-trace-id` header, and one with any other character, or holding
the key the request carried, is dropped. The stored problem document (its member
names included), the message and the detail have the client's key replaced by
`[redacted]`, a copy with characters inside it that `printable` drops included.
Every JSON body the client reads, success or refusal, has the key its request
carried redacted the same way before any member reaches an error, a warning or
a dataset.

An error the client raises itself on reading a response, `unexpected_response`,
`contract_violation`, or a `DataWarning` or `SearchWarning`, carries that
response's trace id, read the same way: the body's `trace_id`, else the header.
`answer_declined` and `answer_incomplete` carry the trace id of the Search
response that gave the answer. Any other client error describes the caller's
input or a storage-host fetch and carries none.
"""

import re
from collections.abc import Generator
from contextlib import contextmanager
from typing import Any, assert_never

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
from dfo._core.text import (
    capped,
    is_token,
    redacted,
    redacted_json,
    same_origin_url,
)
from dfo._generated.error_map import (
    ACTIONS,
    PROXY_STATUSES,
    REFUSAL_WITHOUT_CODE,
    Action,
)

TRACE_HEADER = "x-dfo-trace-id"

# The client codes of errors that describe a response the client read.
_RESPONSE_CODES = frozenset({UNEXPECTED_RESPONSE.code, CONTRACT_VIOLATION.code})

# A code, a refusal's or a registry's, is lower-case snake case of at most
# `CODE_MAX_LENGTH` characters. Other text in a refusal code's place is no code.
# The longest code the contract names, `directional_children_unsupported`, has 32
# characters, so 64 leaves it twice that.
CODE_MAX_LENGTH = 64
CODE = re.compile(rf"[a-z][a-z0-9_]{{0,{CODE_MAX_LENGTH - 1}}}")

# Statuses worth another attempt when the body does not say `retryable`.
_RETRYABLE_STATUSES = frozenset({408, 429, 500, 502, 503, 504})

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
        case "request_scope" | "stop":
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


def _token(value: object) -> str | None:
    """`value` when it is a string that is an HTTP token, the shape of a trace id."""
    return value if isinstance(value, str) and is_token(value) else None


def _at_pointer(message: str, pointer: str | None) -> str:
    """`message` naming the field a problem document's `pointer` names, unless
    the pointer is empty or the message names it already."""
    if pointer is None or pointer in message:
        return message
    return f"{message.rstrip('.')} at {pointer}"


def json_body(response: httpx2.Response) -> object:
    """A response's body as JSON, whatever its media type, with the key its
    request carried redacted as `redacted_json` does, or None when it is not
    JSON."""
    if not response.content:
        return None
    try:
        body = loads(response.content)
    except ValueError:  # not UTF-8 JSON, or nested past JSON_MAX_DEPTH
        return None
    return redacted_json(body, sent_key(response))


def sent_key(response: httpx2.Response) -> str | None:
    """The bearer credential the response's request carried, or None."""
    authorization = response.request.headers.get("authorization", "")
    scheme, _, credential = authorization.partition(" ")
    return credential if scheme.lower() == "bearer" and credential else None


def _trace_token(value: object, response: httpx2.Response) -> str | None:
    """`value` when it is a trace id that does not hold the key `response`'s
    request carried."""
    if (token := _token(value)) is None:
        return None
    key = sent_key(response)
    return None if key and key in token else token


def trace_header(response: httpx2.Response) -> str | None:
    """A response's `x-dfo-trace-id` header, or None when it is absent, not an
    HTTP token, or holds the key the request carried."""
    return _trace_token(response.headers.get(TRACE_HEADER), response)


def trace_id_of(response: httpx2.Response, body: object = None) -> str | None:
    """A response's trace id, from the body's `trace_id`, else the `x-dfo-trace-id`
    header, else None. A trace id that is not an HTTP token, or that holds the
    key the request carried, counts as none.

    Args:
        response: The response.
        body: Its decoded body, when the caller has decoded it; None reads the
            body as `json_body` does.
    """
    if body is None:
        body = json_body(response)
    found = body.get("trace_id") if isinstance(body, dict) else None
    return _trace_token(found, response) or trace_header(response)


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
        reason: The HTTP reason phrase, the message of a refusal with a code
            whose body gives no text.
        origin: The API's origin, which a root-relative `type` resolves against.
        retry_after: The wait the response's `Retry-After` header asked for.
        trace_id: The response's trace id header, as `trace_header` reads it,
            used when the body carries no trace id.
        fallback_code: The code of a body that carries none, such as a failed
            operation's; None takes `refusal_without_code`.
        route: The method and URL refused. A 404 whose body carries no code
            matched no route; the message names it and points at `base_url`,
            the likely fault. A 404 with a code answered from a route.
        key: The client's key, replaced by `[redacted]` wherever the server's
            text quotes it.

    Returns:
        The error, of the class the code or else the status maps to. A problem
        document's `retryable` outranks the status, except for a code whose
        action is `wait_for_reset`, which is never retryable, and its `pointer`
        is named in the message. The website proxy answers its own refusals with
        problem documents too. The body's text is its string `detail`, else
        `title`, else `error`. A body without a code, or with text that is not
        a code in the code's place, takes `fallback_code`, else
        `refusal_without_code`, whose detail reads `HTTP <status> with no
        refusal code: <text>`, the text falling back to what sat in the code's
        place. The message quotes at most `MESSAGE_TEXT_MAX` characters of the
        text. An `InvalidRequestError` carries the problem document's `issues`
        and `alternatives`.
    """
    problem = body if isinstance(body, dict) else None
    if problem is not None and key:
        problem = redacted_json(problem, key)
    code = text = page = pointer = None
    retryable = status in _RETRYABLE_STATUSES
    if problem is not None:
        code = _text(problem.get("code"))
        text = (
            _text(problem.get("detail"))
            or _text(problem.get("title"))
            or _text(problem.get("error"))
        )
        if code is not None and not CODE.fullmatch(code):
            text = text or code
            code = None
        pointer = _text(problem.get("pointer"))
        trace_id = _token(problem.get("trace_id")) or trace_id
        if isinstance(flag := problem.get("retryable"), bool):
            retryable = flag
        if type_ := _text(problem.get("type")):
            page = same_origin_url(type_, origin)
    if text is not None:
        text = redacted(text, key)
    code = code or fallback_code
    if ACTIONS.get(code or "") == "wait_for_reset":
        # The allowance resets on its own schedule; a retry only spends it.
        retryable = False
    if code is None:
        lead = f"HTTP {status} with no refusal code"
        detail = f"{lead}: {text}" if text else f"{lead}."
        shown = f"{lead}: {capped(text)}" if text else f"{lead}."
    else:
        detail = text
        # The key goes before the cut, which could otherwise leave part of it.
        shown = capped(redacted(text or reason or f"HTTP {status}", key))
    message = _at_pointer(shown, pointer and capped(pointer))
    if route is not None and status == 404 and code in (None, REFUSAL_WITHOUT_CODE):
        message = f"{message.rstrip('.')}. {route} matched no route; check base_url"
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
