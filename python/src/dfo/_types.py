"""The public data classes: specs, answer parts, candidates, gaps and dataset refs.

Every class is a frozen, slotted dataclass. A member holding the server's JSON
(`Spec.definition`, each `raw`) keeps the decoded value untouched, so posting it back
sends what the server sent, and stays out of equality, hashing and `repr`.
"""

import json
import re
from collections.abc import Awaitable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field, fields
from typing import TYPE_CHECKING, Any, Literal, Never, Protocol, Self, override

from dfo._error_map import INVALID_ARGUMENT
from dfo._errors import client_error

if TYPE_CHECKING:
    # Both modules read these classes, so the imports are for types only.
    from dfo._build import Layout
    from dfo._dataset import Dataset

FORMAT_VERSION = 1
SPEC_ID = re.compile(r"spec_[0-9a-f]{32}")
CONTENT_VERSION = re.compile(r"cv_[0-9a-f]{32}")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
FORMATS = ("csv", "xlsx", "parquet")

type FormatErrorReason = Literal[
    "format_invalid", "definition_spec_id_mismatch", "repeated_spec_id"
]


class FormatError(ValueError):
    """Stored JSON for a `Spec`, a `DatasetRef` or a bundle breaks its format.

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


@dataclass(frozen=True, slots=True, eq=False)
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
    definition: Mapping[str, Any] = field(repr=False)
    sentence: str | None = None
    entity_groups: Mapping[str, Any] | None = field(default=None, repr=False)

    @override
    def __eq__(self, other: object) -> bool:
        if not isinstance(other, Spec):
            return NotImplemented
        return self.spec_id == other.spec_id

    @override
    def __hash__(self) -> int:
        return hash(self.spec_id)

    def to_json(self) -> str:
        """The spec as JSON, read back by `Spec.from_json`."""
        return json.dumps(_spec_object(self, with_sentence=True), ensure_ascii=False)

    @classmethod
    def from_json(cls, text: str | bytes, /) -> Self:
        """Load a spec written by `Spec.to_json`.

        Raises:
            FormatError: The JSON is not a spec, or its definition names another
                spec.
        """
        obj = _decode(text)
        _check_keys(obj, "", required=("spec_id", "definition"), allowed=("sentence",))
        spec = _load_spec(obj, "")
        sentence = obj.get("sentence")
        if sentence is not None and not _is_text(sentence):
            raise FormatError("format_invalid", "/sentence", "not a non-empty string")
        return cls(spec.spec_id, spec.definition, sentence)


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
    severity: str
    message: str
    spec_id: str | None = None


@dataclass(frozen=True, slots=True)
class Departure:
    """A way the reading differs from what the question asked.

    Attributes:
        code: The departure's code, such as `closest_match`.
        text: The server's sentence describing it.
        asked: What the question asked for, when the server names it.
        shown: What the reading shows instead, when the server names it.
        binding_ref: The binding the departure concerns, when there is one.
    """

    code: str
    text: str
    asked: str | None = None
    shown: str | None = None
    binding_ref: str | None = None


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

    kind: str
    binding_ref: str
    text: str
    refs: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class Option:
    """One way to settle a part that awaits a choice of place or source.

    Attributes:
        label: The choice as the user reads it, such as "Congo [DRC]".
        mentions: The question's words the choice settles.
        data_query: The parsed question with the choice pinned, posted back to
            Search unchanged.
    """

    label: str
    mentions: tuple[str, ...]
    data_query: Mapping[str, Any] = field(repr=False, compare=False)


@dataclass(frozen=True, slots=True)
class _Reading:
    """The members `Candidate` and `AsyncCandidate` share.

    `label`, `unit` and `source` split the sentence. The label is its heading, and
    the unit and source come from its byline.

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
    raw: Mapping[str, Any] = field(repr=False, compare=False)
    assumptions: tuple[Assumption, ...] = field(default=(), kw_only=True)


