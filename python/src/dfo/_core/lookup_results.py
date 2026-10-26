"""The results of the lookups: a name's match, a graph node, a code's registry
entry and Search's catalogue.

Each class is a frozen, slotted dataclass read from the generated wire type its
response carries, which it keeps untouched as `raw`, out of equality and hashing.
`str()` gives the one line a person reads, such as
`Kenya -> Kenya  country/KEN  (country)`, and `repr()` wraps that line in the
class's name. A line holds at most `LINE_MAX` characters.
"""

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import cast, override

from dfo._core.parse import require_members
from dfo._core.text import single_line
from dfo._core.types import GraphNode, clipped, counted
from dfo._generated.wire import (
    CatalogueResponse,
    CodeRegistryEntry,
    Counts,
    EntityRef,
    PlaceCounts,
    ResolveResponse,
    ResolveResult,
)

# The most characters `str()` gives, which leaves room for the class name and
# its parentheses within the 200 characters of a repr line.
LINE_MAX = 180

# The most characters a match's text and an entity's name take in a line, and the
# most candidates or near matches a match's line names before it counts the rest.
_TEXT_MAX = 40
_NAME_MAX = 30
_SHOWN_MAX = 3


def _line(text: str) -> str:
    return clipped(single_line(text), LINE_MAX)


