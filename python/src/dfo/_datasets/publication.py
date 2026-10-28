"""What cards and shares are: the values `dfo.cards`, `dfo.share` and
`dfo.history` return, and how the client reads them from DFO's replies.

A `Card` is one chart, table, headline number or source note DFO stores and
draws from one frame. A `Share` publishes cards under one `/s/<id>` link, one
card per numbered slot: a live share follows new data and takes new cards under
the same URLs, and a snapshot keeps the versions its cards drew when it was
made. A `Served` is one frame a share's slot served, as `dfo.history` lists it.
`dfo.fetch(share)` reads the frame a slot shows, which `ShownFrame` names.

A card's and a share's write tokens grant changing them, so each value carries
its token and prints without it. Every value here is plain data with no client,
so it pickles and compares like any frozen dataclass.

This module is sync and shared by both clients.
"""

import re
from collections.abc import Mapping
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta, timezone
from typing import Any, Literal, override
from urllib.parse import urlsplit

from dfo._core.codes import CONTRACT_VIOLATION, INVALID_ARGUMENT
from dfo._core.errors import ContractError, client_error
from dfo._core.refs import DatasetRef
from dfo._core.text import single_line
from dfo._core.types import clipped
from dfo._datasets.build import read_held_until
from dfo._datasets.dataset import Dataset, day_text

type CardKind = Literal["line", "bar", "table", "stat", "source"]
"""What a card draws: a line chart, a bar chart, a table, a headline number, or
the source and citation of its data."""

type Source = Dataset | DatasetRef
"""What a card draws: a Dataset, or a ref of one version."""

type StatChange = Literal["percent", "difference"]
"""How a stat card works out its change since `compare_to`: `percent`, the
difference as a percentage of the earlier year's value, where 25.0 is a 25%
rise; or `difference`, the shown value minus the earlier, in the data's unit."""

# Each card kind's component type in DFO's card catalogue.
CARD_TYPES: Mapping[CardKind, str] = {
    "line": "line_chart",
    "bar": "bar_chart",
    "table": "table",
    "stat": "stat_card",
    "source": "source_card",
}

# A share id as DFO mints it, or keeps it from a website share.
SHARE_ID = re.compile(r"[A-Za-z0-9]{8}")
# The share pages whose last path segment is the share id.
_SHARE_PAGES = ("s", "embed")

_MONTHS = (
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
)


@dataclass(frozen=True, slots=True)
class Card:
    """A card DFO stores and draws from one frame.

    A card on its own stays in DFO's 30-day tier; the first share that includes
    it pins the version it draws. `held_until` and `pinned` state that version's
    retention when the card was made.

    Attributes:
        id: The card's id, `cmp_<...>`.
        revision: The card revision this value names, 1 for a new card.
        kind: What the card draws.
        ref: The exact version the card draws, which `dfo.fetch(card.ref)`
            reads back.
        title: The title the card shows, DFO's own when none was given. None
            for a source card, which shows no title.
        write_token: The `cmw_` token that grants revising the card. Keep it
            as a secret; the repr leaves it out.
        held_until: The date the version the card draws stops being
            guaranteed, 30 days after DFO stored it, when the card was made.
            None when pinned or when DFO holds no record of the version.
        pinned: Whether DFO kept that version with no time limit when the card
            was made.
        series: How many series the card draws, which the repr prints, so a
            card that draws 40 donors shows it before it goes on a page. 0 for
            a source card.
        series_cut: How many of those series the create reply's summary did
            not list; DFO lists at most 12.
    """

    id: str
    revision: int
    kind: CardKind
    ref: DatasetRef
    title: str | None
    write_token: str = field(repr=False)
    held_until: date | None = None
    pinned: bool = False
    series: int = 0
    series_cut: int = 0

    @override
    def __repr__(self) -> str:
        (member,) = self.ref.members
        title = f', "{clipped(self.title)}"' if self.title else ""
        drawn = "" if self.kind == "source" else f", {self.series:,} series"
        return single_line(
            f"Card({self.kind} {self.id}{title}{drawn}, draws {member.spec.spec_id} "
            f"at {member.content_version})"
        )


