"""A search by publisher series codes: the parsed input it posts and the checks on
Search's answer.

`parsed_input` builds one part per code, so each code answers on its own, and
`code_gap` tells whether a definite part read from a code is that code's series
alone.
"""

from collections.abc import Mapping, Sequence
from typing import Any

from dfo._core.codes import CONTRACT_VIOLATION, INVALID_ARGUMENT
from dfo._core.errors import client_error
from dfo._core.lookup_results import Entity, Match
from dfo._core.text import WHITESPACE, cited
from dfo._core.types import DefinitePart, Gap, Notice, Part, Window
from dfo._datasets.build import Entities, dcid_entities, listed_entities, scope
from dfo._generated.role_keys import FLOW_KEYS, ROLE_KEYS

# The `role_text` word each caller key posts. `place` posts none and is undirected.
_ROLE_TEXT = {"origin": "from", "destination": "to"}

# The warning Search gives a `time_text` it cannot read, which then reads every year.
_TIME_TEXT_NOT_PARSED = "time_text_not_parsed"


def parsed_input(
    codes: object,
    *,
    variable: object = None,
    entities: Entities | None = None,
    window: Window | None = None,
    open_roles: object = None,
    source: object = None,
) -> dict[str, Any]:
    """The parsed Search input for a search by series codes: one separate part per
    code, each carrying the same variable words, entities, years and source.

    Raises:
        InvalidRequestError: An argument breaks its rule (`invalid_argument`);
            or `entities` holds a match that did not resolve
            (`match_unresolved`). No request is sent.
    """
    asked = checked_codes(codes)
    words = _text("variable", variable)
    shared: dict[str, Any] = {}
    if entities is not None:
        shared["entities"] = _entities(entities)
    if window is not None:
        time_text = _time_text(window)
        if time_text is not None:
            shared["time_text"] = time_text
    if open_roles is not None:
        shared["open_roles"] = _open_roles(open_roles)
    if source is not None:
        shared["sources"] = [{"text": _text("source", source)}]
    parts = [
        {
            "variable_text": words or code,
            "source_code": code,
            "separate": True,
            **shared,
        }
        for code in asked
    ]
    return {"kind": "parsed", "parts": parts}


def checked_codes(codes: object) -> list[str]:
    """The codes a search asks for, each without the surrounding white space
    `WHITESPACE` lists, as both clients trim it.

    Raises:
        InvalidRequestError: `codes` is a string, not a non-empty list or tuple
            of non-empty strings, or names one code twice, compared upper-cased
            as Search compares them (`invalid_argument`).
    """
    if isinstance(codes, str):
        raise client_error(
            INVALID_ARGUMENT,
            f"codes is a list of series codes; for one code pass [{codes!r}]",
        )
    if not isinstance(codes, list | tuple) or not codes:
        raise client_error(
            INVALID_ARGUMENT,
            f"codes is a list of series codes, such as ['DT.TDS.DEGG.CD'], not "
            f"{cited(codes)}",
        )
    listed = [code.strip(WHITESPACE) if isinstance(code, str) else "" for code in codes]
    for given, code in zip(codes, listed, strict=True):
        if not code:
            raise client_error(
                INVALID_ARGUMENT,
                f"codes holds {cited(given)}; each code is a non-empty string",
            )
    seen: set[str] = set()
    for code in listed:
        if code.upper() in seen:
            raise client_error(
                INVALID_ARGUMENT,
                f"codes names {cited(code)} twice; Search reads codes upper-cased, "
                "so name each code once",
            )
        seen.add(code.upper())
    return listed


def check_reply(
    parts: Sequence[Part], warnings: Sequence[Notice], codes: Sequence[str]
) -> None:
    """Refuse an answer to a search by codes that the client cannot read part by
    part: one whose parts do not match the codes one to one, or that could not
    read the years the client sent.

    Raises:
        ContractError: Search answered with another number of parts than codes,
            or warned `time_text_not_parsed` (`contract_violation`).
    """
    if len(parts) != len(codes):
        raise client_error(
            CONTRACT_VIOLATION,
            f"Search answered {len(codes)} series codes with {len(parts)} parts; "
            "a search by codes reads one part per code",
        )
    notices = [*warnings, *(notice for part in parts for notice in part.warnings)]
    if any(notice.code == _TIME_TEXT_NOT_PARSED for notice in notices):
        raise client_error(
            CONTRACT_VIOLATION,
            "Search could not read the years the client sent "
            f"({_TIME_TEXT_NOT_PARSED}), so its answer would read every year",
        )


def asked_code(part: Part) -> str | None:
    """The series code a part was asked by, as Search restates the part. None
    when it names none."""
    restatement = part.raw.get("restatement")
    if not isinstance(restatement, Mapping):
        return None
    code = restatement.get("source_code")
    return code if isinstance(code, str) and code else None


