"""The pieces of a dataset build that do no I/O, shared by both clients.

A build posts a spec to the datasets surface with a scope and a rendering, and
reads back a manifest or a long-build operation. This module writes those request
bodies, reads the operation resource, picks the artifact a manifest lists for the
client's rendering, and paces polls.
`dfo._datasets.fetch`, `dfo._datasets.resolve` and `dfo._datasets.operation` hold the
requests themselves.
"""

import inspect
import re
from collections.abc import Iterable, Iterator, Mapping, Sequence
from contextlib import nullcontext
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Protocol, TypeGuard

import httpx2

from dfo._core.codes import (
    CONTRACT_VIOLATION,
    INVALID_ARGUMENT,
    MATCH_UNRESOLVED,
    UNEXPECTED_RESPONSE,
)
from dfo._core.errors import client_error
from dfo._core.json_text import loads
from dfo._core.lookup_results import Entity, Match
from dfo._core.parse import (
    check_manifest,
    check_operation,
    read_assumption,
    read_items,
    read_requested_operation,
    violation,
)
from dfo._core.refusals import sent_key, trace_id_of
from dfo._core.text import capped, cited, quoted, redacted_json
from dfo._core.types import (
    CONTENT_VERSION,
    OPERATION_ID,
    Layout,
    Part,
    PriceBasis,
    Rendering,
    Spec,
    Window,
    Wire,
    matches,
)
from dfo._generated.file_selector import SELECTOR_QUERY_KEYS
from dfo._generated.role_keys import COLUMN_ROLE_KEYS, ROLE_KEYS
from dfo._http.hooks import Hold

# The longest the client reads a synchronous build. The server cuts off at 120 s.
BUILD_READ_TIMEOUT = 150.0

# Poll backoff when the server sends no pacing, doubling from the first to the cap.
POLL_BACKOFF_FIRST = 1.0
POLL_BACKOFF_CAP = 8.0

_LAYOUTS = ("long", "frame")

# The years a window range may name. The server takes any integer JSON carries
# exactly, and a year outside these builds an identity Search cannot resolve back.
WINDOW_FIRST_YEAR = 1000
WINDOW_LAST_YEAR = 2200

# Each wire role a caller key renames, such as observationAbout, with that key.
_WIRE_SPELLINGS = {wire: key for key, wire in ROLE_KEYS.items() if wire != key}

# The variable text an identity resubmit sends for a spec no answer part names;
# Search echoes it onto the part, and it does not change the sentence.
UNNAMED_PART = "dataset"

# A currency `fetch(currency=...)` takes: an ISO 4217 code, as the server reads it.
_CURRENCY = re.compile(r"[A-Z]{3}")

_PRICE_BASES: tuple[PriceBasis, ...] = ("current", "constant")


@dataclass(frozen=True, slots=True)
class Progress:
    """How far a long build has got, as the server last reported it.

    Attributes:
        rows_written: Rows the build has written so far.
        estimate_rows: The rows the server expects the build to write.
    """

    rows_written: int | None = None
    estimate_rows: int | None = None


@dataclass(frozen=True, slots=True)
class Reading:
    """One reading a fetch builds, with what it answers.

    Attributes:
        parts: The variable text of each answer part the reading answers, in
            query order; empty for a spec fetched outside an answer.
        spec: The reading to build.
        sentence: Search's sentence for the reading, when known.
        answer_parts: The answer parts the reading answers, whose departures and
            requested operations reach the dataset.
    """

    parts: tuple[str, ...]
    spec: Spec
    sentence: str | None = None
    answer_parts: tuple[Part, ...] = ()


class Cache(Protocol):
    """The local store a fetch reads before the network and writes after it."""

    def get_bytes(self, digest: str, /) -> bytes | None:
        """The bytes stored under `digest`, or None when absent or not hashing to it.

        A damaged entry reads as a miss, so the fetch downloads it again.
        """
        ...

    def put_bytes(
        self, digest: str, data: bytes, /, *, fetched_at: datetime | None = None
    ) -> None:
        """Store bytes already checked against `digest`, which left the server
        at `fetched_at`, an aware datetime, or at no recorded time."""
        ...

    def fetched_at(self, digest: str, /) -> datetime | None:
        """When the bytes stored under `digest` left the server, in UTC, or None
        when no time was recorded."""
        ...

    def discard(self, digest: str, /) -> None:
        """Remove the bytes stored under `digest`, which do not read as an artifact."""
        ...

    def downloading(
        self, digest: str, /, *, timeout: float | None = None
    ) -> Hold | nullcontext[None]:
        """Hold `digest`, sync or async, while one fetch reads, downloads and
        stores it, waiting up to `timeout` seconds."""
        ...

    def merging(
        self, spec_id: str, content_version: str, rendering: Rendering, /
    ) -> Hold | nullcontext[None]:
        """Hold one rendering of one version's manifest, among threads, while
        one fetch reads, merges and writes it."""
        ...

    def get_manifest(
        self, spec_id: str, content_version: str, rendering: Rendering, /
    ) -> dict[str, Any] | None:
        """The manifest stored for one rendering of one version, or None."""
        ...

    def put_manifest(
        self,
        spec_id: str,
        content_version: str,
        rendering: Rendering,
        manifest: Mapping[str, Any],
        /,
    ) -> None:
        """Store the manifest for one rendering of one version."""
        ...

    def manifest_candidates(
        self, spec_id: str, rendering: Rendering, /
    ) -> list[dict[str, Any]]:
        """Stored manifests for a spec and rendering, newest first."""
        ...


