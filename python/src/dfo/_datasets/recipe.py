"""Recipes: a chain of DFO's operations, described without running it.

`recipe(start)` starts from a `Spec`, a `DatasetRef` or a `Dataset`, and each
step method returns a new `Recipe` one step longer, so a recipe is a value that
does no I/O and needs no client. `fetch(recipe)` sends the whole tree to
`POST /datasets/analysis` in one request. Every argument is checked when the
step is added, so a malformed chain is refused before any Dataset exists.

A recipe sends a tree of nodes. A step is `{verb, arguments, inputs: {data,
other?}}`, whose arguments carry the engine's names: `filter`'s `keep` becomes
`predicates` of `category_match`, `by` becomes `group_by`, `entity_by`,
`rank_by` or `numerator_by`, `how` becomes `aggregation`, a `window` becomes
`window_start` and `window_end`, and `on` passes through. A root is the start or
a second reading:

- a `Spec`, `{spec_id, rendering: {without_party_totals: true}}`, read at its
  newest version without party totals, as `fetch(spec)` reads it;
- a Dataset or ref of one dataset member, `{spec_id, content_version,
  rendering}`, read at that version in the member's party-totals cut;
- a Dataset or ref of one derived member, `{spec_id, content_version}`, which
  DFO expands into the recipe that made it;
- a Dataset or ref of several members, sent as `{ref}`, which DFO refuses with
  `several_members`, since an operation takes one reading per side.

This module is sync and shared by both clients.
"""

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal, override

from dfo._core.codes import INVALID_ARGUMENT
from dfo._core.errors import InvalidRequestError, client_error
from dfo._core.periods import LatestYear, period_object
from dfo._core.refs import DatasetRef, DerivedRefMember, RefMember
from dfo._core.text import single_line
from dfo._core.types import Spec, clipped
from dfo._datasets.dataset import Dataset, DerivedStep, steps_text

type Year = int | LatestYear
"""A year: a calendar year such as 2020, or `latest_year(offset)`."""

type Columns = str | Sequence[str]
"""One role or column, such as `"origin"`, or several."""

type Pairing = Mapping[str, str] | Sequence[str] | str
"""How two readings' members pair: a mapping of a role of `data` to the role of
`other` that holds the same entities, such as `{"destination": "place"}`, or a
role or roles both readings name alike."""

type Aggregation = Literal["sum", "mean", "max", "min"]
"""How an operation reduces several rows to one."""

type Change = Literal["relative", "absolute"]
"""`relative`, a fraction of the first year's value, or `absolute`, an amount."""

type Start = Spec | DatasetRef | Dataset | Recipe
"""What a recipe starts from, and what a two-reading step takes as `other`."""

# The most members a ranking keeps, as DFO's rank accepts it.
MAX_LIMIT = 1000


@dataclass(frozen=True, slots=True)
class _Step:
    """One operation over its inputs, with its arguments in the engine's names."""

    verb: str
    arguments: Mapping[str, Any]
    data: "_Node"
    shown: DerivedStep
    other: "_Node | None" = None


@dataclass(frozen=True, slots=True)
class _Root:
    """A reading a recipe starts from, as the request names it."""

    node: Mapping[str, Any]
    name: str


type _Node = _Step | _Root