def code_gap(index: int, part: Part, code: str | None) -> Gap | None:
    """The gap a definite part asked by `code` leaves when its reading is not that
    code's series alone. None when it is, or when no code was asked.

    Every entry of the spec's `resolved.stat_vars.source_codes` must be an object
    naming `code`, compared upper-cased as Search compares codes, with `exact`
    true. A spec that lists no code, or has no `resolved.stat_vars`, is not
    known to be the code's series, so it leaves a gap, in a live reply and in
    an answer read back from JSON alike.
    """
    if code is None or not isinstance(part, DefinitePart):
        return None
    held = _source_codes(part)
    if held and all(_exact(entry, code) for entry in held):
        return None
    if not held:
        fact = (
            f"Search's reading for series code {cited(code)} names no series code, "
            "so it may hold another series"
        )
    else:
        listed = ", ".join(_held_line(entry) for entry in held)
        fact = (
            f"Search's reading for series code {cited(code)} holds {listed}, not "
            "that series alone"
        )
    exits = (
        f"Narrow it with variable= or source=, as in dfo.search(codes=[{cited(code)}], "
        f"source=...), or take the reading as it is: "
        f"dfo.fetch(answer.parts[{index}].spec)"
    )
    return Gap(index, part, "no_data", f"{fact}. {exits}")


def _source_codes(part: DefinitePart) -> list[object]:
    """The spec's `resolved.stat_vars.source_codes` entries, empty when it lists
    none or has no `resolved.stat_vars`."""
    spec = part.raw.get("spec")
    resolved = spec.get("resolved") if isinstance(spec, Mapping) else None
    stat_vars = resolved.get("stat_vars") if isinstance(resolved, Mapping) else None
    if not isinstance(stat_vars, Mapping):
        return []
    held = stat_vars.get("source_codes")
    return list(held) if isinstance(held, list) else []


def _exact(entry: object, code: str) -> bool:
    """Whether a held entry is an object naming `code` exactly."""
    if not isinstance(entry, Mapping):
        return False
    held = entry.get("code")
    return (
        isinstance(held, str)
        and held.upper() == code.upper()
        and entry.get("exact") is True
    )


def _held_line(entry: object) -> str:
    """One held entry as a gap names it: its code, marked when it is not exact,
    or the entry itself when it is not an object."""
    if not isinstance(entry, Mapping):
        return f"{cited(entry)} (not a code)"
    shown = cited(entry.get("code"))
    return shown if entry.get("exact") is True else f"{shown} (not exact)"


def _text(name: str, value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, str) and value.strip():
        return value.strip()
    raise client_error(
        INVALID_ARGUMENT, f"{name} is non-empty text, not {cited(value)}"
    )


def _role_key(argument: str, key: object, keys: Sequence[str]) -> str:
    if isinstance(key, str) and key in keys:
        return key
    raise client_error(
        INVALID_ARGUMENT,
        f"{argument} names {cited(key)}; its role keys are {', '.join(keys)}",
    )


def _entities(entities: Entities) -> list[dict[str, str]]:
    """The parsed entities `entities` names, each pinned by its dcid, named by the
    entity's name where it has one, and directed by its role.

    Raises:
        InvalidRequestError: `entities` is not a map of role keys to non-empty
            lists of dcids or what `lookup.resolve` returns, as `fetch` reads it,
            or binds a role to None or to no entity (`invalid_argument`).
    """
    if not isinstance(entities, Mapping):
        raise client_error(
            INVALID_ARGUMENT,
            f"entities is a map of role keys, such as {{'destination': "
            f"['country/KEN']}}, not {cited(entities)}",
        )
    # Each role's entities are read twice, for dcids and for names, so a
    # generator is read once into a list.
    listed = listed_entities(entities) or {}
    for role, bound in listed.items():
        _role_key("entities", role, tuple(ROLE_KEYS))
        if bound is None or bound == []:
            raise client_error(
                INVALID_ARGUMENT,
                f"entities[{role!r}] is {cited(bound)}; a search binds each role it "
                "names to at least one entity, so leave the role out to leave it "
                "open",
            )
    dcids = dcid_entities(listed) or {}
    # `scope` refuses what `fetch` refuses, so one form of `entities` serves both.
    checked = scope(
        entities={role: bound for role, bound in dcids.items() if bound is not None}
    )
    parsed = []
    for role, bound_dcids in (checked or {}).get("entities", {}).items():
        names = [_name(each) for each in listed[role] or ()]
        for dcid, name in zip(bound_dcids, names, strict=True):
            entity = {"text": name or dcid, "dcid": dcid}
            if role in _ROLE_TEXT:
                entity["role_text"] = _ROLE_TEXT[role]
            parsed.append(entity)
    return parsed


def _name(bound: object) -> str | None:
    """The name of an entity or a resolved match. None for a dcid."""
    if isinstance(bound, Match):
        bound = bound.entity
    return bound.name if isinstance(bound, Entity) else None


def _time_text(window: Window) -> str | None:
    """The `time_text` a window posts, read by `fetch`'s window rule. None for
    `"all"`, which posts none."""
    checked = (scope(window=window) or {})["window"]
    match checked["kind"]:
        case "range":
            return f"{checked['start_year']} to {checked['end_year']}"
        case "latest":
            return "latest"
    return None


def _open_roles(open_roles: object) -> list[str]:
    if isinstance(open_roles, str) or not isinstance(open_roles, list | tuple):
        raise client_error(
            INVALID_ARGUMENT,
            f"open_roles is a list of role keys, such as ['origin'], not "
            f"{cited(open_roles)}",
        )
    return [_role_key("open_roles", key, FLOW_KEYS) for key in open_roles]
