"""The public data classes: specs, answer parts, candidates, gaps and graph nodes.

Every class is a frozen, slotted dataclass. A member holding the server's JSON
(`Spec.definition`, each `raw`) keeps the decoded value untouched, so posting it back
sends what the server sent, and stays out of equality and hashing. Each class prints
one line that names what it is and summarises its children, cutting long text with
"…" at `REPR_TEXT_MAX` characters.
"""

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import (
    Any,
    Literal,
    TypeGuard,
    get_args,
    override,
)

from dfo._core.json_text import loads
from dfo._core.text import single_line
from dfo._generated.error_map import GapKind as SearchGapKind
from dfo._generated.wire import (
    AggregateNode,
    AssumptionKind,
    CodeNode,
    CodeSystemNode,
    ContinentalUnionNode,
    ContinentNode,
    CountryNode,
    DatasetNode,
    DepartureCode,
    GroupNode,
    NoDataReason,
    OrganisationNode,
    OtherNode,
    PlaceOtherNode,
    ProvenanceNode,
    Severity,
    SourceNode,
    StatVarNode,
    SubregionNode,
    UnitNode,
)

SPEC_ID = re.compile(r"spec_[0-9a-f]{32}")
CONTENT_VERSION = re.compile(r"cv_[0-9a-f]{32}")
OPERATION_ID = re.compile(r"op_[0-9a-f]{64}")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")

# A decoded JSON object as the server sent it.
type Wire = Mapping[str, Any]

# The column set a dataset build renders, `long` rows or the pipeline `frame`.
type Layout = Literal["long", "frame"]

# The periods a fetch asks for: every period, the latest, or (start_year, end_year).
type Window = Literal["all", "latest"] | tuple[int, int]

# The gap kinds the client adds to Search's: a part that timed out, and a status
# this client does not know.
type _ClientGapKind = Literal["timed_out", "unknown"]

# Why a part leaves a gap in an answer.
type GapKind = SearchGapKind | _ClientGapKind

_GAP_KINDS: frozenset[str] = frozenset(
    get_args(SearchGapKind.__value__) + get_args(_ClientGapKind.__value__)
)

# The most characters of one text, such as a label or a message, a repr quotes.
REPR_TEXT_MAX = 60

# The most options a gap's repr names before it counts the rest, and the widths
# of a gap's part label and of each option label, which keep its line within 200
# characters.
REPR_OPTIONS_MAX = 3
REPR_GAP_LABEL_MAX = 40
REPR_OPTION_LABEL_MAX = 30


def clipped(text: str, width: int = REPR_TEXT_MAX) -> str:
    """`text` cut to `width` characters, the last one "…", when it is longer."""
    return text if len(text) <= width else text[: width - 1].rstrip() + "…"


def counted(count: int, noun: str) -> str:
    """`1 warning`, `2 warnings`: the count with the noun in its number."""
    return f"{count} {noun}" if count == 1 else f"{count} {noun}s"


def _quoted(text: str | None) -> str | None:
    return None if text is None else f'"{clipped(text)}"'


def _joined(name: str, *items: str | None) -> str:
    """`Name(a, b)` from the items that are not None, on one line without
    control characters."""
    return single_line(
        f"{name}({', '.join(item for item in items if item is not None)})"
    )


type FormatErrorReason = Literal[
    "format_invalid", "definition_spec_id_mismatch", "repeated_spec_id"
]


class FormatError(ValueError):
    """Stored JSON for a `DatasetRef`, a saved dataset or a bundle breaks its format.

    Attributes:
        reason: `format_invalid` when the JSON breaks the format's shape or a
            bundle's descriptor lists a file outside the bundle,
            `definition_spec_id_mismatch` when a definition names another spec, or
            `repeated_spec_id` when a ref holds one spec twice.
        pointer: A JSON Pointer to the offending value.
    """

    def __init__(self, reason: FormatErrorReason, pointer: str, detail: str) -> None:
        super().__init__(f"{pointer or '/'}: {detail}")
        self.reason: FormatErrorReason = reason
        self.pointer = pointer