@dataclass(frozen=True, slots=True, eq=False)
class Recipe:
    """A chain of DFO's operations, described without running it.

    `dfo.fetch(recipe)` runs the whole chain in one request. Each step method
    takes the arguments of the `dfo.analysis` function of its name, without the
    first reading, and returns a new recipe one step longer. A two-reading step
    takes the other reading as a `Spec`, `DatasetRef`, `Dataset` or `Recipe`.
    """

    _tree: _Node

    @override
    def __repr__(self) -> str:
        start = clipped(", ".join(dict.fromkeys(_roots(self._tree))))
        return single_line(f"Recipe({steps_text(_shown(self._tree), start)})")

    def tree(self) -> dict[str, Any]:
        """The tree `POST /datasets/analysis` takes.

        Raises:
            InvalidRequestError: The recipe has no step and starts from a
                dataset version or a spec, which a fetch reads itself
                (`invalid_argument`).
        """
        tree = self._tree
        if isinstance(tree, _Root) and not str(tree.node.get("spec_id")).startswith(
            "ops_"
        ):
            raise client_error(
                INVALID_ARGUMENT,
                f"A recipe with no step reads {tree.name} as it is; fetch it "
                "directly, or add a step such as .rank(by=...)",
            )
        return _wire(tree)

    def filter(self, *, keep: Mapping[str, str | Sequence[str]]) -> "Recipe":
        """Keep the rows whose role or column holds one of the values, as
        `keep={"destination": ["country/KEN"]}`.

        Raises:
            InvalidRequestError: `keep` is not a non-empty mapping of names to a
                value or a list of values (`invalid_argument`).
        """
        if not isinstance(keep, Mapping) or not keep:
            raise _refusal("keep", "maps a role to its values", keep)
        predicates = [
            {
                "kind": "category_match",
                "column": _name("keep", column),
                "values": _texts("keep", values),
            }
            for column, values in keep.items()
        ]
        return self._step("filter", {"predicates": predicates}, DerivedStep("filter"))

    def aggregate(self, *, by: Columns = (), how: Aggregation = "sum") -> "Recipe":
        """Total or average the rows, keeping the members of `by` apart.

        Args:
            by: The roles whose members stay apart; none totals every row of
                each year.
            how: `sum`, `mean`, `max` or `min`.
        """
        group_by = _columns("by", by, empty=True)
        return self._step(
            "aggregate",
            {"group_by": group_by, "aggregation": _word("how", how)},
            DerivedStep("aggregate", tuple(group_by)),
        )

    def growth(
        self,
        *,
        by: Columns = (),
        window: tuple[Year, Year],
        change: Change = "relative",
    ) -> "Recipe":
        """The change of each member of `by` from the first to the last year of
        `window`.

        Args:
            by: The roles whose members each get their own change.
            window: The first and last years, such as
                `(latest_year(-4), latest_year())`.
            change: `relative`, a fraction such as 0.25 for 25%, or
                `absolute`, an amount in the data's unit.
        """
        entity_by = _columns("by", by, empty=True)
        return self._step(
            "growth",
            {
                **_window(window),
                "entity_by": entity_by,
                "change": _word("change", change),
            },
            DerivedStep("growth", tuple(entity_by)),
        )

    def rank(
        self,
        *,
        by: Columns,
        window: tuple[Year, Year] | None = None,
        how: Aggregation | None = None,
        limit: int | None = None,
    ) -> "Recipe":
        """Order the members of `by`, largest first, and keep the top `limit`.

        Args:
            by: The roles whose members are ranked.
            window: The years ranked over; None ranks every year the data
                holds.
            how: How each member's rows in the window reduce to one value
                first; None ranks each member's one value.
            limit: The most members kept, from 1 to 1000; a tie at the last
                place keeps every member that shares it. None keeps them all.
        """
        rank_by = _columns("by", by, empty=False)
        arguments: dict[str, Any] = {"rank_by": rank_by}
        if window is not None:
            arguments.update(_window(window))
        if how is not None:
            arguments["aggregation"] = _word("how", how)
        if limit is not None:
            if not isinstance(limit, int) or isinstance(limit, bool):
                raise _refusal("limit", "is a whole number of members", limit)
            if not 1 <= limit <= MAX_LIMIT:
                raise _refusal("limit", f"is from 1 to {MAX_LIMIT}", limit)
            arguments["limit"] = limit
        return self._step("rank", arguments, DerivedStep("rank", tuple(rank_by), limit))

    def quotient_of(self, other: Start, *, on: Pairing | None = None) -> "Recipe":
        """Divide by another reading, pairing members through `on`, such as aid
        per person with `on={"destination": "place"}`."""
        return self._pair("quotient_of", other, on, by=None)

    def share_of(
        self,
        total: Start | None = None,
        *,
        by: Columns | None = None,
        on: Pairing | None = None,
    ) -> "Recipe":
        """Each value as a percentage of the matching row of `total`, or, with
        no `total`, of the total across all members of `by` in the same year.

        Raises:
            InvalidRequestError: Neither `total` nor `by` is given
                (`invalid_argument`).
        """
        if total is None:
            if by is None:
                raise client_error(
                    INVALID_ARGUMENT,
                    "share_of takes a total reading, or by= naming the role whose "
                    'members share the total, such as by="origin"',
                )
            if on is not None:
                raise client_error(
                    INVALID_ARGUMENT,
                    "share_of takes on= with a total reading; with by= alone the "
                    "total is the sum over by's members",
                )
            numerator_by = _columns("by", by, empty=False)
            return self._step(
                "share_of",
                {"numerator_by": numerator_by},
                DerivedStep("share_of", tuple(numerator_by)),
            )
        return self._pair("share_of", total, on, by=by)

    def join(self, other: Start, *, on: Pairing | None = None) -> "Recipe":
        """Match another reading's rows on their keys and keep both sides' rows
        in long format, told apart by `stat_var`."""
        return self._pair("join", other, on, by=None)

    def sum_of(self, other: Start, *, on: Pairing | None = None) -> "Recipe":
        """Add the matching rows of another reading over the years both hold."""
        return self._pair("sum_of", other, on, by=None)

    def compare(self, other: Start, *, on: Pairing | None = None) -> "Recipe":
        """This reading minus another, for each matching member over the years
        both hold. DFO refuses two different units."""
        return self._pair("compare", other, on, by=None)

    def _pair(
        self, verb: str, other: Start, on: Pairing | None, *, by: Columns | None
    ) -> "Recipe":
        arguments: dict[str, Any] = {}
        if by is not None:
            arguments["numerator_by"] = _columns("by", by, empty=False)
        if on is not None:
            arguments["on"] = _pairing(on)
        shown = DerivedStep(verb, tuple(arguments.get("numerator_by", ())))
        return self._step(verb, arguments, shown, other=_node(other, "other"))

    def _step(
        self,
        verb: str,
        arguments: Mapping[str, Any],
        shown: DerivedStep,
        *,
        other: _Node | None = None,
    ) -> "Recipe":
        return Recipe(_Step(verb, arguments, self._tree, shown, other))