def rendering_for(layout: str, *, party_totals: bool) -> Rendering:
    """The bare Parquet rendering both clients build for `layout`, the party-totals
    cut unless `party_totals` keeps every total.

    Raises:
        InvalidRequestError: `layout` is neither `long` nor `frame`, or
            `party_totals` is not a bool.
    """
    if layout not in _LAYOUTS:
        raise client_error(
            INVALID_ARGUMENT, f'layout is "long" or "frame", not {layout!r}'
        )
    if not isinstance(party_totals, bool):
        raise client_error(
            INVALID_ARGUMENT, f"party_totals is True or False, not {party_totals!r}"
        )
    return Rendering(
        "parquet",
        False,
        "frame" if layout == "frame" else None,
        without_party_totals=not party_totals,
    )


def check_strict(strict: object) -> None:
    """Refuse a `strict` that is not a bool.

    Raises:
        InvalidRequestError: It is not (`invalid_argument`).
    """
    if not isinstance(strict, bool):
        raise client_error(INVALID_ARGUMENT, f"strict is True or False, not {strict!r}")


def layout_of(rendering: Rendering) -> Layout:
    """The layout a bare Parquet rendering holds."""
    return "frame" if rendering.layout == "frame" else "long"


def file_params(rendering: Rendering) -> dict[str, Any]:
    """The file selector's query for `rendering`: its members among
    `SELECTOR_QUERY_KEYS`, layout only when set.

    The selector serves a stored version, which is already the party-totals cut
    or the plain version, and refuses any other key as `request_invalid`.
    """
    obj = rendering.to_object()
    return {key: obj[key] for key in SELECTOR_QUERY_KEYS if key in obj}


def scope(
    *,
    window: Window | None = None,
    entities: Mapping[str, Sequence[str]] | None = None,
    facets: Mapping[str, str | None] | None = None,
) -> dict[str, Any] | None:
    """The build request's `scope` for the narrowing a fetch asks for.

    Args:
        window: `"all"`, `"latest"` or `(start_year, end_year)`.
        entities: Role names bound to dcids, such as `{"destination": ["country/NGA"]}`.
        facets: Facet axes (`provenance`, `measurementMethod`, `unit`) bound to a
            ref; None binds the facets that declare no value on the axis. An
            empty map names no axis.

    Returns:
        The scope object, or None when the fetch narrows nothing.

    Raises:
        InvalidRequestError: The window is neither a known kind nor a pair of
            years from `WINDOW_FIRST_YEAR` to `WINDOW_LAST_YEAR`, start first;
            `entities` is not a map of role names to non-empty sequences of
            dcids; or `facets` is not a map of axis names to refs or None
            (`invalid_argument`).
    """
    result: dict[str, Any] = {}
    if window is not None:
        result["window"] = _window(window)
    if entities is not None:
        result["entities"] = _entities(entities)
    if facets is not None and _names("facets", facets):
        result["facets"] = {
            axis: {"ref": _ref(axis, ref)} for axis, ref in facets.items()
        }
    return result or None


type Bound = str | Entity | Match
"""What a role binds: a dcid, or an entity or match `lookup.resolve` returned."""

type RoleBinding = (
    list[str] | list[Entity] | list[Match] | list[Bound] | tuple[Bound, ...]
)
"""What a fetch binds one role to. A list of one kind is spelled out, since a
`list[Match]` from `lookup.resolve` is no `list[Bound]` to a type checker."""

type Entities = Mapping[str, RoleBinding | None]
"""A fetch's `entities`: caller role keys, such as `place`, bound to dcids or to
what `lookup.resolve` returns, or to None to drop the role."""


type ListedEntities = Mapping[str, list[Bound] | None]
"""`entities` once `listed_entities` has read each role's sequence or iterator
into a list."""

type DcidEntities = Mapping[str, list[str] | None]
"""`entities` once `dcid_entities` has replaced each entity and match by its dcid."""