@dataclass(frozen=True, slots=True, eq=False, repr=False)
class Spec:
    """One reading of a question, the unit the server builds a dataset from.

    Equal and hashed on `spec_id`. `definition` is the server's JSON for the spec,
    decoded and left as received, because the server needs its `identity` back as it
    sent it.

    Attributes:
        spec_id: The server's id for the reading.
        definition: The server's definition, `{schema_version, spec_id, identity}`.
        sentence: Search's sentence for the reading, when known.
        entity_groups: How Search resolved each role's group of places, keyed by
            role, when the spec came from an answer. It is posted back with its
            identity so Search reads the groups the same way.
    """

    spec_id: str
    definition: Mapping[str, Any]
    sentence: str | None = None
    entity_groups: Mapping[str, Any] | None = None

    @override
    def __eq__(self, other: object) -> bool:
        if not isinstance(other, Spec):
            return NotImplemented
        return self.spec_id == other.spec_id

    @override
    def __hash__(self) -> int:
        return hash(self.spec_id)

    @override
    def __repr__(self) -> str:
        return _joined("Spec", self.spec_id, _quoted(self.sentence))


@dataclass(frozen=True, slots=True)
class Notice:
    """A warning the server attached to an answer, a part or a dataset.

    Attributes:
        code: The warning's code in the platform registry.
        severity: `info`, `warn` or `degraded` for Search. The datasets surface may
            send others.
        message: The server's message.
        spec_id: The spec the warning concerns, when the server names one.
    """

    code: str
    severity: Severity | str
    message: str
    spec_id: str | None = None

    @override
    def __repr__(self) -> str:
        return single_line(
            f"Notice({self.code}, {self.severity}: {clipped(self.message)})"
        )


@dataclass(frozen=True, slots=True)
class Departure:
    """A way the reading differs from what the question asked.

    Attributes:
        code: The departure's code, such as `closest_match`. Other values pass
            through.
        text: The server's sentence describing it.
        asked: What the question asked for, when the server names it.
        shown: What the reading shows instead, when the server names it.
        binding_ref: The binding the departure concerns, when there is one.
    """

    code: DepartureCode | str
    text: str
    asked: str | None = None
    shown: str | None = None
    binding_ref: str | None = None

    @override
    def __repr__(self) -> str:
        return single_line(f"Departure({self.code}: {clipped(self.text)})")


@dataclass(frozen=True, slots=True)
class RequestedOperation:
    """A computation the question asked for, which Search does not run.

    Attributes:
        verb: `rank`, `aggregate`, `growth`, `share_of`, `explain`, `forecast` or
            `report`.
        phrase: The question's wording for it, such as "top 5 donors".
        over: The axis it runs across, when the verb names one.
        target_year: The year a forecast projects to.
    """

    verb: str
    phrase: str
    over: str | None = None
    target_year: int | None = None

    @override
    def __repr__(self) -> str:
        over = f" over {self.over}" if self.over is not None else ""
        year = f" to {self.target_year}" if self.target_year is not None else ""
        return single_line(
            f'RequestedOperation({self.verb} "{clipped(self.phrase)}"{over}{year})'
        )


@dataclass(frozen=True, slots=True)
class Assumption:
    """A choice Search made for a reading that the question left open.

    Search's sentence for the reading states it in an "Assumed: ..." clause.

    Attributes:
        kind: `declared_default` for a default the variable declares, `open_role`
            for a role the question left open, or `place_scope` for how a place
            was read. Other values pass through.
        binding_ref: The binding the assumption settles, such as
            `how:dac2aAidType`.
        text: The assumption as the sentence words it, such as "official
            development assistance".
        refs: The graph ids the assumption binds, when it binds any.
    """

    kind: AssumptionKind | str
    binding_ref: str
    text: str
    refs: tuple[str, ...] = ()

    @override
    def __repr__(self) -> str:
        return single_line(
            f'Assumption({self.kind} {self.binding_ref}: "{clipped(self.text)}")'
        )


@dataclass(frozen=True, slots=True)
class Option:
    """One way to settle a part that awaits a choice of place or source.

    Attributes:
        label: The choice as the user reads it, such as "Congo [DRC]".
        mentions: The question's words the choice settles.
        data_query: The parsed question with the choice pinned, posted back to
            Search unchanged.
        entity_choice: For a choice of place, the index of the ambiguous wording
            this option settles, shared by that wording's options and its sentence
            slot. Two wordings can share one text, as "Congo" does in "aid from
            Congo to Congo", so a menu groups options by this index. None for
            any other option.
    """

    label: str
    mentions: tuple[str, ...]
    data_query: Mapping[str, Any] = field(compare=False)
    entity_choice: int | None = None

    @override
    def __repr__(self) -> str:
        return single_line(f'Option("{clipped(self.label)}")')


