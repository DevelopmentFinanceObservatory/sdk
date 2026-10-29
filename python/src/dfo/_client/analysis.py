"""The functions of `dfo.analysis` over the default client.

Each runs one of DFO's operations at once, as `client.analysis` does on a client
the caller builds: `analysis.rank(data, by="origin")` returns what
`dfo.fetch(analysis.recipe(data).rank(by="origin"))` returns, and each takes
`strict` and `timeout` as `dfo.fetch` does. `dfo.configure` sets the client
they use.
"""

from collections.abc import Mapping, Sequence

from dfo._client.default import default_client
from dfo._datasets.dataset import Dataset
from dfo._datasets.recipe import (
    Aggregation,
    Columns,
    GrowthChange,
    Pairing,
    Start,
    Year,
)


def filter(
    data: Start,
    /,
    *,
    keep: Mapping[str, str | Sequence[str]],
    strict: bool = False,
    timeout: float | None = None,
) -> Dataset:
    """Keep the rows whose role or column holds one of the values, as
    `keep={"destination": ["country/KEN"]}`.

    Args:
        data: A `Spec`, `DatasetRef`, `Dataset` or `Recipe` holding one reading.
        keep: Each role or column, with the value or values its rows keep.
        strict: Raise the `SeriesLeftOutWarning` instead of issuing it.
        timeout: The longest the call takes, in seconds, the read included.
            None, the default, waits as long as the readings take to build.

    Raises:
        InvalidRequestError: `keep` is not a non-empty mapping of names to a value
            or a list of values, and no request is sent (`invalid_argument`); or
            DFO refused the step.
        DfoTimeoutError: `timeout` passed (`deadline_exceeded`).
    """
    return default_client().analysis.filter(
        data, keep=keep, strict=strict, timeout=timeout
    )


def aggregate(
    data: Start,
    /,
    *,
    by: Columns = (),
    how: Aggregation = "sum",
    strict: bool = False,
    timeout: float | None = None,
) -> Dataset:
    """Totals or averages the rows of each year, keeping the members of `by`
    apart.

    Args:
        data: A `Spec`, `DatasetRef`, `Dataset` or `Recipe` holding one reading.
        by: The roles whose members stay apart, such as `"origin"`; none totals
            every row of each year. Each year stays its own row.
        how: `sum`, `mean`, `max` or `min`.
        strict: Raise the `SeriesLeftOutWarning` instead of issuing it.
        timeout: The longest the call takes, in seconds; None waits.
    """
    return default_client().analysis.aggregate(
        data, by=by, how=how, strict=strict, timeout=timeout
    )


def growth(
    data: Start,
    /,
    *,
    by: Columns = (),
    window: tuple[Year, Year],
    change: GrowthChange = "relative",
    strict: bool = False,
    timeout: float | None = None,
) -> Dataset:
    """Change from the first to the last year of `window`, for each member of
    `by`.

    Args:
        data: The reading.
        by: The roles whose members each get their own change.
        window: The first and last years, such as
            `(latest_year(-4), latest_year())`.
        change: `relative`, the default, the change divided by the first year's
            value, a fraction where 0.25 is a 25% rise; or `difference`, the
            last year's value minus the first's, in the data's unit.
        strict: Raise the `SeriesLeftOutWarning` instead of issuing it.
        timeout: The longest the call takes, in seconds; None waits.
    """
    return default_client().analysis.growth(
        data, by=by, window=window, change=change, strict=strict, timeout=timeout
    )


def rank(
    data: Start,
    /,
    *,
    by: Columns,
    window: tuple[Year, Year] | None = None,
    how: Aggregation | None = None,
    limit: int | None = None,
    strict: bool = False,
    timeout: float | None = None,
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
        strict: Raise the `SeriesLeftOutWarning` instead of issuing it.
        timeout: The longest the call takes, in seconds; None waits.
    """
    return default_client().analysis.rank(
        data,
        by=by,
        window=window,
        how=how,
        limit=limit,
        strict=strict,
        timeout=timeout,
    )


def quotient_of(
    data: Start,
    other: Start,
    /,
    *,
    on: Pairing | None = None,
    strict: bool = False,
    timeout: float | None = None,
) -> Dataset:
    """Divide one reading by another, pairing roles through `on`, such as aid per
    person with `on={"destination": "place"}`; a list such as `["place"]` names
    the same role on both sides. Takes `strict` and `timeout` as `filter`
    does."""
    return default_client().analysis.quotient_of(
        data, other, on=on, strict=strict, timeout=timeout
    )


def share_of(
    data: Start,
    total: Start | None = None,
    /,
    *,
    by: Columns | None = None,
    on: Pairing | None = None,
    strict: bool = False,
    timeout: float | None = None,
) -> Dataset:
    """Each value as a percentage of the matching row of `total`, or, with no
    `total`, of the total across all members of `by` in the same year.

    The value is a percentage from 0 to 100 when each value is part of its
    total, so 25.0 is a quarter, and the rows' `unit` names the percentage.
    Takes `strict` and `timeout` as `filter` does.

    Raises:
        InvalidRequestError: Neither `total` nor `by` is given
            (`invalid_argument`); no request is sent.
    """
    return default_client().analysis.share_of(
        data, total, by=by, on=on, strict=strict, timeout=timeout
    )


def join(
    data: Start,
    other: Start,
    /,
    *,
    on: Pairing | None = None,
    strict: bool = False,
    timeout: float | None = None,
) -> Dataset:
    """Match two readings on their keys and return both sides' rows in long
    format, told apart by `stat_var`. Takes `strict` and `timeout` as `filter`
    does."""
    return default_client().analysis.join(
        data, other, on=on, strict=strict, timeout=timeout
    )


def sum_of(
    data: Start,
    other: Start,
    /,
    *,
    on: Pairing | None = None,
    strict: bool = False,
    timeout: float | None = None,
) -> Dataset:
    """Add the matching rows of two readings over the years both hold. Takes
    `strict` and `timeout` as `filter` does."""
    return default_client().analysis.sum_of(
        data, other, on=on, strict=strict, timeout=timeout
    )


def compare(
    data: Start,
    other: Start,
    /,
    *,
    on: Pairing | None = None,
    strict: bool = False,
    timeout: float | None = None,
) -> Dataset:
    """The difference, `data` minus `other`, for each matching member over the
    years both hold. DFO refuses two different units. Takes `strict` and
    `timeout` as `filter` does."""
    return default_client().analysis.compare(
        data, other, on=on, strict=strict, timeout=timeout
    )