@dataclass(frozen=True, slots=True)
class Share:
    """Cards published under one link, each in a numbered slot.

    Attributes:
        id: The share's id, 8 letters and digits.
        url: The share's page, `/s/<id>`.
        embed_url: The share's embeddable page, `/embed/<id>`.
        data_urls: One JSON data URL per slot, in slot order. A slot keeps its
            URL when the share's cards are replaced, so `data_urls[0]` always
            reads the first slot. Any page may read them, with no key.
        revision: The share revision this value names, 1 for a new share.
        latest: True for a live share, which follows new data and takes new
            cards; False for a snapshot, which keeps the versions its cards
            drew when it was made.
        write_token: The `shw_` token that grants replacing the share's cards,
            fixing it as a snapshot and taking it down. DFO returns it only when
            the share is made and the client saves it nowhere, so keep it as a
            secret beside the share's `url` and pass both to `dfo.unshare(url,
            write_token=...)` later; the repr leaves it out. None when this
            value was built without it.
    """

    id: str
    url: str
    embed_url: str
    data_urls: tuple[str, ...]
    revision: int
    latest: bool
    write_token: str | None = field(default=None, repr=False)

    @override
    def __repr__(self) -> str:
        mode = "live" if self.latest else "snapshot"
        slots = len(self.data_urls)
        return single_line(
            f"Share({mode} {clipped(self.url)}, {slots} slot"
            f"{'' if slots == 1 else 's'}, revision {self.revision})"
        )


type ShareTarget = Share | str
"""A share: the `Share` a share call returned, or the URL of its page or embed."""


@dataclass(frozen=True, slots=True)
class Served:
    """One frame a share's slot served, as `dfo.history` lists it.

    Attributes:
        slot: The slot that served it, from 1.
        card_id: The card the slot showed.
        card_revision: The card revision the slot showed.
        spec_id: The frame's spec id, `spec_<hex>` or `ops_<hex>`.
        content_version: The frame's version, `cv_<hex>` or `ocv_<hex>`.
        first_served: When a read first served the frame.
        pinned: Whether DFO keeps the frame with no time limit.
        held_until: The date an unpinned frame stops being guaranteed, 30 days
            after DFO stored it. None when pinned or when DFO holds no record.
        fetchable: Whether the frame can still be fetched.
    """

    slot: int
    card_id: str
    card_revision: int
    spec_id: str
    content_version: str
    first_served: datetime
    pinned: bool
    held_until: date | None
    fetchable: bool

    @override
    def __repr__(self) -> str:
        served = _day(self.first_served.date())
        if not self.fetchable:
            keep = "no longer fetchable"
        elif self.pinned or self.held_until is None:
            keep = "fetchable"
        else:
            keep = f"fetchable until {_day(self.held_until)}"
        return single_line(
            f"Served(slot {self.slot} {self.card_id} from {served}: "
            f"{self.spec_id} at {self.content_version} · {keep})"
        )


type Moment = date | datetime | str
"""A moment `dfo.fetch(share, as_of=...)` reads a share at: a date, a datetime
with its time zone, a `YYYY-MM-DD` day, or an RFC 3339 date-time string with
its offset."""


@dataclass(frozen=True, slots=True)
class ShownFrame:
    """The frame one slot of a share shows, and the card that shows it.

    Attributes:
        share_id: The share's id.
        slot: The slot, from 1.
        title: The title the slot's card shows, or None.
        spec_id: The frame's spec id, `spec_<hex>` or `ops_<hex>`.
        content_version: The frame's version, `cv_<hex>` or `ocv_<hex>`.
        on: The day the fetch asked about, or the day it read what the slot
            shows now, in UTC.
        newer_now: Whether the slot can show another frame now: True for an
            `as_of` read of a live share, False when the read was of what the
            slot shows now or of a snapshot, which keeps its frames.
    """

    share_id: str
    slot: int
    title: str | None
    spec_id: str
    content_version: str
    on: date
    newer_now: bool = False

    def line(self) -> str:
        """The frame as a Dataset's repr names it, as
        `share k3Qx8vTa, slot 2 "Malaria grants", on 3 October 2026`."""
        title = f' "{clipped(self.title)}"' if self.title else ""
        return f"share {self.share_id}, slot {self.slot}{title}, on {day_text(self.on)}"


def _day(day: date) -> str:
    return f"{day.day} {_MONTHS[day.month - 1]} {day.year}"