def _text(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


@dataclass(frozen=True, slots=True)
class Entity:
    """A graph node a name resolved to, or one it might have meant.

    Attributes:
        dcid: The node's id, the value `entities=` takes, such as `country/KEN`.
        name: The node's name, such as "Kenya", when the graph holds one.
        kind: The node's kind, such as `country` or `group`, when the server
            names one. A kind this client does not list passes through.
    """

    dcid: str
    name: str | None
    kind: str | None

    @override
    def __str__(self) -> str:
        kind = f"  ({self.kind})" if self.kind else ""
        return _line(f"{_named(self, LINE_MAX)}{kind}")

    @override
    def __repr__(self) -> str:
        return f"Entity({self})"


def _named(entity: Entity, width: int = _NAME_MAX) -> str:
    """`Kenya  country/KEN`, the name cut to `width`, or the dcid alone."""
    if entity.name is None:
        return entity.dcid
    return f"{clipped(entity.name, width)}  {entity.dcid}"


def _listed(entities: tuple[Entity, ...]) -> str:
    """Up to `_SHOWN_MAX` entities as `name  dcid`, joined by ` | `, then
    `+N more`."""
    shown = [_named(entity) for entity in entities[:_SHOWN_MAX]]
    if (rest := len(entities) - _SHOWN_MAX) > 0:
        shown.append(f"+{rest} more")
    return " | ".join(shown)


@dataclass(frozen=True, slots=True)
class Match:
    """What one name resolved to.

    Attributes:
        text: The name as asked.
        status: `resolved`, `ambiguous`, `not_found` or `not_held`. A status this
            client does not list passes through.
        entity: The node the name resolved to, set for `resolved` and
            `not_held`. A `not_held` entity names an id the resolver knows and
            the graph does not hold, so it does not open on the node route.
        candidates: The nodes an ambiguous name could mean, in the server's
            order.
        near_matches: Nodes with a similar name: the nearest spellings of a name
            not found, or other nodes sharing a resolved name.
        raw: The server's result for the name, as decoded.
    """

    text: str
    status: str
    entity: Entity | None
    candidates: tuple[Entity, ...]
    near_matches: tuple[Entity, ...]
    raw: ResolveResult = field(compare=False)

    @override
    def __str__(self) -> str:
        text = clipped(self.text, _TEXT_MAX)
        if self.status == "resolved" and self.entity is not None:
            near = (
                f"  +{counted(len(self.near_matches), 'near match', 'near matches')}"
                if self.near_matches
                else ""
            )
            return _line(f"{text} -> {self.entity}{near}")
        status = self.status.replace("_", " ")
        if self.entity is not None:
            return _line(f"{text} -> {status}: {self.entity}")
        if self.candidates:
            return _line(f"{text} -> {status}: {_listed(self.candidates)}")
        if self.near_matches:
            return _line(f"{text} -> {status}; nearest: {_listed(self.near_matches)}")
        return _line(f"{text} -> {status}")

    @override
    def __repr__(self) -> str:
        return f"Match({self})"


@dataclass(frozen=True, slots=True)
class Node:
    """One graph node, read by its dcid.

    Attributes:
        dcid: The node's id, such as `country/KEN`.
        name: The node's name, when the graph holds one.
        kind: The node's kind, such as `country`, which says what `raw` holds.
        types: The node's graph types, such as `Country`.
        raw: The server's node, as decoded: for a place, the regions it sits in;
            for a group, its members.
    """

    dcid: str
    name: str | None
    kind: str
    types: tuple[str, ...]
    raw: GraphNode = field(compare=False)

    @override
    def __str__(self) -> str:
        entity = Entity(self.dcid, self.name, self.kind)
        types = f"  types: {', '.join(self.types)}" if self.types else ""
        return _line(f"{entity}{types}")

    @override
    def __repr__(self) -> str:
        return f"Node({self})"


@dataclass(frozen=True, slots=True)
class Code:
    """A code's entry in the platform registry, which says what a refusal or
    warning with that code means.

    Attributes:
        code: The code, such as `spec_not_found`.
        definition: What the code means, when the registry defines it.
        raw: The server's entry, as decoded: its title, classification and the
            routes that send it.
    """

    code: str
    definition: str | None
    raw: CodeRegistryEntry = field(compare=False)

    @override
    def __str__(self) -> str:
        if self.definition is None:
            return _line(self.code)
        return _line(f"{self.code}: {self.definition}")

    @override
    def __repr__(self) -> str:
        return f"Code({self})"


@dataclass(frozen=True, slots=True)
class Catalogue:
    """What Search holds data on.

    Attributes:
        version: The catalogue's version, which moves when the data does.
        counts: How many indicators, datasets, publishers and countries Search
            holds, and its aid flows; for one country, its publishers, variables
            and aid flows.
        examples: Questions Search answers, each one to pass to `dfo.search`.
        raw: The server's catalogue, as decoded, with the variable and place
            behind each example.
    """

    version: str
    counts: Counts | PlaceCounts = field(compare=False)
    examples: tuple[str, ...]
    raw: CatalogueResponse = field(compare=False)

    @override
    def __str__(self) -> str:
        totals = ", ".join(
            f"{value:,} {name}"
            for name, value in self.counts.items()
            if isinstance(value, int) and not isinstance(value, bool)
        )
        examples = counted(len(self.examples), "example question")
        if self.examples:
            examples += f', such as "{clipped(self.examples[0])}"'
        return _line(f"{totals}; {examples}" if totals else examples)

    @override
    def __repr__(self) -> str:
        return f"Catalogue({self})"


def _entity(value: object, pointer: str) -> Entity:
    ref = cast(
        EntityRef,
        require_members(
            value, "EntityRef", (("ref", "string"), ("label", "string")), pointer
        ),
    )
    return Entity(ref["ref"], _text(ref.get("label")), _text(ref.get("kind")))


def _entities(value: object, pointer: str) -> tuple[Entity, ...]:
    if not isinstance(value, list):
        return ()
    return tuple(
        _entity(item, f"{pointer}/{index}") for index, item in enumerate(value)
    )


def read_matches(body: ResolveResponse) -> list[Match]:
    """One match per name in a resolve response, in the order asked.

    A result's `entity`, `candidates` or `near_matches` held as another JSON
    type reads as absent.

    Raises:
        ContractError: A result lacks its `input` or `status` string, or an
            entity, candidate or near match lacks its `ref` or `label` string
            (`contract_violation`).
    """
    found = []
    for index, value in enumerate(body["results"]):
        pointer = f"/results/{index}"
        result = cast(
            ResolveResult,
            require_members(
                value,
                "ResolveResult",
                (("input", "string"), ("status", "string")),
                pointer,
            ),
        )
        entity = result.get("entity")
        found.append(
            Match(
                result["input"],
                result["status"],
                _entity(entity, f"{pointer}/entity")
                if isinstance(entity, Mapping)
                else None,
                _entities(result.get("candidates"), f"{pointer}/candidates"),
                _entities(result.get("near_matches"), f"{pointer}/near_matches"),
                result,
            )
        )
    return found


def read_node(body: GraphNode) -> Node:
    """The node a node response holds, once it holds its `ref`, `kind` and
    `types`. A type that is not a string is left out."""
    return Node(
        body["ref"],
        _text(body.get("label")),
        body["kind"],
        tuple(item for item in body["types"] if isinstance(item, str)),
        body,
    )


def read_code(body: CodeRegistryEntry) -> Code:
    """The registry entry a code response holds."""
    return Code(body["code"], _text(body.get("definition")), body)


def read_catalogue(body: CatalogueResponse) -> Catalogue:
    """The catalogue a catalogue response holds.

    Raises:
        ContractError: An example lacks its `text` string (`contract_violation`).
    """
    examples = tuple(
        require_members(
            example,
            "CatalogueExampleSentence",
            (("text", "string"),),
            f"/examples/{index}",
        )["text"]
        for index, example in enumerate(body["examples"])
    )
    return Catalogue(body["catalogue_version"], body["counts"], examples, body)
