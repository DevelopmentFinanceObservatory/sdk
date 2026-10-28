"""The functions of `dfo.cards` over the default client.

Each stores one card DFO draws from a Dataset, as `client.cards` does on a
client the caller builds. `dfo.configure` sets the client they use.
"""

from dfo._client.default import default_client
from dfo._datasets.publication import Card, Source
from dfo._datasets.recipe import Change, Year


def line(
    data: Source,
    /,
    *,
    window: tuple[Year, Year] | None = None,
    title: str | None = None,
) -> Card:
    """A line chart with one line per series, over time.

    Args:
        data: A Dataset, or a ref of one version. The card draws every series it
            holds, so narrow it with `dfo.analysis.filter` first.
        window: The first and last years drawn, such as
            `(latest_year(-9), latest_year())`, which DFO settles each time the
            card is drawn; None draws every year.
        title: The chart's title; None lets DFO title it.

    Raises:
        InvalidRequestError: `data` holds no version, several, or no rows, or an
            argument is malformed (`invalid_argument`), and no request is sent;
            or DFO refused the card.
    """
    return default_client().cards.line(data, window=window, title=title)


def bar(
    data: Source,
    /,
    *,
    window: tuple[Year, Year] | None = None,
    title: str | None = None,
) -> Card:
    """A bar chart that compares the series' members or the years. Takes
    `line`'s arguments."""
    return default_client().cards.bar(data, window=window, title=title)


def table(
    data: Source,
    /,
    *,
    window: tuple[Year, Year] | None = None,
    title: str | None = None,
) -> Card:
    """A table of every series over the years. Takes `line`'s arguments."""
    return default_client().cards.table(data, window=window, title=title)


def stat(
    data: Source,
    /,
    *,
    year: Year | None = None,
    compare_to: Year | None = None,
    change: Change = "difference",
    title: str | None = None,
) -> Card:
    """One headline value of a single series, with its change since another year.

    Args:
        data: A Dataset or ref of one series.
        year: The year shown, such as `latest_year()`; None shows the newest year
            the series holds.
        compare_to: The year the change counts from, such as `latest_year(-1)`;
            None shows no change.
        change: `difference`, the shown value minus the earlier, or `percent`,
            that difference as a percentage of the earlier.
        title: The card's title; None lets DFO title it.

    Raises:
        InvalidRequestError: `compare_to` is given without `year`, or `change`
            without `compare_to` (`invalid_argument`), and no request is sent;
            or DFO refused the card.
    """
    return default_client().cards.stat(
        data, year=year, compare_to=compare_to, change=change, title=title
    )


def source(data: Source, /) -> Card:
    """The source, licence, dates and citation of a version's data."""
    return default_client().cards.source(data)