@dataclass(frozen=True, slots=True)
class Candidate(_Reading):
    """One reading of a part that has several, in an `Answer`.

    A candidate read back from a saved dataset's `missing` belongs to no answer,
    and fetches its spec with `dfo.fetch(candidate.spec)`.
    """

    _fetch: "_CandidateFetch | None" = field(
        default=None, repr=False, compare=False, kw_only=True
    )

    def fetch(
        self,
        *,
        partial: bool = False,
        strict: bool = False,
        layout: "Layout" = "long",
        timeout: float | None = 1800.0,
        progress: bool | None = None,
    ) -> "Dataset":
        """Build this reading's dataset, through the `Answer` it came from.

        Search answers the reading alone, from one request that posts its
        identity and assumptions back, and the fetch builds that answer. It
        takes `Answer.fetch`'s options.

        Raises:
            InvalidRequestError: The candidate came from no answer.
        """
        if self._fetch is None:
            raise _unbound()
        return self._fetch(
            self,
            partial=partial,
            strict=strict,
            layout=layout,
            timeout=timeout,
            progress=progress,
        )


@dataclass(frozen=True, slots=True)
class AsyncCandidate(_Reading):
    """One reading of a part that has several, in an `AsyncAnswer`."""

    _fetch: "_AsyncCandidateFetch | None" = field(
        default=None, repr=False, compare=False, kw_only=True
    )

    async def fetch(
        self,
        *,
        partial: bool = False,
        strict: bool = False,
        layout: "Layout" = "long",
        timeout: float | None = 1800.0,
        progress: bool | None = None,
    ) -> "Dataset":
        """Build this reading's dataset, through the `AsyncAnswer` it came from.

        Search answers the reading alone, from one request that posts its
        identity and assumptions back, and the fetch builds that answer. It
        takes `AsyncAnswer.fetch`'s options.

        Raises:
            InvalidRequestError: The candidate came from no answer.
        """
        if self._fetch is None:
            raise _unbound()
        return await self._fetch(
            self,
            partial=partial,
            strict=strict,
            layout=layout,
            timeout=timeout,
            progress=progress,
        )


def _unbound() -> Exception:
    return client_error(
        INVALID_ARGUMENT,
        "candidate.fetch() cannot build this reading: it came from no answer; "
        "fetch its spec with dfo.fetch(candidate.spec)",
    )


class _CandidateFetch(Protocol):
    def __call__(
        self,
        candidate: Candidate,
        /,
        *,
        partial: bool,
        strict: bool,
        layout: "Layout",
        timeout: float | None,
        progress: bool | None,
    ) -> "Dataset": ...


class _AsyncCandidateFetch(Protocol):
    def __call__(
        self,
        candidate: AsyncCandidate,
        /,
        *,
        partial: bool,
        strict: bool,
        layout: "Layout",
        timeout: float | None,
        progress: bool | None,
    ) -> Awaitable["Dataset"]: ...


# `match_args=False` on every part keeps the dataclass from declaring an empty
# `__match_args__` on `Part`, which type checkers would hold each subclass to.
@dataclass(frozen=True, slots=True, kw_only=True, match_args=False)
class Part[C]:
    """One part of an answer, the reading or lack of one for one variable asked.

    Generic over the candidate type. `Answer.parts` hold `Part[Candidate]` and
    `AsyncAnswer.parts` hold `Part[AsyncCandidate]`. Only `CandidatesPart` holds
    candidates. The other parts are `Part[Never]`, which fits either answer.

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
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)


@dataclass(frozen=True, slots=True, kw_only=True, match_args=False)
class DefinitePart(Part[Never]):
    """A part with one reading. Matches as `DefinitePart(spec)`."""

    __match_args__ = ("spec",)
    spec: Spec


@dataclass(frozen=True, slots=True, kw_only=True, match_args=False)
class CandidatesPart[C](Part[C]):
    """A part with several readings to choose from, in the server's order.

    Matches as `CandidatesPart(candidates)`. `truncated` is True when the server
    left out readings it found.
    """

    __match_args__ = ("candidates",)
    candidates: tuple[C, ...]
    truncated: bool = False


@dataclass(frozen=True, slots=True, kw_only=True, match_args=False)
class NoDataPart(Part[Never]):
    """A part with no reading. Matches as `NoDataPart(reason)`.

    `options` lists the choices that settle the part, when it awaits a choice of
    place or source. It is empty otherwise.
    """

    __match_args__ = ("reason",)
    reason: str
    message: str | None = None
    options: tuple[Option, ...] = ()


@dataclass(frozen=True, slots=True, kw_only=True, match_args=False)
class UnsupportedPart(Part[Never]):
    """A part understood but not supported. Matches as `UnsupportedPart(reason)`.

    `reason` is the refusal code. `message` is the server's explanation.
    """

    __match_args__ = ("reason",)
    reason: str
    message: str | None = None


@dataclass(frozen=True, slots=True, kw_only=True, match_args=False)
class UnknownPart(Part[Never]):
    """A part whose status this client does not know. Matches as `UnknownPart(status, raw)`."""

    __match_args__ = ("status", "raw")


@dataclass(frozen=True, slots=True)
class Gap[C]:
    """A part that stops an answer from building a complete dataset.

    Generic over the candidate type, as `Part` is.

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
    part: Part[C]
    kind: str
    message: str
    options: tuple[C | Option, ...] = ()