def listed_entities(entities: Entities | None) -> ListedEntities | None:
    """`entities` with each role's sequence or one-shot iterator, such as a
    generator, read into a list once, so the role can be read more than once.
    Text, bytes, values that are not iterable and a value that is not a map pass
    through, for `scope` to refuse.

    Raises:
        InvalidRequestError: A role is bound to a set, a map, a map's view or
            another collection with no fixed order, whose entities would post in
            an order that changes between runs (`invalid_argument`).
    """
    if not isinstance(entities, Mapping):
        return entities
    listed: dict[str, Any] = {}
    for role, bound in entities.items():
        if isinstance(bound, str | bytes) or not isinstance(bound, Iterable):
            listed[role] = bound
        elif isinstance(bound, Sequence | Iterator):
            listed[role] = list(bound)
        else:
            raise client_error(
                INVALID_ARGUMENT,
                f"entities[{role!r}] is a {type(bound).__name__}, whose order is not "
                "fixed; bind the role to a list of its entities in the order you "
                "mean, such as ['country/KEN', 'country/NGA']",
            )
    return listed


def dcid_entities(entities: ListedEntities | None) -> DcidEntities | None:
    """`entities`, as `listed_entities` gives them, with each `Entity` and
    resolved `Match` replaced by its dcid. A value that is not a list passes
    through, for `scope` to refuse.

    Raises:
        InvalidRequestError: A match did not resolve: it is ambiguous, found
            nothing, or names a node the graph does not hold
            (`match_unresolved`); or a role holds an awaitable, such as
            `AsyncClient.lookup.resolve(...)` without its `await`
            (`invalid_argument`). The message names the role, the text and what
            to pass instead.
    """
    if not isinstance(entities, Mapping):
        return entities
    for role, bound in entities.items():
        for each in bound if isinstance(bound, list) else (bound,):
            if inspect.isawaitable(each):
                if inspect.iscoroutine(each):
                    each.close()  # it never runs, so Python need not warn
                raise client_error(
                    INVALID_ARGUMENT,
                    f"entities[{role!r}] holds an awaitable, not what it returns. "
                    "Await client.lookup.resolve(...) before passing its result.",
                )
    dcids: dict[str, Any] = {
        role: (
            [_dcid(role, each) for each in bound] if isinstance(bound, list) else bound
        )
        for role, bound in entities.items()
    }
    return dcids


def _dcid(role: object, bound: object) -> Any:
    """The dcid `bound` names when it is an `Entity` or a resolved `Match`; any
    other value as it is."""
    if isinstance(bound, Entity):
        return bound.dcid
    if not isinstance(bound, Match):
        return bound
    if bound.status == "resolved" and bound.entity is not None:
        return bound.entity.dcid
    others = bound.candidates or bound.near_matches
    fix = (
        f"pass the dcid you mean, such as {cited(others[0].dcid)}"
        if others
        else "resolve another name, or pass a dcid"
    )
    raise client_error(
        MATCH_UNRESOLVED,
        f"entities[{role!r}] holds a match that did not resolve: {bound}. Bind "
        f"the role to a resolved match only; {fix}.",
    )


@dataclass(frozen=True, slots=True)
class Asked:
    """The values a caller's narrowing names, which a build's refusal answers.

    Attributes:
        dcids: The dcids the caller bound its roles to, stripped, in role order.
        refs: The refs the caller bound its facet axes to.
    """

    dcids: tuple[str, ...] = ()
    refs: tuple[str, ...] = ()


# What a fetch with no narrowing names.
NOTHING_ASKED = Asked()


def asked(
    *,
    entities: DcidEntities | None = None,
    facets: Mapping[str, str | None] | None = None,
) -> Asked:
    """The values a narrowing `scope` has accepted, for a refusal's hints."""
    dcids = [
        dcid for given in (entities or {}).values() for dcid in dcids_of(given) or ()
    ]
    refs = [ref for ref in (facets or {}).values() if isinstance(ref, str) and ref]
    return Asked(tuple(dcids), tuple(refs))


def rebind(spec: Spec, entities: DcidEntities) -> dict[str, Sequence[str]]:
    """The whole entity binding a fetch posts, the spec's own with `entities` applied.

    The server replaces a spec's entire binding with the posted one, so the
    client starts from the roles the spec's definition binds and changes only
    the roles `entities` names, each caller key posted as its wire role, so
    `place` as `observationAbout`. A role bound to None is dropped.

    Raises:
        InvalidRequestError: `entities` is not a map of role names, or the
            spec's definition holds no `identity` object (`invalid_argument`).
    """
    _names("entities", entities)
    identity = spec.definition.get("identity")
    if not isinstance(identity, Mapping):
        raise client_error(
            INVALID_ARGUMENT,
            f"The definition of {spec.spec_id} holds no identity to rebind; use a "
            "spec from a search, such as answer.specs[0], or a saved dataset's "
            "data.members[0].spec",
        )
    bound: dict[str, Sequence[str]] = dict(identity.get("entities", {}))
    for key, dcids in entities.items():
        role = ROLE_KEYS.get(key, key)
        if dcids is None:
            bound.pop(role, None)
        else:
            bound[role] = dcids
    return bound