@dataclass(frozen=True, slots=True)
class Candidate:
    """One reading of a part that has several.

    `label`, `unit` and `source` split the sentence. The label is its heading, and
    the unit and source come from its byline. Choose it with `answer.choose`, or
    fetch its spec alone with `dfo.fetch(candidate.spec)`.

    Attributes:
        spec: The reading.
        sentence: Search's sentence for the reading.
        label: The sentence's heading, which tells the readings apart.
        source: The provenance the reading draws on.
        unit: The unit as the byline words it, such as "Current US dollars"; None
            when the byline names no unit.
        raw: The server's spec object, decoded and untouched.
        assumptions: What Search assumed for this reading, from the part's
            `reading_assumptions`. A pick posts them back to Search.
    """

    spec: Spec
    sentence: str | None
    label: str | None
    source: str | None
    unit: str | None
    raw: Mapping[str, Any] = field(compare=False)
    assumptions: tuple[Assumption, ...] = field(default=(), kw_only=True)

    @override
    def __repr__(self) -> str:
        return _joined("Candidate", _quoted(option_label(self)), self.source)


# `match_args=False` on every part keeps the dataclass from declaring an empty
# `__match_args__` on `Part`, which type checkers would hold each subclass to, and
# `repr=False` on each subclass keeps `Part.__repr__` in place of a generated one.
@dataclass(frozen=True, slots=True, kw_only=True, match_args=False)
class Part:
    """One part of an answer, the reading or lack of one for one variable asked.

    Attributes:
        status: The server's part status.
        variable_text: The question's words for the variable.
        sentence: Search's sentence for this part.
        separate: Whether the part was asked to be compared with the others.
        warnings: The part's own warnings.
        departures: How the part's reading differs from the question.
        operations: Computations the part asked for, which Search does not run.
        assumptions: What Search assumed to read the part, as its sentence
            states them.
        raw: The server's part object, decoded and untouched.
    """

    status: str
    variable_text: str | None = None
    sentence: str | None = None
    separate: bool = False
    warnings: tuple[Notice, ...] = ()
    departures: tuple[Departure, ...] = ()
    operations: tuple[RequestedOperation, ...] = ()
    assumptions: tuple[Assumption, ...] = ()
    raw: Mapping[str, Any] = field(default_factory=dict, compare=False)

    @override
    def __repr__(self) -> str:
        warnings = counted(len(self.warnings), "warning") if self.warnings else None
        return _joined(
            type(self).__name__, _quoted(self.variable_text), *self._shown(), warnings
        )

    def _shown(self) -> tuple[str | None, ...]:
        """What the repr shows between the variable's words and the warnings."""
        return (self.status,)


@dataclass(frozen=True, slots=True, kw_only=True, match_args=False, repr=False)
class DefinitePart(Part):
    """A part with one reading. Matches as `DefinitePart(spec)`."""

    __match_args__ = ("spec",)
    spec: Spec

    @override
    def _shown(self) -> tuple[str | None, ...]:
        return (self.spec.spec_id,)


@dataclass(frozen=True, slots=True, kw_only=True, match_args=False, repr=False)
class CandidatesPart(Part):
    """A part with several readings to choose from, in the server's order.

    Matches as `CandidatesPart(candidates)`. `truncated` is True when the server
    left out readings it found.
    """

    __match_args__ = ("candidates",)
    candidates: tuple[Candidate, ...]
    truncated: bool = False

    @override
    def _shown(self) -> tuple[str | None, ...]:
        return (
            counted(len(self.candidates), "candidate"),
            "truncated" if self.truncated else None,
        )


@dataclass(frozen=True, slots=True, kw_only=True, match_args=False, repr=False)
class NoDataPart(Part):
    """A part with no reading. Matches as `NoDataPart(reason)`.

    `options` lists the choices that settle the part, when it awaits a choice of
    place or source. It is empty otherwise.
    """

    __match_args__ = ("reason",)
    reason: NoDataReason | str
    message: str | None = None
    options: tuple[Option, ...] = ()

    @override
    def _shown(self) -> tuple[str | None, ...]:
        return (
            self.reason,
            counted(len(self.options), "option") if self.options else None,
        )


@dataclass(frozen=True, slots=True, kw_only=True, match_args=False, repr=False)
class UnsupportedPart(Part):
    """A part understood but not supported. Matches as `UnsupportedPart(reason)`.

    `reason` is the refusal code. `message` is the server's explanation.
    """

    __match_args__ = ("reason",)
    reason: str
    message: str | None = None

    @override
    def _shown(self) -> tuple[str | None, ...]:
        return (self.reason,)


@dataclass(frozen=True, slots=True, kw_only=True, match_args=False, repr=False)
class UnknownPart(Part):
    """A part whose status this client does not know.

    Matches as `UnknownPart(status, raw)`.
    """

    __match_args__ = ("status", "raw")

    @override
    def _shown(self) -> tuple[str | None, ...]:
        return (f'status "{clipped(self.status)}"',)


