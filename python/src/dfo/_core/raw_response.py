"""The response `client.request` returns for a route the client does not wrap."""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, override

from dfo._core.codes import UNEXPECTED_RESPONSE
from dfo._core.errors import client_error
from dfo._core.json_text import loads
from dfo._core.text import single_line
from dfo._core.types import counted


@dataclass(frozen=True, slots=True, eq=False, repr=False)
class RawResponse:
    """A response from `client.request`, for a route the client does not wrap.

    Attributes:
        status_code: The HTTP status, always a 2xx or 3xx since a refusal raises.
        headers: The response headers, keyed in lower case.
        content: The body's bytes.
    """

    status_code: int
    headers: Mapping[str, str]
    content: bytes

    @override
    def __repr__(self) -> str:
        items = [str(self.status_code), self.headers.get("content-type")]
        items.append(counted(len(self.content), "byte"))
        return single_line(
            f"RawResponse({', '.join(item for item in items if item is not None)})"
        )

    @property
    def text(self) -> str:
        """The body decoded as UTF-8."""
        return self.content.decode("utf-8", errors="replace")

    def json(self) -> Any:
        """The body decoded as JSON.

        Raises:
            ContractError: The body is not UTF-8 JSON, holds `NaN` or
                `Infinity`, or nests arrays and objects deeper than
                `JSON_MAX_DEPTH` levels (`unexpected_response`).
        """
        try:
            return loads(self.content)
        except ValueError as error:
            raise client_error(
                UNEXPECTED_RESPONSE,
                f"The body of the HTTP {self.status_code} response is not JSON: "
                f"{error}",
                status=self.status_code,
                builtin=ValueError,
            ) from error