def read_card(reply: object, *, route: str, kind: CardKind, ref: DatasetRef) -> Card:
    """The card a create reply names.

    Raises:
        ContractError: The reply lacks the card's id, revision, write token or
            fact summary, or its retention is malformed (`contract_violation`).
    """
    body = _object(reply, route, "")
    pinned, held_until = _retention(body.get("retention"), route, "/retention")
    listed, cut = _drawn_series(body, route)
    return Card(
        _text(body, "component_id", route),
        _count(body, "revision", route),
        kind,
        ref,
        card_title(body),
        _text(body, "write_token", route),
        held_until,
        pinned,
        listed + cut,
        cut,
    )


def _drawn_series(body: Mapping[str, Any], route: str) -> tuple[int, int]:
    """The series a card reply's `fact_summary` lists, and how many it left
    unlisted.

    Raises:
        ContractError: The reply holds no summary, or one with no list of series
            or no count of the ones cut (`contract_violation`).
    """
    summary = _object(body.get("fact_summary"), route, "/fact_summary")
    series = summary.get("series")
    if not isinstance(series, list):
        raise _violation(route, "/fact_summary/series", "is not a list")
    return len(series), _count(summary, "series_cut", route, "/fact_summary", least=0)


def card_title(body: object) -> str | None:
    """The title a card reply's drawn card shows, or None when it shows none."""
    payload = body.get("resolved_payload") if isinstance(body, Mapping) else None
    component = payload.get("component") if isinstance(payload, Mapping) else None
    title = component.get("title") if isinstance(component, Mapping) else None
    text = title.get("text") if isinstance(title, Mapping) else None
    return text if isinstance(text, str) and text else None


def read_share(reply: object, *, route: str, write_token: str | None) -> Share:
    """The share a create, replace or snapshot reply names, carrying the
    reply's write token, else `write_token`.

    Raises:
        ContractError: The reply lacks a member the share is read from
            (`contract_violation`).
    """
    body = _object(reply, route, "")
    data_urls = body.get("data_urls")
    if not isinstance(data_urls, list) or not all(
        isinstance(url, str) and url for url in data_urls
    ):
        raise _violation(route, "/data_urls")
    return Share(
        _text(body, "id", route),
        _text(body, "url", route),
        _text(body, "embed_url", route),
        tuple(data_urls),
        _count(body, "revision", route),
        _flag(body, "latest", route),
        _text(body, "write_token", route) if "write_token" in body else write_token,
    )


def read_history(reply: object, *, route: str) -> tuple[Served, ...]:
    """The frames a history reply lists, newest first.

    Raises:
        ContractError: An entry lacks a member it is read from
            (`contract_violation`).
    """
    served = _object(reply, route, "").get("served")
    if not isinstance(served, list):
        raise _violation(route, "/served")
    return tuple(
        _served(_object(entry, route, f"/served/{index}"), route, f"/served/{index}")
        for index, entry in enumerate(served)
    )


def _served(entry: Mapping[str, Any], route: str, pointer: str) -> Served:
    frame = _object(entry.get("frame"), route, f"{pointer}/frame")
    pinned, held_until = _retention(
        entry.get("retention"), route, f"{pointer}/retention"
    )
    try:
        served_at = datetime.fromisoformat(
            _text(entry, "first_served_at", route, pointer)
        )
    except ValueError as error:
        raise _violation(
            route, f"{pointer}/first_served_at", "is not an ISO 8601 time"
        ) from error
    return Served(
        _count(entry, "slot", route, pointer),
        _text(entry, "component_id", route, pointer),
        _count(entry, "revision", route, pointer),
        _text(frame, "spec_id", route, f"{pointer}/frame"),
        _text(frame, "content_version", route, f"{pointer}/frame"),
        served_at,
        pinned,
        held_until,
        _flag(entry, "fetchable", route, pointer),
    )


def _retention(value: object, route: str, pointer: str) -> tuple[bool, date | None]:
    """Whether a reply's retention pins its frame, and the date an unpinned one
    is held until. DFO answers null for a frame it holds no record of, which
    reads as unpinned with no date."""
    if value is None:
        return False, None
    held = _object(value, route, pointer)
    if _flag(held, "pinned", route, pointer):
        return True, None
    return False, read_held_until(held.get("held_until"))