def narrowings(
    readings: Sequence[Reading],
    *,
    window: Window | None = None,
    entities: DcidEntities | None = None,
    facets: Mapping[str, str | None] | None = None,
) -> list[dict[str, Any] | None]:
    """Each reading's build `scope`, in reading order: one narrowing applied to
    every reading, with `entities` rebound on each reading's own binding.

    Raises:
        InvalidRequestError: The narrowing is malformed, as `scope` refuses it;
            `entities` names a role a reading does not declare; or a reading's
            definition holds no identity to rebind (`invalid_argument`).
    """
    if entities:
        _names("entities", entities)
        for role in entities:
            _check_role(role, readings)
    return [
        scope(
            window=window,
            entities=rebind(reading.spec, entities) if entities else None,
            facets=facets,
        )
        for reading in readings
    ]


def _check_role(role: str, readings: Sequence[Reading]) -> None:
    """Refuse a role key one of `readings` does not declare, naming each
    reading's role keys. A reading whose definition names no role is left to
    the server, since the client cannot tell which roles it takes. A wire role
    a caller key renames, such as `observationAbout`, is refused naming that
    key when every reading takes it or names no role."""
    key = _WIRE_SPELLINGS.get(role)
    if key is not None and all(
        not (roles := reading.spec.roles) or key in roles for reading in readings
    ):
        raise client_error(
            INVALID_ARGUMENT,
            f"entities names {cited(role)}, the wire name of {cited(key)}; "
            f"key it as {cited(key)}.",
        )
    lacking = [
        reading
        for reading in readings
        if (roles := reading.spec.roles) and role not in roles
    ]
    if not lacking:
        return
    if len(readings) == 1:
        raise client_error(
            INVALID_ARGUMENT,
            f"entities names {cited(role)}, a role {_reading_name(lacking[0])} "
            f"does not declare; its roles are {_role_keys(lacking[0])}.",
        )
    names = " and ".join(_reading_name(reading) for reading in lacking)
    listed = "\n  ".join(
        f"{_reading_name(reading)}: {_role_keys(reading)}" for reading in readings
    )
    raise client_error(
        INVALID_ARGUMENT,
        f"entities names {cited(role)}, a role {names} "
        f"{'does' if len(lacking) == 1 else 'do'} not declare. Each part's "
        f"roles:\n  {listed}",
    )


def _reading_name(reading: Reading) -> str:
    """A reading as a refusal names it: its parts' words, else `the spec`."""
    return " / ".join(cited(part) for part in reading.parts) or "the spec"


def _role_keys(reading: Reading) -> str:
    return ", ".join(reading.spec.roles) or "none stated"


def _window(window: Window) -> dict[str, Any]:
    if window in ("all", "latest"):
        return {"kind": window}
    match window:
        case (start, end) if _is_year(start) and _is_year(end):
            if start < WINDOW_FIRST_YEAR or end > WINDOW_LAST_YEAR:
                raise client_error(
                    INVALID_ARGUMENT,
                    f"window years run from {WINDOW_FIRST_YEAR} to "
                    f"{WINDOW_LAST_YEAR}, not {cited(window)}.",
                )
            if start > end:
                raise client_error(
                    INVALID_ARGUMENT,
                    "window is (start_year, end_year), start_year first, not "
                    f"{cited(window)}.",
                )
            return {"kind": "range", "start_year": start, "end_year": end}
    year = _one_year(window)
    hint = "." if year is None else f"; for one year use window=({year}, {year})."
    raise client_error(
        INVALID_ARGUMENT,
        f'window is "all", "latest" or (start_year, end_year), not '
        f"{cited(window)}{hint}",
    )


def _is_year(value: object) -> TypeGuard[int]:
    """Whether `value` is an integer, which a bool is not."""
    return isinstance(value, int) and not isinstance(value, bool)


def _one_year(window: object) -> int | None:
    """The year a window names on its own: an integer, a string of up to four
    digits, or a list or tuple of one."""
    only = (
        window[0] if isinstance(window, list | tuple) and len(window) == 1 else window
    )
    if _is_year(only):
        return only
    if isinstance(only, str) and re.fullmatch(r"[0-9]{1,4}", only):
        return int(only)
    return None


def _names(argument: str, value: object) -> Mapping[str, object]:
    """`value` when it is a map keyed by non-empty names, such as role names.

    Raises:
        InvalidRequestError: It is not (`invalid_argument`).
    """
    if not isinstance(value, Mapping):
        raise client_error(
            INVALID_ARGUMENT,
            f"{argument} is a map of names, such as {{'recipient': ...}}, not "
            f"{value!r}",
        )
    for name in value:
        if not isinstance(name, str) or not name:
            raise client_error(
                INVALID_ARGUMENT, f"{argument} names a key {name!r}; a key is a name"
            )
    return value