@dataclass(frozen=True, slots=True)
class Gap:
    """A part that stops an answer from building a complete dataset.

    Attributes:
        part_index: The part's position in the answer.
        part: The part.
        kind: `choice`, `no_data`, `not_understood`, `unsupported`, `timed_out` or
            `unknown`.
        message: What the user reads about it.
        options: The choices that settle it: a candidates part's candidates, or
            a no_data part's options of place or source. Empty when nothing
            settles it.
    """

    part_index: int
    part: Part
    kind: GapKind
    message: str
    options: tuple[Candidate | Option, ...] = ()

    @override
    def __repr__(self) -> str:
        part = f"part {self.part_index}"
        if self.part.variable_text is not None:
            part += f' "{clipped(self.part.variable_text, REPR_GAP_LABEL_MAX)}"'
        if not self.options:
            return single_line(f"Gap({part}, {self.kind})")
        shown = [
            clipped(option_label(option), REPR_OPTION_LABEL_MAX)
            for option in self.options[:REPR_OPTIONS_MAX]
        ]
        if (rest := len(self.options) - REPR_OPTIONS_MAX) > 0:
            shown.append(f"+{rest} more")
        options = counted(len(self.options), "option")
        return single_line(f"Gap({part}, {self.kind}, {options}: {' | '.join(shown)})")


@dataclass(frozen=True, slots=True)
class CitationSource:
    """One source a dataset cites.

    Attributes:
        ref: The source's id in the graph.
        label: The source's name.
        licence: The licence's name, when the source declares one.
        licence_url: Where the licence is published.
        url: Where the source publishes the data.
    """

    ref: str
    label: str
    licence: str | None = None
    licence_url: str | None = None
    url: str | None = None

    @override
    def __repr__(self) -> str:
        return _joined("CitationSource", _quoted(self.label), self.licence)


@dataclass(frozen=True, slots=True)
class Citation:
    """How to cite a dataset, as the citation text and the sources behind it."""

    text: str
    sources: tuple[CitationSource, ...] = ()

    @override
    def __repr__(self) -> str:
        sources = counted(len(self.sources), "source")
        return single_line(f"Citation({_quoted(self.text)}, {sources})")


# The members of a manifest artifact's `rendering` object a ref's selector holds.
# `Rendering.matches` compares all but `without_party_totals`.
RENDERING_SELECTORS = frozenset({"format", "bundle", "layout", "without_party_totals"})


@dataclass(frozen=True, slots=True)
class Rendering:
    """Which rendering of a version an artifact is, as a ref stores it.

    Attributes:
        format: `csv`, `xlsx` or `parquet`.
        bundle: Whether the artifact is a bundle with its descriptor.
        layout: `frame` for the pipeline frame, None for the long layout.
        without_party_totals: Whether the rows leave out the parties the code
            index declares totals.
    """

    format: str
    bundle: bool
    layout: Literal["frame"] | None = None
    without_party_totals: bool = False

    def to_object(self) -> dict[str, Any]:
        """The rendering as a ref's artifact and a build request's `options` hold it.

        `layout` is written only when set and `without_party_totals` only when
        true, as the server records it, so a plain rendering's JSON has neither.
        """
        obj: dict[str, Any] = {"format": self.format, "bundle": self.bundle}
        if self.layout is not None:
            obj["layout"] = self.layout
        if self.without_party_totals:
            obj["without_party_totals"] = True
        return obj

    def matches(self, rendering: Mapping[str, Any], /) -> bool:
        """Whether a manifest artifact's `rendering` object is this rendering.

        The server's object carries more members than the selector, so it matches
        on format, bundle and whether its layout is the frame. Whether it leaves
        party totals out plays no part: the build request names that, and a cut
        that leaves nothing out answers the plain version.
        """
        return (
            rendering.get("format") == self.format
            and rendering.get("bundle") is self.bundle
            and (rendering.get("layout") == "frame") == (self.layout == "frame")
        )


def option_label(option: Candidate | Option, /) -> str:
    """How a repr names a choice: its label, else its sentence, else its spec id."""
    if isinstance(option, Option):
        return option.label
    return option.label or option.sentence or option.spec.spec_id


def spec_object(spec: Spec) -> dict[str, Any]:
    """The spec as a ref member stores it, `{spec_id, definition}`."""
    return {"spec_id": spec.spec_id, "definition": spec.definition}