def share_id_in(target: object) -> str | None:
    """The id of the share `target` names: a `Share`, or the URL of its page or
    embed, such as `https://developmentfinance.org/s/k3Qx8vTa`; None when it is
    neither."""
    if isinstance(target, Share):
        return target.id
    if isinstance(target, str):
        segments = urlsplit(target).path.rstrip("/").split("/")
        if (
            len(segments) >= 2
            and segments[-2] in _SHARE_PAGES
            and SHARE_ID.fullmatch(segments[-1])
        ):
            return segments[-1]
    return None


def share_id_of(target: object, caller: str) -> str:
    """The id of the share `target` names, as `share_id_in` reads it.

    Raises:
        InvalidRequestError: `target` names no share (`invalid_argument`).
    """
    if (share_id := share_id_in(target)) is not None:
        return share_id
    raise client_error(
        INVALID_ARGUMENT,
        "A share is named by the Share a share call returned, or its URL, such as "
        f"'https://developmentfinance.org/s/k3Qx8vTa', not {target!r}; "
        f"{caller}.share(cards, latest=True) makes one",
    )


# The text forms `as_of` takes, the same in both clients: a day, or an RFC 3339
# date-time with its offset, `T` and `Z` in either case.
# re.ASCII, so `\d` matches the ASCII digits alone, as JavaScript's does.
_AS_OF_DAY = re.compile(r"(\d{4})-(\d{2})-(\d{2})", re.ASCII)
_AS_OF_MOMENT = re.compile(
    r"(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?"
    r"(?:([Zz])|([+-])(\d{2}):(\d{2}))",
    re.ASCII,
)
# The last millisecond of a day, where a day read as a moment ends.
_DAY_END = time(23, 59, 59, 999_000)


def as_of_moment(as_of: object) -> tuple[datetime, date]:
    """The moment `as_of` names, to the millisecond, and its day.

    A date reads as the last millisecond of that day in UTC, so it names what
    the share showed on that day; a datetime must carry its time zone. Text is
    a day, `YYYY-MM-DD`, read as a date, or an RFC 3339 date-time with its
    offset, such as `2026-10-28T10:00:00Z`, whose day is the date it writes.
    The moment keeps milliseconds, as the TypeScript client's does.

    Raises:
        InvalidRequestError: `as_of` is none of those (`invalid_argument`).
    """
    if isinstance(as_of, str):
        as_of = _written_moment(as_of) or as_of
    if isinstance(as_of, datetime) and as_of.tzinfo is not None:
        return to_millisecond(as_of), as_of.date()
    if isinstance(as_of, date) and not isinstance(as_of, datetime):
        return datetime.combine(as_of, _DAY_END, tzinfo=UTC), as_of
    raise client_error(
        INVALID_ARGUMENT,
        "as_of is a date, a datetime with a time zone, a date such as "
        "'2026-10-28' or an RFC 3339 date-time such as '2026-10-28T10:00:00Z', "
        f"not {as_of!r}",
    )