def _entities(entities: Mapping[str, Sequence[str]]) -> dict[str, list[str]]:
    bound = {}
    for role, dcids in _names("entities", entities).items():
        if isinstance(dcids, str):
            raise client_error(
                INVALID_ARGUMENT,
                f"entities[{role!r}] is a string; bind the role to a list of dcids, "
                f"such as [{dcids!r}]",
            )
        listed = dcids_of(dcids)
        if listed is None:
            raise client_error(
                INVALID_ARGUMENT,
                f"entities[{role!r}] is a list of dcids, such as ['country/NGA'], "
                f"not {dcids!r}; bind the role to None to drop it",
            )
        bound[role] = listed
    return bound


def dcids_of(value: object) -> list[str] | None:
    """A role's dcids, each without surrounding white space, which no dcid holds;
    None unless `value` is a non-empty sequence of strings that are not empty once
    stripped."""
    if isinstance(value, str) or not isinstance(value, Iterable):
        return None
    dcids = [dcid.strip() if isinstance(dcid, str) else "" for dcid in value]
    return dcids if dcids and all(dcids) else None


def _ref(axis: str, ref: object) -> str | None:
    if ref is None or (isinstance(ref, str) and ref):
        return ref
    raise client_error(
        INVALID_ARGUMENT,
        f"facets[{axis!r}] is a ref or None, not {ref!r}",
    )


