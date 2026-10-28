"""Years stated relative to the newest year the data holds.

`latest_year(offset)` names a year counted back from the newest year at least half
the series hold, the rule DFO calls `half1`. DFO settles it each time a recipe
runs, so a recipe over `(latest_year(-4), latest_year())` moves forward when a
source publishes a new year. A recipe sends it as `{"anchor": "latest",
"offset": n}`, and a derived member's `resolved_periods` records the year each
offset settled on.
"""

from dataclasses import dataclass
from typing import Any, override

from dfo._core.codes import INVALID_ARGUMENT
from dfo._core.errors import client_error

# The furthest back an offset reaches, as DFO's operations accept it.
MIN_OFFSET = -9999


@dataclass(frozen=True, slots=True)
class LatestYear:
    """A year counted back from the newest year at least half the series hold.

    Attributes:
        offset: Years before the newest, 0 or below: 0 is the newest year and -1
            the year before it.
    """

    offset: int = 0

    @override
    def __repr__(self) -> str:
        return f"latest_year({self.offset})" if self.offset else "latest_year()"


def latest_year(offset: int = 0) -> LatestYear:
    """A year counted back from the newest year at least half the series hold.

    DFO settles the year each time the recipe that holds it runs, so
    `(latest_year(-9), latest_year())` stays the last ten years as sources
    publish. It is accepted wherever an operation takes a year.

    Args:
        offset: Years before the newest, 0 or below.

    Raises:
        InvalidRequestError: `offset` is not an integer from -9999 to 0
            (`invalid_argument`).
    """
    if (
        not isinstance(offset, int)
        or isinstance(offset, bool)
        or not MIN_OFFSET <= offset <= 0
    ):
        raise client_error(
            INVALID_ARGUMENT,
            "latest_year takes an offset from -9999 to 0 years before the newest, "
            f"such as latest_year(-4), not {offset!r}",
        )
    return LatestYear(offset)


def period_object(year: object, name: str) -> str | dict[str, Any]:
    """`year` as an operation's argument: a four-digit year as text, or a latest
    year as its rolling reference.

    Raises:
        InvalidRequestError: `year` is neither an integer from 1000 to 9999 nor a
            `latest_year(...)` (`invalid_argument`). `name` names the argument.
    """
    if isinstance(year, LatestYear):
        return {"anchor": "latest", "offset": year.offset}
    if isinstance(year, int) and not isinstance(year, bool) and 1000 <= year <= 9999:
        return f"{year}"
    raise client_error(
        INVALID_ARGUMENT,
        f"{name} holds years such as 2020 or latest_year(-4), not {year!r}",
    )
