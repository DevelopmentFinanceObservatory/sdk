"""Cards: charts, tables, headline numbers and source notes DFO stores and draws.

Each call posts one intent to `POST /presentation/components` and returns the
`Card` DFO stored. A card draws the frame of one exact version: the version a
Dataset holds, a derived frame included, or the one a `DatasetRef` names. It
draws every series of that version, since its `select` binds `stat_var` to the
variables the version holds and leaves every other dimension open; narrow the
rows with `dfo.analysis.filter` first. A Dataset's variables are read from its
`stat_var` column. A ref's, and those of a Dataset without that column, are
read from `GET /presentation/frames/{spec_id}/{version}?dimension=stat_var`,
one request more.

A window is `{start, end}`, each side a year as text or a latest year as
`{anchor: "latest", offset}`, which DFO settles each time the card is drawn. A
stat card shows the value of one year, so it sends `year` as both ends of its
window; with `compare_to` its window runs from `compare_to` to `year`, and its
`change` names those two years as its basis.

The create carries a `cmw_` write token the client mints, which makes a retry
of the same create answer the first card instead of storing a second one.

`AsyncCards` holds the `client.cards` calls.
"""

import secrets
from collections.abc import Mapping
from typing import Any

from dfo._core.codes import CONTRACT_VIOLATION, INVALID_ARGUMENT
from dfo._core.errors import client_error
from dfo._core.periods import period_object
from dfo._core.refs import DatasetRef
from dfo._core.refusals import describing, trace_id_of
from dfo._datasets.build import response_json
from dfo._datasets.dataset import Dataset
from dfo._datasets.publication import (
    CARD_TYPES,
    Card,
    CardKind,
    Source,
    read_card,
)
from dfo._datasets.recipe import Change, Year
from dfo._http.transport import AsyncTransport

CARDS_PATH = "/presentation/components"

# The column every frame names its variable in.
_STAT_VAR = "stat_var"


async def create_card(
    transport: AsyncTransport,
    kind: CardKind,
    data: object,
    intent: Mapping[str, Any],
) -> Card:
    """Store a card of `kind` drawing `data`, with the intent's other members.

    Raises:
        InvalidRequestError: `data` is not a Dataset or ref of one version
            with rows (`invalid_argument`), and no request is sent; or DFO
            refused the intent.
        NotFoundError: The version's frame has aged out (`frame_unavailable`).
    """
    ref = _one_version(data, transport.caller)
    (member,) = ref.members
    frame = {"spec_id": member.spec.spec_id, "content_version": member.content_version}
    body: dict[str, Any] = {"type": CARD_TYPES[kind], "frame_ref": frame, **intent}
    if kind != "source":
        body["select"] = {_STAT_VAR: await _variables(transport, data, frame)}
    token = "cmw_" + secrets.token_urlsafe(16)
    response = await transport.request(
        "POST", CARDS_PATH, json={"intent": body, "write_token": token}
    )
    reply = response_json(response)
    with describing(trace_id_of(response, reply)):
        return read_card(reply, route=f"POST {CARDS_PATH}", kind=kind, ref=ref)


def _one_version(data: object, caller: str) -> DatasetRef:
    """The ref of the one version `data` holds."""
    if isinstance(data, Dataset):
        if not data.members:
            raise client_error(
                INVALID_ARGUMENT,
                "A website bundle opened from a folder names no version, so DFO "
                "cannot draw it; fetch the dataset, then make the card",
            )
        if len(data) == 0:
            raise client_error(
                INVALID_ARGUMENT, "The Dataset holds no rows, so a card draws nothing"
            )
        data = data.ref
    if not isinstance(data, DatasetRef):
        raise client_error(
            INVALID_ARGUMENT,
            "A card draws a Dataset or a DatasetRef of one version, not "
            f"{type(data).__name__}; fetch it first with {caller}.fetch(...)",
        )
    if len(data.members) != 1:
        raise client_error(
            INVALID_ARGUMENT,
            f"A card draws one reading, and this one holds {len(data.members)}; "
            f"fetch one with {caller}.fetch(DatasetRef((data.ref.members[0],)))",
        )
    return data


async def _variables(
    transport: AsyncTransport, data: object, frame: Mapping[str, str]
) -> str | list[str]:
    """The variables the version holds, from a Dataset's rows when they name
    them, else from DFO: one as text, several as a list."""
    if isinstance(data, Dataset) and _STAT_VAR in data._table.column_names:
        found = [
            value
            for value in data._table.column(_STAT_VAR).unique().to_pylist()
            if isinstance(value, str)
        ]
    else:
        path = f"/presentation/frames/{frame['spec_id']}/{frame['content_version']}"
        response = await transport.request("GET", path, params={"dimension": _STAT_VAR})
        reply = response_json(response)
        values = reply.get("values") if isinstance(reply, Mapping) else None
        if not isinstance(values, list):
            raise client_error(
                CONTRACT_VIOLATION,
                f"GET {path} answered no list of the frame's variables",
                trace_id=trace_id_of(response, reply),
            )
        found = [value for value in values if isinstance(value, str)]
    if not found:
        raise client_error(
            INVALID_ARGUMENT, "The version names no variable, so a card draws nothing"
        )
    return found[0] if len(found) == 1 else found