def build_body(
    spec: Spec, rendering: Rendering, narrowing: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    """The `POST /datasets` body that builds `spec`'s latest version.

    The body always carries the spec's unmodified definition, so a spec the
    server has not registered still builds.
    """
    built: dict[str, Any] = {
        "kind": "spec_id",
        "spec_id": spec.spec_id,
        "definition": spec.definition,
    }
    if narrowing is not None:
        built["scope"] = narrowing
    return {
        "schema_version": 1,
        "input": built,
        "options": rendering.to_options(),
    }


def scoped_identity(
    identity: Mapping[str, Any], narrowing: Mapping[str, Any] | None
) -> dict[str, Any]:
    """`identity` with a build `scope` from `narrowing` applied, as the datasets
    mint applies it before it puts the identity in canonical form.

    Each member the scope supplies replaces the identity's own whole: `window`
    becomes `requested_window`, `entities` the whole binding, and `facets`
    every facet binding, each ref as `{"state": "value", "ref": ref}`. A flow
    role the scope binds, under its wire role or a frame role column such as
    `recipient`, leaves `open_roles`, which goes when none stays.
    """
    scoped = dict(identity)
    if narrowing is None:
        return scoped
    if (entities := narrowing.get("entities")) is not None:
        scoped["entities"] = {role: list(dcids) for role, dcids in entities.items()}
        bound = {COLUMN_ROLE_KEYS.get(role, role) for role in entities}
        left = [role for role in identity.get("open_roles") or () if role not in bound]
        if left:
            scoped["open_roles"] = left
        else:
            scoped.pop("open_roles", None)
    if (window := narrowing.get("window")) is not None:
        scoped["requested_window"] = dict(window)
    if (facets := narrowing.get("facets")) is not None:
        scoped["facets"] = {
            axis: {"state": "value", "ref": binding["ref"]}
            for axis, binding in facets.items()
        }
    return scoped


def _kept_entity_groups(held: Spec | None, built: Wire) -> dict[str, Any]:
    """The held spec's entity groups that hold for a built definition.

    A role keeps its group when the built identity binds it to the same entities
    as `held`'s definition, so a window or facets narrowing keeps every group and
    a role that `entities` rebound or dropped loses its group. The server drops a
    posted group whose members differ from the role's entities.
    """
    if held is None or not held.entity_groups:
        return {}
    before = held.definition["identity"].get("entities", {})
    after = built["identity"].get("entities", {})
    return {
        role: group
        for role, group in held.entity_groups.items()
        if role in after and set(after[role]) == set(before.get(role, ()))
    }


def resubmit_body(
    built: Wire,
    variable_text: str,
    held: Spec | None = None,
    echoed: Part | None = None,
) -> dict[str, Any]:
    """The Search request that re-resolves one built definition for its sentence.

    `held` is the spec the client built from, None for a resumed build. Its
    groups that `_kept_entity_groups` keeps go with the identity, so a group of
    places reads the same way again. `echoed` is the answer part a converted
    reading answers, whose members `echoed_reading` gives go with the entry as
    they went with the conversion's, or None to echo none.
    """
    entry: dict[str, Any] = {
        "entry_kind": "identity",
        "variable_text": variable_text,
        "identity": built["identity"],
    }
    if groups := _kept_entity_groups(held, built):
        entry["entity_groups"] = groups
    if echoed is not None:
        entry |= echoed_reading(echoed)
    return {
        "schema_version": 1,
        "input": {"kind": "dataset_resubmit", "entries": [entry]},
    }


@dataclass(frozen=True, slots=True)
class UnitRequest:
    """The currency and price basis a fetch converts its readings to.

    Attributes:
        currency: The ISO 4217 code, such as `EUR`.
        price_basis: `current` or `constant`.
        base_year: The base year of constant prices, or None for current prices.
    """

    currency: str
    price_basis: PriceBasis
    base_year: int | None = None

    def to_wire(self) -> dict[str, Any]:
        """The request as the unit facet of an identity holds it, with
        `price_basis` under its wire name `prices`."""
        wire: dict[str, Any] = {"currency": self.currency, "prices": self.price_basis}
        if self.base_year is not None:
            wire["base_year"] = self.base_year
        return wire


def unit_request(
    *,
    currency: object,
    price_basis: object,
    base_year: object,
    facets: object = None,
) -> UnitRequest | None:
    """The conversion a fetch's `currency`, `price_basis` and `base_year` ask
    for, or None when `currency` is None and so are the other two.

    Raises:
        InvalidRequestError: `price_basis` or `base_year` is given without
            `currency`; `currency` is not three capital letters; `price_basis`
            is neither `current` nor `constant`; `base_year` is not an int, is
            missing for constant prices or is given for current ones; or
            `facets` binds the unit as well (`invalid_argument`).
    """
    if currency is None:
        if price_basis is not None or base_year is not None:
            raise client_error(
                INVALID_ARGUMENT,
                "price_basis and base_year convert to a currency; name it as well, "
                'such as currency="EUR"',
            )
        return None
    if not isinstance(currency, str) or not _CURRENCY.fullmatch(currency):
        raise client_error(
            INVALID_ARGUMENT,
            "currency is an ISO 4217 code of three capital letters, such as "
            f'"EUR", not {_shown(currency)}',
        )
    if price_basis is None:
        price_basis = "current"
    if price_basis not in _PRICE_BASES:
        raise client_error(
            INVALID_ARGUMENT,
            f'price_basis is "current" or "constant", not {_shown(price_basis)}',
        )
    if base_year is not None and (
        not isinstance(base_year, int) or isinstance(base_year, bool)
    ):
        raise client_error(
            INVALID_ARGUMENT,
            f"base_year is a year as an int, such as 2022, not {_shown(base_year)}",
        )
    if price_basis == "constant" and base_year is None:
        raise client_error(
            INVALID_ARGUMENT,
            'price_basis="constant" takes a base_year, such as base_year=2022; '
            "spec.unit_conversion.default_base_year names the one Search reads by "
            "default, and each currency's base_years the range it converts at",
        )
    if price_basis == "current" and base_year is not None:
        raise client_error(
            INVALID_ARGUMENT,
            'base_year goes with price_basis="constant"; current prices convert '
            "each year at its own rate and take none",
        )
    if isinstance(facets, Mapping) and "unit" in facets:
        raise client_error(
            INVALID_ARGUMENT,
            'facets["unit"] and currency both set the unit; pass one of them',
        )
    return UnitRequest(
        currency,
        "constant" if price_basis == "constant" else "current",
        base_year,
    )


def _shown(value: object, /) -> str:
    """A caller's value as a refusal quotes it, cut to `MESSAGE_TEXT_MAX`
    characters."""
    return cited(capped(value)) if isinstance(value, str) else capped(cited(value))


@dataclass(frozen=True, slots=True)
class Converting:
    """One entry a conversion posts.

    Attributes:
        reading: The reading the entry converts.
        part: The answer part it stands for, or None for a spec fetched outside
            an answer.
        narrowing: The reading's build `scope`, which the entry's identity
            applies, or None when the fetch narrows nothing.
    """

    reading: Reading
    part: Part | None
    narrowing: Mapping[str, Any] | None = None


def converted_parts(
    readings: Sequence[Reading],
    scopes: Sequence[Mapping[str, Any] | None],
    /,
) -> list[Converting]:
    """What a conversion posts one entry each for, in reading order: each
    reading's answer parts, else the reading alone with no part, for a spec
    fetched outside an answer, each with its reading's scope from `scopes`."""
    return [
        Converting(reading, part, narrowing)
        for reading, narrowing in zip(readings, scopes, strict=True)
        for part in reading.answer_parts or (None,)
    ]


def conversion_body(
    posted: Sequence[Converting], request: UnitRequest
) -> dict[str, Any]:
    """The Search request that converts each reading to `request`: one identity
    entry per `Converting`, in order, its identity narrowed by its scope as
    `scoped_identity` narrows it and its unit facet set to the request, so
    Search judges the years and places the build reads.

    Each entry carries the spec's entity groups that hold for the narrowed
    identity, as `resubmit_body` does, and names its answer part's variable
    text, else the reading's first part, else `UNNAMED_PART`. An answer part's
    entry also echoes its `separate` flag when true, its `operations` when any item
    reads, and its `assumptions` when it holds a list, in the read forms a
    choice posts, so Search states for the converted part the assumptions that
    still hold and keeps the operations and the folding the question asked for.

    Raises:
        InvalidRequestError: A reading's definition holds no identity object
            (`invalid_argument`).
    """
    entries = []
    unit = {"state": "value", "request": request.to_wire()}
    for each in posted:
        reading, part = each.reading, each.part
        spec = reading.spec
        held = spec.definition.get("identity")
        if not isinstance(held, Mapping):
            raise client_error(
                INVALID_ARGUMENT,
                f"The definition of {spec.spec_id} holds no identity to convert; use "
                "a spec from a search, such as answer.specs[0], or a saved "
                "dataset's data.members[0].spec",
            )
        identity = scoped_identity(held, each.narrowing)
        facets = identity.get("facets")
        identity["facets"] = {
            **(facets if isinstance(facets, Mapping) else {}),
            "unit": unit,
        }
        entry: dict[str, Any] = {
            "entry_kind": "identity",
            "variable_text": _variable_text(reading, part),
            "identity": identity,
        }
        if groups := _kept_entity_groups(spec, {"identity": identity}):
            entry["entity_groups"] = groups
        if part is not None:
            entry |= echoed_reading(part)
        entries.append(entry)
    return {
        "schema_version": 1,
        "input": {"kind": "dataset_resubmit", "entries": entries},
        "response_options": {"include_observations": False},
    }


def _variable_text(reading: Reading, part: Part | None, /) -> str:
    """The variable text an entry names: its answer part's, else the reading's
    first part's, else `UNNAMED_PART`."""
    if part is not None:
        return part.variable_text or UNNAMED_PART
    return reading.parts[0] if reading.parts else UNNAMED_PART


def echoed_reading(part: Part, /) -> dict[str, Any]:
    """The members an identity entry echoes from the answer part it stands for:
    `separate` when true, `operations` when any item reads, and `assumptions`
    when the part holds a list, in the read forms a choice posts."""
    echoed: dict[str, Any] = {}
    if part.separate:
        echoed["separate"] = True
    if operations := read_items(part.raw.get("operations"), read_requested_operation):
        echoed["operations"] = operations
    if isinstance(assumptions := part.raw.get("assumptions"), list):
        echoed["assumptions"] = read_items(assumptions, read_assumption)
    return echoed


def pick_artifact(
    manifest: Wire, rendering: Rendering, *, digest: str | None = None
) -> Wire | None:
    """The artifact a manifest lists for `rendering`, with `digest` when given.

    Artifacts match on `Rendering.matches`, so the first artifact of the
    selector's format, bundle and layout is the one.
    """
    for artifact in manifest["artifacts"]:
        if digest is not None and artifact["artifact_digest"] != digest:
            continue
        if isinstance(artifact["rendering"], Mapping) and rendering.matches(
            artifact["rendering"]
        ):
            return artifact
    return None


def lists_digest(manifest: Wire, digest: str) -> bool:
    """Whether a manifest lists an artifact with `digest`, in any rendering."""
    return any(
        artifact["artifact_digest"] == digest for artifact in manifest["artifacts"]
    )


# The statuses an operation resource holds. The contract's enum is closed.
OPERATION_STATUSES = frozenset({"pending", "running", "done", "failed"})


@dataclass(frozen=True, slots=True)
class OperationState:
    """One reading of a long-build operation resource.

    Attributes:
        operation_id: The operation's id, `op_` and 64 hex digits.
        status: `pending`, `running`, `done` or `failed`.
        retry_after: The wait before the next poll the resource asks for, in
            seconds, or None.
        progress: The progress the resource reports, or None.
        manifest: The manifest, once the build is done.
        error: The problem document of a failed build, when the resource holds one.
    """

    operation_id: str
    status: str
    retry_after: float | None
    progress: Progress | None
    manifest: Wire | None
    error: Wire | None


def read_operation(resource: Wire, *, key: str | None = None) -> OperationState:
    """Read an operation resource.

    A message that quotes the resource's text has `key`, the client's key,
    redacted, and quotes at most `MESSAGE_TEXT_MAX` characters of it.

    Raises:
        ContractError: The operation's status is missing or outside `pending`,
            `running`, `done` and `failed`, its id is not `op_` and 64
            lowercase hex digits, a done operation holds no manifest that
            `check_served_manifest` passes, or a failed operation's error gives
            a `status` that is not an integer from 400 to 599
            (`contract_violation`). The id is checked before any poll names it
            in a path.
    """
    check_operation(resource)
    operation = resource["operation"]
    operation_id = operation["operation_id"]
    if not matches(OPERATION_ID, operation_id):
        raise violation(
            "The operation's id is not op_ and 64 lowercase hex digits",
            pointer="/operation/operation_id",
        )
    status = operation["status"]
    if status not in OPERATION_STATUSES:
        raise violation(
            f"The operation {operation_id} has the status {quoted(status, key)}, not "
            "pending, running, done or failed",
            pointer="/operation/status",
        )
    manifest = resource.get("manifest")
    if status == "done":
        check_served_manifest(manifest, "/manifest")
    wait = operation.get("retry_after_ms")
    progress = operation.get("progress")
    error = resource.get("error")
    if (
        status == "failed"
        and isinstance(error, Mapping)
        and "status" in error
        and not _is_error_status(error["status"])
    ):
        raise violation(
            f"The failed operation {operation_id} gives its error the status "
            f"{quoted(error['status'], key)}, not an integer from 400 to 599",
            pointer="/error/status",
        )
    return OperationState(
        operation_id=operation["operation_id"],
        status=status,
        retry_after=wait / 1000
        if isinstance(wait, int | float) and not isinstance(wait, bool) and wait >= 0
        else None,
        progress=_progress(progress) if isinstance(progress, Mapping) else None,
        manifest=manifest if isinstance(manifest, Mapping) else None,
        error=error if isinstance(error, Mapping) else None,
    )


def _is_error_status(value: object) -> bool:
    """Whether `value` is a refusal's HTTP status, an integer from 400 to 599."""
    return type(value) is int and 400 <= value <= 599


def _progress(progress: Wire) -> Progress:
    def count(name: str) -> int | None:
        value = progress.get(name)
        return value if isinstance(value, int) and not isinstance(value, bool) else None

    return Progress(count("rows_written"), count("estimate_rows"))


def poll_backoff(step: int) -> float:
    """The wait before poll `step` (from 0) when the server sends no pacing."""
    return min(POLL_BACKOFF_FIRST * 2**step, POLL_BACKOFF_CAP)


def counted_rows(manifest: Wire) -> int:
    """The rows a manifest's coverage counts, or 0 when it counts none or says no
    count."""
    coverage = manifest.get("coverage")
    rows = coverage.get("rows") if isinstance(coverage, Mapping) else None
    return rows if type(rows) is int and rows > 0 else 0


def check_served_manifest(manifest: object, pointer: str = "", /) -> None:
    """Check a manifest as `check_manifest` does, and that its `content_version`
    is a version id a ref and a cache path can hold.

    Args:
        manifest: The decoded manifest.
        pointer: The manifest's JSON Pointer in the response body.

    Raises:
        ContractError: `check_manifest` refuses it, or its `content_version` is
            not `cv_` and 32 lowercase hex digits (`contract_violation`).
    """
    check_manifest(manifest, pointer)
    assert isinstance(manifest, Mapping)
    if not matches(CONTENT_VERSION, manifest["content_version"]):
        raise violation(
            "The manifest's content_version is not cv_ and 32 lowercase hex digits",
            pointer=f"{pointer}/content_version",
        )


# The forms `read_held_until` reads, as the TypeScript client's `heldUntilOf`
# reads them: a date, `2026-11-18`, or a date-time with seconds, an optional
# fraction and an optional `Z` or `±HH:MM` offset, `2026-11-18T23:30:00.5-05:00`.
_HELD_UNTIL = re.compile(
    r"([0-9]{4})-([0-9]{2})-([0-9]{2})"
    r"(?:T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?"
    r"(?:Z|[+-]([0-9]{2}):([0-9]{2}))?)?"
)


def read_held_until(value: object) -> date | None:
    """A retention's `held_until` as the date it writes, in its own offset, or
    None when it is no string, is in another form than `_HELD_UNTIL`, or names
    a date or time that does not exist, as `2026-02-30` or `T25:00:00`."""
    if not isinstance(value, str) or (found := _HELD_UNTIL.fullmatch(value)) is None:
        return None
    # An absent time or offset reads as 0, which is in range.
    year, month, day, hour, minute, second, offset_hour, offset_minute = (
        int(group or 0) for group in found.groups()
    )
    if (
        hour > 23
        or minute > 59
        or second > 59
        or offset_hour > 23
        or offset_minute > 59
    ):
        return None
    try:
        return date(year, month, day)
    except ValueError:
        return None


def check_built(
    manifest: Wire, spec_id: str, content_version: str | None = None
) -> None:
    """Check a manifest names the spec it was asked for, and the version when
    `content_version` names one. A rebuild asks for no version.

    Raises:
        ContractError: The manifest names another spec or version.
    """
    built_spec, built_version = (
        manifest["definition"]["spec_id"],
        manifest["content_version"],
    )
    if built_spec != spec_id or content_version not in (None, built_version):
        asked = (
            spec_id if content_version is None else f"{spec_id} at {content_version}"
        )
        raise client_error(
            CONTRACT_VIOLATION,
            f"The server answered {built_spec} at {built_version} for {asked}",
        )


def response_json(response: httpx2.Response) -> Any:
    """The decoded JSON body of a response the client acts on, with the key its
    request carried redacted in every string and member name.

    Raises:
        ContractError: The body is not JSON.
    """
    try:
        body = loads(response.content)
    except ValueError as error:  # not JSON, or nested past JSON_MAX_DEPTH
        raise client_error(
            UNEXPECTED_RESPONSE,
            f"{response.request.method} {response.request.url.path} answered "
            f"HTTP {response.status_code} with a body that is not JSON",
            status=response.status_code,
            trace_id=trace_id_of(response),
        ) from error
    return redacted_json(body, sent_key(response))