def to_millisecond(moment: datetime) -> datetime:
    """`moment` without its digits past the millisecond, the precision both
    clients compare moments at."""
    return moment.replace(microsecond=moment.microsecond // 1000 * 1000)


def _written_moment(text: str) -> date | datetime | None:
    """`text` as a day, else an RFC 3339 date-time, else None when it is
    neither or names a day or time that does not exist."""
    if found := _AS_OF_DAY.fullmatch(text):
        with suppress(ValueError):
            return date(*map(int, found.groups()))
        return None
    found = _AS_OF_MOMENT.fullmatch(text)
    if found is None:
        return None
    year, month, day, hour, minute, second, fraction, utc, sign, *offset = (
        found.groups()
    )
    hours, minutes = (0, 0) if utc else map(int, offset)
    if minutes > 59:
        return None
    shift = timedelta(hours=hours, minutes=minutes) * (-1 if sign == "-" else 1)
    milliseconds = int((fraction or "").ljust(3, "0")[:3])
    with suppress(ValueError):
        return datetime(
            int(year),
            int(month),
            int(day),
            int(hour),
            int(minute),
            int(second),
            milliseconds * 1000,
            tzinfo=timezone(shift),
        )
    return None


def check_slot(slot: object) -> None:
    """Refuse a `slot` that is neither None nor a slot number from 1.

    Raises:
        InvalidRequestError: It is not (`invalid_argument`).
    """
    if slot is None or (
        isinstance(slot, int) and not isinstance(slot, bool) and slot >= 1
    ):
        return
    raise client_error(
        INVALID_ARGUMENT,
        "slot is numbered from 1, as a share's data URLs are, so slot=1 is the "
        f"first card, not {slot!r}",
    )


def chosen_slot(slot: int | None, count: int, share_id: str) -> int:
    """The slot a share fetch reads: `slot`, or the only one of a share of one.

    Raises:
        InvalidRequestError: The share has several slots and `slot` is None, or
            `slot` is past its last (`invalid_argument`).
    """
    if slot is None and count == 1:
        return 1
    if slot is not None and slot <= count:
        return slot
    held = f"Share {share_id} has {count} slot{'' if count == 1 else 's'}"
    if slot is not None:
        held += f" and no slot {slot}"
    picks = "slot=1" if count == 1 else f"slot=1 to slot={count}"
    raise client_error(
        INVALID_ARGUMENT,
        f"{held}; slots are numbered from 1 as its data URLs are, so pick one "
        f"with {picks}",
    )


def read_slot_count(reply: object, *, route: str) -> tuple[int, bool]:
    """The number of slots a share read lists, and whether the share is live.

    Raises:
        ContractError: The reply has no list of slots (`contract_violation`).
    """
    body = _object(reply, route, "")
    slots = body.get("slots")
    if not isinstance(slots, list):
        raise _violation(route, "/slots")
    return len(slots), body.get("mode") == "live"


def read_shown_card(
    reply: object, *, route: str
) -> tuple[tuple[str, str] | None, str | None]:
    """The frame a slot's card read is drawn on, as its spec id and version, or
    None for a card that draws no frame, such as a note; and the card's title.

    Raises:
        ContractError: The reply names no list of inputs, or several, or an
            input lacks its spec id or version (`contract_violation`).
    """
    body = _object(reply, route, "")
    payload = _object(body.get("resolved_payload"), route, "/resolved_payload")
    pointer = "/resolved_payload/provenance"
    inputs = _object(payload.get("provenance"), route, pointer).get("inputs")
    match inputs:
        case []:
            return None, card_title(body)
        case [entry]:
            at = f"{pointer}/inputs/0"
            frame = _object(entry, route, at)
            shown = (
                _text(frame, "spec_id", route, at),
                _text(frame, "content_version", route, at),
            )
            return shown, card_title(body)
        case _:
            raise _violation(route, f"{pointer}/inputs", "is not one frame")


def write_token_of(target: object, write_token: object) -> str | None:
    """The write token a change of `target` sends: `write_token` when given,
    else the token a `Share` carries, else None.

    Raises:
        InvalidRequestError: `write_token` is neither None nor non-empty text
            (`invalid_argument`).
    """
    if write_token is None:
        return target.write_token if isinstance(target, Share) else None
    if not isinstance(write_token, str) or not write_token:
        raise client_error(
            INVALID_ARGUMENT,
            "write_token is the shw_ token a share call returned, as text, not "
            f"{type(write_token).__name__}",
        )
    return write_token


def _object(value: object, route: str, pointer: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise _violation(route, pointer or "the body", "is not an object")
    return value


def _text(obj: Mapping[str, Any], key: str, route: str, pointer: str = "") -> str:
    value = obj.get(key)
    if not isinstance(value, str) or not value:
        raise _violation(route, f"{pointer}/{key}", "is not text")
    return value


def _count(
    obj: Mapping[str, Any], key: str, route: str, pointer: str = "", *, least: int = 1
) -> int:
    value = obj.get(key)
    if not isinstance(value, int) or isinstance(value, bool) or value < least:
        raise _violation(route, f"{pointer}/{key}", f"is not a count from {least}")
    return value


def _flag(obj: Mapping[str, Any], key: str, route: str, pointer: str = "") -> bool:
    value = obj.get(key)
    if not isinstance(value, bool):
        raise _violation(route, f"{pointer}/{key}", "is not true or false")
    return value


def _violation(route: str, pointer: str, fault: str = "is missing") -> ContractError:
    error = client_error(
        CONTRACT_VIOLATION, f"{route} answered a body whose {pointer} {fault}"
    )
    error.pointer = pointer
    return error