def is_gap_kind(value: object) -> TypeGuard[GapKind]:
    return isinstance(value, str) and value in _GAP_KINDS


def decode(text: str | bytes, pointer: str = "") -> Mapping[str, Any]:
    """A stored JSON object. `NaN` and `Infinity` are refused, as JSON has neither.

    Args:
        text: The stored JSON.
        pointer: Where the JSON sits in a larger document, prefixed to the
            pointer of an error.

    Raises:
        FormatError: The text is not JSON, nests deeper than `JSON_MAX_DEPTH`
            levels, or is not an object.
    """
    try:
        obj = loads(text)
    except ValueError as error:  # not JSON, nested too deeply, or not UTF-8
        raise FormatError("format_invalid", pointer, f"not JSON: {error}") from error
    return object_at(obj, pointer)


def is_text(value: object) -> bool:
    return isinstance(value, str) and bool(value)


def is_integer(value: object) -> bool:
    """Whether a decoded JSON value is an integer: a number with no fractional
    part, `1.0` included, that is not a boolean."""
    if isinstance(value, float):
        return value.is_integer()
    return isinstance(value, int) and not isinstance(value, bool)


def matches(pattern: re.Pattern[str], value: object) -> bool:
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def object_at(value: object, pointer: str) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        raise FormatError("format_invalid", pointer, "not an object")
    return value


def check_keys(
    obj: Mapping[str, Any],
    pointer: str,
    *,
    required: Sequence[str],
    allowed: Sequence[str] = (),
) -> None:
    for key in required:
        if key not in obj:
            raise FormatError("format_invalid", f"{pointer}/{key}", "missing")
    for key in obj:
        if key not in required and key not in allowed:
            raise FormatError("format_invalid", f"{pointer}/{key}", "not in the format")


def load_spec(value: object, pointer: str) -> Spec:
    """The spec a stored `{spec_id, definition}` object names."""
    obj = object_at(value, pointer)
    check_keys(obj, pointer, required=("spec_id", "definition"))
    spec_id = obj["spec_id"]
    if not matches(SPEC_ID, spec_id):
        raise FormatError("format_invalid", f"{pointer}/spec_id", "not a spec id")
    spec = load_definition(obj["definition"], f"{pointer}/definition")
    if spec.spec_id != spec_id:
        raise FormatError(
            "definition_spec_id_mismatch",
            f"{pointer}/definition/spec_id",
            f"names {spec.spec_id}, not {spec_id}",
        )
    return spec


def load_definition(value: object, pointer: str) -> Spec:
    """The spec a stored definition, `{schema_version, spec_id, identity}`, names."""
    definition = object_at(value, pointer)
    check_keys(definition, pointer, required=("schema_version", "spec_id", "identity"))
    if not is_integer(definition["schema_version"]):
        raise FormatError(
            "format_invalid", f"{pointer}/schema_version", "not an integer"
        )
    object_at(definition["identity"], f"{pointer}/identity")
    if not matches(SPEC_ID, definition["spec_id"]):
        raise FormatError("format_invalid", f"{pointer}/spec_id", "not a spec id")
    return Spec(definition["spec_id"], definition)


@dataclass(frozen=True, slots=True, eq=False, repr=False)
class RawResponse:
    """A response from `client.request`, for a route the client does not wrap.

    Attributes:
        status_code: The HTTP status, always a 2xx or 3xx since a refusal raises.
        headers: The response headers, keyed in lower case.
        content: The body's bytes.
    """

    status_code: int
    headers: Mapping[str, str]
    content: bytes

    @override
    def __repr__(self) -> str:
        return _joined(
            "RawResponse",
            str(self.status_code),
            self.headers.get("content-type"),
            counted(len(self.content), "byte"),
        )

    @property
    def text(self) -> str:
        """The body decoded as UTF-8."""
        return self.content.decode("utf-8", errors="replace")

    def json(self) -> Any:
        """The body decoded as JSON.

        Raises:
            ValueError: The body is not UTF-8 JSON, holds `NaN` or `Infinity`,
                or nests arrays and objects deeper than `JSON_MAX_DEPTH` levels.
        """
        return loads(self.content)


type Node = (
    StatVarNode
    | CodeSystemNode
    | CodeNode
    | GroupNode
    | CountryNode
    | ContinentNode
    | SubregionNode
    | ContinentalUnionNode
    | PlaceOtherNode
    | OrganisationNode
    | AggregateNode
    | UnitNode
    | SourceNode
    | DatasetNode
    | ProvenanceNode
    | OtherNode
)
"""One graph node, told apart by its `kind`."""
