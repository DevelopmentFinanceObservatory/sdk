"""The value a call's `timeout` takes when the caller leaves it out.

A client's `timeout` bounds each whole call, retries, waits and downloads
included, unless the call passes its own. A call's own `timeout` overrides it,
and None there means no bound. A client built with `timeout=None` leaves each
call its own default: `search` waits `SEARCH_TIMEOUT`, and `fetch` and the
analysis calls wait as long as the server takes.

`AsyncTransport.call_timeout` returns a client's bound as `ClientSeconds`, so a
message about it names the client's `timeout`.
"""

from enum import Enum
from typing import Final, Literal, override


class ClientTimeout(Enum):
    """The type of `CLIENT_TIMEOUT`, a call's `timeout` left out."""

    CLIENT_TIMEOUT = "client timeout"

    @override
    def __repr__(self) -> str:
        return "CLIENT_TIMEOUT"


CLIENT_TIMEOUT: Final = ClientTimeout.CLIENT_TIMEOUT
"""A call's `timeout` left out: the client's `timeout` bounds the call, else the
call's own default."""

type CallTimeout = float | Literal[ClientTimeout.CLIENT_TIMEOUT] | None
"""A call's `timeout`: seconds, None for no bound, or `CLIENT_TIMEOUT`."""


class ClientSeconds(float):
    """A call's bound in seconds that came from the client's `timeout`."""


def ran_out(timeout: float | None) -> str:
    """` after 25 s, the call's timeout` for a call's 25-second timeout, with
    `the client's timeout` for a client's, or nothing when it is unknown."""
    if timeout is None:
        return ""
    whose = "client's" if isinstance(timeout, ClientSeconds) else "call's"
    return f" after {timeout:g} s, the {whose} timeout"