def card_window(window: object) -> dict[str, Any]:
    """A card's `(first_year, last_year)` as its intent's window.

    Raises:
        InvalidRequestError: `window` is not a pair of years
            (`invalid_argument`).
    """
    if not isinstance(window, tuple) or len(window) != 2:
        raise client_error(
            INVALID_ARGUMENT,
            "window is (first_year, last_year), such as (latest_year(-9), "
            f"latest_year()), not {window!r}",
        )
    start, end = window
    return {
        "start": period_object(start, "window"),
        "end": period_object(end, "window"),
    }


def _titled(title: object) -> dict[str, Any]:
    if title is None:
        return {}
    if not isinstance(title, str) or not title.strip():
        raise client_error(INVALID_ARGUMENT, f"title is non-empty text, not {title!r}")
    return {"title": title}


def _windowed(window: object) -> dict[str, Any]:
    return {} if window is None else {"window": card_window(window)}


def stat_intent(
    *, year: object, compare_to: object, change: object, title: object
) -> dict[str, Any]:
    """A stat card's window and change.

    Raises:
        InvalidRequestError: `compare_to` is given without `year`, `change` is
            not a `Change`, or a year is malformed (`invalid_argument`).
    """
    if change not in ("difference", "percent"):
        raise client_error(
            INVALID_ARGUMENT,
            f"change is 'difference' or 'percent', not {change!r}",
        )
    intent = _titled(title)
    if compare_to is None:
        if change != "difference":
            raise client_error(
                INVALID_ARGUMENT,
                "change needs compare_to, the year the change counts from",
            )
        if year is not None:
            shown = period_object(year, "year")
            intent["window"] = {"start": shown, "end": shown}
        return intent
    if year is None:
        raise client_error(
            INVALID_ARGUMENT,
            "compare_to needs year, the year the change counts to, such as "
            "year=latest_year(), compare_to=latest_year(-1)",
        )
    start, end = period_object(compare_to, "compare_to"), period_object(year, "year")
    basis: dict[str, Any] = {"basis": [start, end]}
    if change == "percent":
        basis["derivation"] = "percent_change"
    return {**intent, "window": {"start": start, "end": end}, "change": basis}


class AsyncCards:
    """Cards DFO stores and draws, each from one Dataset or ref.

    A card draws every series of the version it is given, so narrow it with
    `dfo.analysis.filter` first. A card on its own stays in DFO's 30-day tier;
    the first share that includes it pins its version.
    """

    def __init__(self, transport: AsyncTransport) -> None:
        """Store cards through `transport`."""
        self._transport = transport

    def __repr__(self) -> str:
        return f"<{type(self).__name__}: line, bar, table, stat, source>"

    async def line(
        self,
        data: Source,
        /,
        *,
        window: tuple[Year, Year] | None = None,
        title: str | None = None,
    ) -> Card:
        """A line chart with one line per series, over time.

        Args:
            data: A Dataset, or a ref of one version.
            window: The first and last years drawn, such as
                `(latest_year(-9), latest_year())`; None draws every year.
            title: The chart's title; None lets DFO title it.

        Raises:
            InvalidRequestError: `data` holds no version, several, or no rows,
                or an argument is malformed (`invalid_argument`), and no request
                is sent; or DFO refused the card, such as one whose series vary
                along two roles.
        """
        intent = {**_windowed(window), **_titled(title)}
        return await create_card(self._transport, "line", data, intent)

    async def bar(
        self,
        data: Source,
        /,
        *,
        window: tuple[Year, Year] | None = None,
        title: str | None = None,
    ) -> Card:
        """A bar chart that compares the series' members or the years.

        Takes `line`'s arguments.
        """
        intent = {**_windowed(window), **_titled(title)}
        return await create_card(self._transport, "bar", data, intent)

    async def table(
        self,
        data: Source,
        /,
        *,
        window: tuple[Year, Year] | None = None,
        title: str | None = None,
    ) -> Card:
        """A table of every series over the years.

        Takes `line`'s arguments.
        """
        intent = {**_windowed(window), **_titled(title)}
        return await create_card(self._transport, "table", data, intent)

    async def stat(
        self,
        data: Source,
        /,
        *,
        year: Year | None = None,
        compare_to: Year | None = None,
        change: Change = "difference",
        title: str | None = None,
    ) -> Card:
        """One headline value of a single series, with its change since another
        year.

        Args:
            data: A Dataset or ref of one series.
            year: The year shown, such as `latest_year()`; None shows the newest
                year the series holds.
            compare_to: The year the change counts from, such as
                `latest_year(-1)`; None shows no change.
            change: `difference`, the shown value minus the earlier, or
                `percent`, that difference as a percentage of the earlier.
            title: The card's title; None lets DFO title it.

        Raises:
            InvalidRequestError: `compare_to` is given without `year`, or
                `change` without `compare_to` (`invalid_argument`), and no
                request is sent; or DFO refused the card, such as one whose
                years hold no value.
        """
        intent = stat_intent(
            year=year, compare_to=compare_to, change=change, title=title
        )
        return await create_card(self._transport, "stat", data, intent)

    async def source(self, data: Source, /) -> Card:
        """The source, licence, dates and citation of a version's data.

        Raises:
            InvalidRequestError: `data` holds no version, several, or no rows
                (`invalid_argument`), and no request is sent.
        """
        return await create_card(self._transport, "source", data, {})
