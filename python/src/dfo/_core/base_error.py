"""The base of every error a DFO client raises, and the bracket its message ends with.

`dfo._core.errors` holds the classes that derive from it. The base lives apart so
that `dfo._core.types`, whose `FormatError` derives from it, need not import the
module that types `IncompleteAnswerError.gaps` with its `Gap`.
"""

from collections.abc import Mapping
from typing import Any, override

from dfo._core.text import printable, single_line
from dfo._generated.error_map import ClientErrorCode

# An error's code is one the client raises itself, or any refusal code a server
# sends, including one this client does not list.
type ErrorCode = ClientErrorCode | str


class DfoError(Exception):
    """The base of every error a DFO client raises.

    `str` and `repr` end the message with one bracket naming the code and the
    trace id, as in `No registry entry exists for code 'x'. [code_not_found
    trace=4f2a91c0]`, on a line of its own after a message of several lines.
    Either is left out when the error has none. The bracket text may change
    between releases, so read `code` and `trace_id` instead of parsing it.

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
            labels.append(f"trace={self.trace_id}")
        return with_suffix(message_of(self), labels)

    @override
    def __repr__(self) -> str:
        return f"{type(self).__name__}({str(self)!r})"


def message_of(error: BaseException, /) -> str:
    """The message without the bracket `str` adds."""
    return error.args[0] if error.args else ""


def with_suffix(message: str, labels: list[str]) -> str:
    """`message` with the bracket of `labels` after it: on its last line, or on a
    line of its own when the message has several. Each label is shown on one line
    without control characters, since a code or trace id can be server text."""
    if not labels:
        return message
    shown = " ".join(single_line(label) for label in labels)
    return f"{message}{'\n' if '\n' in message else ' '}[{shown}]"
