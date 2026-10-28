"""What cards and shares are: the values `dfo.cards`, `dfo.share` and
`dfo.history` return, and how the client reads them from DFO's replies.

A `Card` is one chart, table, headline number or source note DFO stores and
draws from one frame. A `Share` publishes cards under one `/s/<id>` link, one
card per numbered slot: a live share follows new data and takes new cards under
the same URLs, and a snapshot keeps the versions its cards drew when it was
made. A `Served` is one frame a share's slot served, as `dfo.history` lists it.

A card's and a share's write tokens grant changing them, so each value carries
its token and prints without it. Every value here is plain data with no client,
so it pickles and compares like any frozen dataclass.

This module is sync and shared by both clients.
"""

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Literal, override
from urllib.parse import urlsplit

from dfo._core.codes import CONTRACT_VIOLATION, INVALID_ARGUMENT
from dfo._core.errors import ContractError, client_error
from dfo._core.refs import DatasetRef
from dfo._core.text import single_line
from dfo._core.types import clipped
from dfo._datasets.build import read_held_until
from dfo._datasets.dataset import Dataset

type CardKind = Literal["line", "bar", "table", "stat", "source"]
"""What a card draws: a line chart, a bar chart, a table, a headline number, or
the source and citation of its data."""

type Source = Dataset | DatasetRef
"""What a card draws: a Dataset, or a ref of one version."""

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
    it pins the version it draws.

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
    """

    id: str
    revision: int
    kind: CardKind
    ref: DatasetRef
    title: str | None
    write_token: str = field(repr=False)

    @override
    def __repr__(self) -> str:
        (member,) = self.ref.members
        title = f', "{clipped(self.title)}"' if self.title else ""
        return single_line(
            f"Card({self.kind} {self.id}{title}, draws {member.spec.spec_id} at "
            f"{member.content_version})"
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
            the share is made, so keep it as a secret; the repr leaves it out.
            None when this value was built without it.
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


def _day(day: date) -> str:
    return f"{day.day} {_MONTHS[day.month - 1]} {day.year}"


def read_card(reply: object, *, route: str, kind: CardKind, ref: DatasetRef) -> Card:
    """The card a create reply names.

    Raises:
        ContractError: The reply lacks the card's id, revision or write token
            (`contract_violation`).
    """
    body = _object(reply, route, "")
    return Card(
        _text(body, "component_id", route),
        _count(body, "revision", route),
        kind,
        ref,
        _card_title(body),
        _text(body, "write_token", route),
    )


def _card_title(body: Mapping[str, Any]) -> str | None:
    """The title the reply's drawn card shows, or None when it shows none."""
    payload = body.get("resolved_payload")
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
    retention = entry.get("retention")
    # DFO answers no retention for a frame it holds no record of.
    held = (
        {"pinned": False}
        if retention is None
        else _object(retention, route, f"{pointer}/retention")
    )
    pinned = _flag(held, "pinned", route, f"{pointer}/retention")
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
        None if pinned else read_held_until(held.get("held_until")),
        _flag(entry, "fetchable", route, pointer),
    )


def share_id_of(target: object, caller: str) -> str:
    """The id of the share `target` names: a `Share`, or the URL of its page or
    embed, such as `https://developmentfinance.org/s/k3Qx8vTa`.

    Raises:
        InvalidRequestError: `target` is neither (`invalid_argument`).
    """
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
    raise client_error(
        INVALID_ARGUMENT,
        "A share is named by the Share a share call returned, or its URL, such as "
        f"'https://developmentfinance.org/s/k3Qx8vTa', not {target!r}; "
        f"{caller}.share(cards, latest=True) makes one",
    )


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


def _count(obj: Mapping[str, Any], key: str, route: str, pointer: str = "") -> int:
    value = obj.get(key)
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise _violation(route, f"{pointer}/{key}", "is not a count from 1")
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