def with_candidates[D](
    part: CandidatesPart[Any], candidates: tuple[D, ...], /
) -> CandidatesPart[D]:
    """`part` with its candidates swapped for `candidates`, every other field kept."""
    kept: dict[str, Any] = {
        field.name: getattr(part, field.name) for field in fields(part)
    }
    kept["candidates"] = candidates
    return CandidatesPart(**kept)


def unbound_gap(gap: Gap[Candidate | AsyncCandidate], /) -> Gap[Candidate]:
    """`gap` with its candidates bound to no answer, for a dataset or an error.

    A dataset and an `IncompleteAnswerError` hold no client, so their candidates
    refuse `fetch` and point to `dfo.fetch(candidate.spec)`.
    """
    part = gap.part
    match part:
        case CandidatesPart():
            candidates = tuple(
                Candidate(
                    c.spec,
                    c.sentence,
                    c.label,
                    c.source,
                    c.unit,
                    c.raw,
                    assumptions=c.assumptions,
                )
                for c in part.candidates
            )
            unbound = with_candidates(part, candidates)
            return Gap(gap.part_index, unbound, gap.kind, gap.message, candidates)
        case DefinitePart() | NoDataPart() | UnsupportedPart() | UnknownPart():
            options = tuple(
                option for option in gap.options if isinstance(option, Option)
            )
            return Gap(gap.part_index, part, gap.kind, gap.message, options)
        case _:
            raise TypeError(f"{type(part).__name__} is not an answer part")


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


@dataclass(frozen=True, slots=True)
class Citation:
    """How to cite a dataset, as the citation text and the sources behind it."""

    text: str
    sources: tuple[CitationSource, ...] = ()


@dataclass(frozen=True, slots=True)
class Rendering:
    """Which rendering of a version an artifact is, as a ref stores it.

    Attributes:
        format: `csv`, `xlsx` or `parquet`.
        bundle: Whether the artifact is a bundle with its descriptor.
        layout: `frame` for the pipeline frame, None for the long layout.
    """

    format: str
    bundle: bool
    layout: Literal["frame"] | None = None

    def matches(self, rendering: Mapping[str, Any], /) -> bool:
        """Whether a manifest artifact's `rendering` object is this rendering.

        The server's object carries more members than the selector, so it matches
        on format, bundle and whether its layout is the frame.
        """
        return (
            rendering.get("format") == self.format
            and rendering.get("bundle") is self.bundle
            and (rendering.get("layout") == "frame") == (self.layout == "frame")
        )


@dataclass(frozen=True, slots=True)
class RefMember:
    """One member of a `DatasetRef`, the exact version of one reading.

    Attributes:
        parts: The variable text of each answer part the member answers, in query
            order. Empty for a spec fetched outside an answer.
        sentence: Search's sentence for the built reading.
        spec: The built reading.
        content_version: The version's id.
        digest: The SHA-256 digest of the stored artifact, `sha256:<hex>`.
        rendering: Which rendering the artifact is.
    """

    parts: tuple[str, ...]
    sentence: str
    spec: Spec
    content_version: str
    digest: str
    rendering: Rendering