def recipe(start: Start, /) -> Recipe:
    """A recipe that starts from `start`: a `Spec`, whose rows are never
    downloaded, a `DatasetRef`, or a `Dataset`. A `Recipe` returns as it is.

    Raises:
        InvalidRequestError: `start` is none of those, or a Dataset that names no
            version, such as a website bundle opened from a folder
            (`invalid_argument`).
    """
    if isinstance(start, Recipe):
        return start
    return Recipe(_node(start, "start"))


def _node(start: object, name: str) -> _Node:
    """The node a recipe's `start` or a step's other reading sends."""
    if isinstance(start, Recipe):
        return start._tree
    if isinstance(start, Spec):
        return _Root(
            {"spec_id": start.spec_id, "rendering": {"without_party_totals": True}},
            start.spec_id,
        )
    if isinstance(start, Dataset):
        if not start.members:
            raise client_error(
                INVALID_ARGUMENT,
                "A website bundle opened from a folder names no version, so a recipe "
                "cannot read it; open the bundle's ZIP, or fetch the dataset",
            )
        start = start.ref
    if not isinstance(start, DatasetRef):
        raise client_error(
            INVALID_ARGUMENT,
            f"A recipe's {name} is a Spec, a DatasetRef, a Dataset or a Recipe, not "
            f"{type(start).__name__}",
        )
    match start.members:
        case [RefMember() as member]:
            return _Root(
                {
                    "spec_id": member.spec.spec_id,
                    "content_version": member.content_version,
                    "rendering": {
                        "without_party_totals": member.rendering.without_party_totals
                    },
                },
                member.spec.spec_id,
            )
        case [DerivedRefMember() as member]:
            return _Root(
                {
                    "spec_id": member.spec.spec_id,
                    "content_version": member.content_version,
                },
                member.spec.spec_id,
            )
        case members:
            # DFO refuses several readings with `several_members`, naming them.
            return _Root(
                {"ref": _ref_object(start)},
                f"{len(members)} readings",
            )


def _ref_object(ref: DatasetRef) -> dict[str, Any]:
    return json.loads(ref.to_json())


def _wire(node: _Node) -> dict[str, Any]:
    if isinstance(node, _Root):
        return dict(node.node)
    inputs = {"data": _wire(node.data)}
    if node.other is not None:
        inputs["other"] = _wire(node.other)
    return {"verb": node.verb, "arguments": dict(node.arguments), "inputs": inputs}


def _shown(node: _Node) -> list[DerivedStep]:
    """The steps in the order they run: each after its inputs, `data` first."""
    if isinstance(node, _Root):
        return []
    other = _shown(node.other) if node.other is not None else []
    return [*_shown(node.data), *other, node.shown]


def _roots(node: _Node) -> list[str]:
    if isinstance(node, _Root):
        return [node.name]
    other = _roots(node.other) if node.other is not None else []
    return [*_roots(node.data), *other]


def _refusal(name: str, rule: str, value: object) -> InvalidRequestError:
    return client_error(INVALID_ARGUMENT, f"{name} {rule}, not {value!r}")


def _name(argument: str, value: object) -> str:
    if not isinstance(value, str) or not value:
        raise _refusal(argument, "names roles or columns by non-empty text", value)
    return value


def _texts(argument: str, values: object) -> list[str]:
    """A value or a list of values, each non-empty text."""
    if isinstance(values, str):
        values = [values]
    if not isinstance(values, Sequence) or not values:
        raise _refusal(
            argument, "maps each name to a value or a list of values", values
        )
    return [_name(argument, value) for value in values]


def _columns(argument: str, value: object, *, empty: bool) -> list[str]:
    """One role or column, or several, as a list."""
    if isinstance(value, str):
        return [_name(argument, value)]
    if not isinstance(value, Sequence) or (not value and not empty):
        raise _refusal(argument, 'names a role, such as "origin", or several', value)
    return [_name(argument, item) for item in value]


def _pairing(on: object) -> dict[str, str] | list[str]:
    if isinstance(on, Mapping):
        if not on:
            raise _refusal("on", "pairs at least one role", on)
        return {_name("on", key): _name("on", value) for key, value in on.items()}
    return _columns("on", on, empty=False)


def _window(window: object) -> dict[str, Any]:
    if not isinstance(window, tuple) or len(window) != 2:
        raise _refusal(
            "window",
            "is (first_year, last_year), such as (2015, latest_year())",
            window,
        )
    start, end = window
    return {
        "window_start": period_object(start, "window"),
        "window_end": period_object(end, "window"),
    }


def _word(argument: str, value: object) -> str:
    """An option's word; DFO refuses one it does not know, listing the others."""
    if not isinstance(value, str) or not value:
        raise _refusal(argument, "is a word such as 'sum'", value)
    return value
