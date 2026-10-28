"""The functions of `dfo.analysis` over the default client.

Each runs one of DFO's operations at once, as `client.analysis` does on a client
the caller builds: `analysis.rank(data, by="origin")` returns what
`dfo.fetch(analysis.recipe(data).rank(by="origin"))` returns. `dfo.configure`
sets the client they use.
"""

from collections.abc import Mapping, Sequence

from dfo._client.default import default_client
from dfo._datasets.dataset import Dataset
from dfo._datasets.recipe import Aggregation, Change, Columns, Pairing, Start, Year


def filter(data: Start, /, *, keep: Mapping[str, str | Sequence[str]]) -> Dataset:
    """Keep the rows whose role or column holds one of the values, as
    `keep={"destination": ["country/KEN"]}`.

    Raises:
        InvalidRequestError: `keep` is not a non-empty mapping of names to a value
            or a list of values, and no request is sent (`invalid_argument`); or
            DFO refused the step.
    """
    return default_client().analysis.filter(data, keep=keep)


def aggregate(data: Start, /, *, by: Columns = (), how: Aggregation = "sum") -> Dataset:
    """Totals or averages, keeping the members of `by` apart.

    Args:
        data: A `Spec`, `DatasetRef`, `Dataset` or `Recipe` holding one reading.
        by: The roles whose members stay apart, such as `"origin"`; none totals
            every row of each year.
        how: `sum`, `mean`, `max` or `min`.
    """
    return default_client().analysis.aggregate(data, by=by, how=how)


def growth(
    data: Start,
    /,
    *,
    by: Columns = (),
    window: tuple[Year, Year],
    change: Change = "relative",
) -> Dataset:
    """Change from the first to the last year of `window`, for each member of
    `by`.

    Args:
        data: The reading.
        by: The roles whose members each get their own change.
        window: The first and last years, such as
            `(latest_year(-4), latest_year())`.
        change: `relative`, a fraction such as 0.25 for 25%, or `absolute`, an
            amount in the data's unit.
    """
    return default_client().analysis.growth(data, by=by, window=window, change=change)


def rank(
    data: Start,
    /,
    *,
    by: Columns,
    window: tuple[Year, Year] | None = None,
    how: Aggregation | None = None,
    limit: int | None = None,
) -> Dataset:
    """Order the members of `by`, largest first, and keep the top `limit`.

    Args:
        data: The reading.
        by: The roles whose members are ranked, such as `"origin"`.
        window: The years ranked over, such as `(latest_year(), latest_year())`;
            None ranks every year the data holds.
        how: How each member's rows in the window reduce to one value first;
            None ranks each member's one value.
        limit: The most members kept, from 1 to 1000; a tie at the last place
            keeps every member that shares it.
    """
    return default_client().analysis.rank(
        data, by=by, window=window, how=how, limit=limit
    )


def quotient_of(data: Start, other: Start, /, *, on: Pairing | None = None) -> Dataset:
    """Divide one reading by another, pairing roles through `on`, such as aid per
    person with `on={"destination": "place"}`; a list such as `["place"]` names
    the same role on both sides."""
    return default_client().analysis.quotient_of(data, other, on=on)


def share_of(
    data: Start,
    total: Start | None = None,
    /,
    *,
    by: Columns | None = None,
    on: Pairing | None = None,
) -> Dataset:
    """Each value as a percentage of the matching row of `total`, or, with no
    `total`, of the total across all members of `by` in the same year.

    Raises:
        InvalidRequestError: Neither `total` nor `by` is given
            (`invalid_argument`); no request is sent.
    """
    return default_client().analysis.share_of(data, total, by=by, on=on)


def join(data: Start, other: Start, /, *, on: Pairing | None = None) -> Dataset:
    """Match two readings on their keys and return both sides' rows in long
    format, told apart by `stat_var`."""
    return default_client().analysis.join(data, other, on=on)


def sum_of(data: Start, other: Start, /, *, on: Pairing | None = None) -> Dataset:
    """Add the matching rows of two readings over the years both hold."""
    return default_client().analysis.sum_of(data, other, on=on)


def compare(data: Start, other: Start, /, *, on: Pairing | None = None) -> Dataset:
    """The difference, `data` minus `other`, for each matching member over the
    years both hold. DFO refuses two different units."""
    return default_client().analysis.compare(data, other, on=on)