@dataclass(frozen=True, slots=True)
class Member:
    """One reading inside a dataset, with its version and citation.

    Attributes:
        parts: The variable text of each answer part the member answers, in query
            order. Empty for a spec fetched outside an answer.
        spec: The built reading.
        content_version: The version's id.
        sentence: Search's sentence for the built reading.
        citation: How to cite the member's data.
        digest: The SHA-256 digest of the artifact the data came from.
        rendering: Which rendering the artifact is.
    """

    parts: tuple[str, ...]
    spec: Spec
    content_version: str
    sentence: str
    citation: Citation
    digest: str
    rendering: Rendering

    def ref_member(self) -> RefMember:
        """The member as a `DatasetRef` stores it."""
        return RefMember(
            parts=self.parts,
            sentence=self.sentence,
            spec=self.spec,
            content_version=self.content_version,
            digest=self.digest,
            rendering=self.rendering,
        )


@dataclass(frozen=True, slots=True)
class DatasetRef:
    """The exact versions a dataset holds, in the format every DFO client reads.

    The format is fixed, so a ref saved by one client or language loads in another.

    Attributes:
        members: One member per reading, each with a distinct spec.
    """

    members: tuple[RefMember, ...]

    @classmethod
    def of(cls, members: Iterable[Member], /) -> Self:
        """The ref to a dataset's members."""
        return cls(tuple(member.ref_member() for member in members))

    def to_json(self) -> str:
        """The ref as JSON, read back by `DatasetRef.from_json` in any DFO client."""
        return json.dumps(
            {
                "format_version": FORMAT_VERSION,
                "members": [_member_object(member) for member in self.members],
            },
            ensure_ascii=False,
        )

    @classmethod
    def from_json(cls, text: str | bytes, /) -> Self:
        """Load a ref written by any DFO client.

        Raises:
            FormatError: The JSON breaks the ref format, a member's definition names
                another spec, or two members hold one spec.
        """
        obj = _decode(text)
        _check_keys(obj, "", required=("format_version", "members"))
        if obj["format_version"] != FORMAT_VERSION or isinstance(
            obj["format_version"], bool
        ):
            raise FormatError(
                "format_invalid", "/format_version", f"not {FORMAT_VERSION}"
            )
        members = obj["members"]
        if not isinstance(members, list) or not members:
            raise FormatError("format_invalid", "/members", "not a non-empty array")
        loaded = tuple(
            _load_member(member, f"/members/{index}")
            for index, member in enumerate(members)
        )
        seen: set[str] = set()
        for index, member in enumerate(loaded):
            if member.spec.spec_id in seen:
                raise FormatError(
                    "repeated_spec_id",
                    f"/members/{index}/spec/spec_id",
                    f"{member.spec.spec_id} is already a member",
                )
            seen.add(member.spec.spec_id)
        return cls(loaded)


def _spec_object(spec: Spec, *, with_sentence: bool) -> dict[str, Any]:
    obj: dict[str, Any] = {"spec_id": spec.spec_id, "definition": spec.definition}
    if with_sentence and spec.sentence is not None:
        obj["sentence"] = spec.sentence
    return obj


def _member_object(member: RefMember) -> dict[str, Any]:
    rendering: dict[str, Any] = {
        "format": member.rendering.format,
        "bundle": member.rendering.bundle,
    }
    if member.rendering.layout is not None:
        rendering["layout"] = member.rendering.layout
    return {
        "parts": list(member.parts),
        "sentence": member.sentence,
        "spec": _spec_object(member.spec, with_sentence=False),
        "content_version": member.content_version,
        "artifact": {"digest": member.digest, "rendering": rendering},
    }


def _decode(text: str | bytes) -> Mapping[str, Any]:
    try:
        obj = json.loads(text)
    except ValueError as error:  # JSONDecodeError, or bytes that are not UTF-8
        raise FormatError("format_invalid", "", f"not JSON: {error}") from error
    if not isinstance(obj, dict):
        raise FormatError("format_invalid", "", "not an object")
    return obj


def _is_text(value: object) -> bool:
    return isinstance(value, str) and bool(value)


def _matches(pattern: re.Pattern[str], value: object) -> bool:
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def _object_at(value: object, pointer: str) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        raise FormatError("format_invalid", pointer, "not an object")
    return value


def _check_keys(
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


def _load_spec(obj: Mapping[str, Any], pointer: str) -> Spec:
    spec_id = obj["spec_id"]
    if not _matches(SPEC_ID, spec_id):
        raise FormatError("format_invalid", f"{pointer}/spec_id", "not a spec id")
    definition = _object_at(obj["definition"], f"{pointer}/definition")
    if "spec_id" not in definition:
        raise FormatError("format_invalid", f"{pointer}/definition/spec_id", "missing")
    if not _matches(SPEC_ID, definition["spec_id"]):
        raise FormatError(
            "format_invalid", f"{pointer}/definition/spec_id", "not a spec id"
        )
    if definition["spec_id"] != spec_id:
        raise FormatError(
            "definition_spec_id_mismatch",
            f"{pointer}/definition/spec_id",
            f"names {definition['spec_id']}, not {spec_id}",
        )
    return Spec(spec_id, definition)


def _load_rendering(value: object, pointer: str) -> Rendering:
    obj = _object_at(value, pointer)
    _check_keys(obj, pointer, required=("format", "bundle"), allowed=("layout",))
    if obj["format"] not in FORMATS:
        raise FormatError("format_invalid", f"{pointer}/format", "not a known format")
    if not isinstance(obj["bundle"], bool):
        raise FormatError("format_invalid", f"{pointer}/bundle", "not a boolean")
    if "layout" in obj and obj["layout"] != "frame":
        raise FormatError("format_invalid", f"{pointer}/layout", 'not "frame"')
    return Rendering(obj["format"], obj["bundle"], "frame" if "layout" in obj else None)


def _load_member(value: object, pointer: str) -> RefMember:
    obj = _object_at(value, pointer)
    _check_keys(
        obj,
        pointer,
        required=("parts", "sentence", "spec", "content_version", "artifact"),
    )
    parts = obj["parts"]
    if not isinstance(parts, list) or not all(_is_text(part) for part in parts):
        raise FormatError(
            "format_invalid", f"{pointer}/parts", "not an array of non-empty strings"
        )
    if not _is_text(obj["sentence"]):
        raise FormatError(
            "format_invalid", f"{pointer}/sentence", "not a non-empty string"
        )
    spec_obj = _object_at(obj["spec"], f"{pointer}/spec")
    _check_keys(spec_obj, f"{pointer}/spec", required=("spec_id", "definition"))
    spec = _load_spec(spec_obj, f"{pointer}/spec")
    if not _matches(CONTENT_VERSION, obj["content_version"]):
        raise FormatError(
            "format_invalid", f"{pointer}/content_version", "not a content version"
        )
    artifact = _object_at(obj["artifact"], f"{pointer}/artifact")
    _check_keys(artifact, f"{pointer}/artifact", required=("digest", "rendering"))
    if not _matches(DIGEST, artifact["digest"]):
        raise FormatError(
            "format_invalid", f"{pointer}/artifact/digest", "not a sha256 digest"
        )
    return RefMember(
        parts=tuple(parts),
        sentence=obj["sentence"],
        spec=Spec(spec.spec_id, spec.definition, obj["sentence"]),
        content_version=obj["content_version"],
        digest=artifact["digest"],
        rendering=_load_rendering(
            artifact["rendering"], f"{pointer}/artifact/rendering"
        ),
    )


@dataclass(frozen=True, slots=True, eq=False)
class RawResponse:
    """A response from `client.request`, for a route the client does not wrap.

    Attributes:
        status_code: The HTTP status, always a 2xx or 3xx since a refusal raises.
        headers: The response headers, keyed in lower case.
        content: The body's bytes.
    """

    status_code: int
    headers: Mapping[str, str] = field(repr=False)
    content: bytes = field(repr=False)

    @property
    def text(self) -> str:
        """The body decoded as UTF-8."""
        return self.content.decode("utf-8", errors="replace")

    def json(self) -> Any:
        """The body decoded as JSON.

        Raises:
            ValueError: The body is not JSON.
        """
        return json.loads(self.content)
