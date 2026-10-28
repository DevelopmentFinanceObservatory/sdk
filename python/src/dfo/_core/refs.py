"""The DatasetRef format: a dataset's members and the exact versions a ref names.

The format is fixed, so a ref saved by one client or language loads in another.
Format 1 holds dataset members, each a version of a built spec. Format 2 holds
derived members, each the frame an analysis recipe computed, which DFO describes in
full: the client copies every field from the server's answer and computes none.
`Spec` and the JSON helpers this format uses live in `dfo._core.types`.
"""

import json
import re
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import Any, Literal, Self, override

from dfo._core.text import single_line
from dfo._core.types import (
    CONTENT_VERSION,
    DIGEST,
    SPEC_ID,
    Citation,
    FormatError,
    Rendering,
    Spec,
    check_keys,
    clipped,
    decode,
    is_integer,
    is_text,
    load_spec,
    matches,
    object_at,
    spec_object,
)

# The ref format of dataset members, and the one of derived members.
DATASET_FORMAT = 1
DERIVED_FORMAT = 2
FORMATS = ("csv", "xlsx", "parquet")

OPS_ID = re.compile(r"ops_[0-9a-f]{32}")
DERIVED_VERSION = re.compile(r"ocv_[0-9a-f]{32}")
OUTPUT_DIGEST = re.compile(r"out_[0-9a-f]{32}")
NORMAL_FORM_HASH = re.compile(r"rnf_[0-9a-f]{32}")
REPLAY_KEY = re.compile(r"rpk_[0-9a-f]{32}")
EXECUTION_IDENTITY = re.compile(r"[0-9A-Za-z.+-]+\|[0-9A-Za-z.+-]+\|[0-9A-Za-z.+-]+")
PERIOD = re.compile(r"[0-9]{4}")


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

    @override
    def __repr__(self) -> str:
        return single_line(f"RefMember({self.spec.spec_id} at {self.content_version})")


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

    @override
    def __repr__(self) -> str:
        version = f"{self.spec.spec_id} at {self.content_version}"
        sources = "; ".join(source.label for source in self.citation.sources)
        return single_line(
            f"Member({version}, {clipped(sources)})"
            if sources
            else f"Member({version})"
        )

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
class DerivedSpec:
    """The recipe a derived member's frame comes from, as DFO names it.

    Attributes:
        spec_id: The recipe's id, `ops_<hex>`.
        normal_form_hash: Names the computation whatever data it ran on,
            `rnf_<hex>`.
        replay_key: Names the computation on these roots under this execution
            identity, `rpk_<hex>`.
    """

    spec_id: str
    normal_form_hash: str
    replay_key: str


@dataclass(frozen=True, slots=True)
class Root:
    """A dataset version a recipe ran on, with the rendering it read.

    Attributes:
        spec_id: The dataset's spec id, `spec_<hex>`.
        content_version: The version's id, `cv_<hex>`.
        rendering: The rendering the recipe read.
    """

    spec_id: str
    content_version: str
    rendering: Rendering


@dataclass(frozen=True, slots=True)
class ResolvedPeriod:
    """A period a recipe states relative to the latest period, with the year it
    resolved to.

    Attributes:
        anchor: What the offset counts from, `latest`.
        offset: Periods before the anchor, 0 or below.
        rule: How the latest period was settled, `half1`: the newest period at
            least half the series hold.
        period: The year the period resolved to.
    """

    anchor: Literal["latest"]
    offset: int
    rule: Literal["half1"]
    period: str


@dataclass(frozen=True, slots=True)
class DerivedRefMember:
    """One derived member of a `DatasetRef`: the frame an analysis recipe computed.

    DFO computes every field; a client copies them from the server's answer.

    Attributes:
        parts: The variable text of each answer part the member answers, in query
            order. Empty for a derived member, which no answer part names.
        sentence: The server's sentence for the derived frame.
        spec: The recipe.
        content_version: The frame's version, `ocv_<hex>`.
        output_digest: The digest of the frame's output alone, `out_<hex>`, which
            `DatasetRef.same_data` compares.
        roots: The dataset versions the recipe ran on.
        execution_identity: The engine, frame grammar and reduction policy versions
            that ran the recipe, joined by `|`.
        resolved_periods: Each period the recipe states relative to the latest,
            resolved. Empty for a recipe that states none.
        digest: The SHA-256 digest of the stored artifact, `sha256:<hex>`.
        rendering: Which rendering the artifact is.
    """

    parts: tuple[str, ...]
    sentence: str
    spec: DerivedSpec
    content_version: str
    output_digest: str
    roots: tuple[Root, ...]
    execution_identity: str
    resolved_periods: tuple[ResolvedPeriod, ...]
    digest: str
    rendering: Rendering

    @override
    def __repr__(self) -> str:
        return single_line(
            f"DerivedRefMember({self.spec.spec_id} at {self.content_version})"
        )


@dataclass(frozen=True, slots=True)
class DerivedMember:
    """One derived frame inside a dataset, with its version and citation.

    Attributes:
        parts: As `DerivedRefMember.parts`.
        sentence: The server's sentence for the derived frame.
        spec: The recipe.
        content_version: The frame's version, `ocv_<hex>`.
        output_digest: The digest of the frame's output alone.
        roots: The dataset versions the recipe ran on.
        execution_identity: The versions that ran the recipe, joined by `|`.
        resolved_periods: Each relative period of the recipe, resolved.
        citation: How to cite the frame's data.
        digest: The SHA-256 digest of the artifact the data came from.
        rendering: Which rendering the artifact is.
    """

    parts: tuple[str, ...]
    sentence: str
    spec: DerivedSpec
    content_version: str
    output_digest: str
    roots: tuple[Root, ...]
    execution_identity: str
    resolved_periods: tuple[ResolvedPeriod, ...]
    citation: Citation
    digest: str
    rendering: Rendering

    @override
    def __repr__(self) -> str:
        return single_line(
            f"DerivedMember({self.spec.spec_id} at {self.content_version})"
        )

    def ref_member(self) -> DerivedRefMember:
        """The member as a `DatasetRef` stores it."""
        return DerivedRefMember(
            parts=self.parts,
            sentence=self.sentence,
            spec=self.spec,
            content_version=self.content_version,
            output_digest=self.output_digest,
            roots=self.roots,
            execution_identity=self.execution_identity,
            resolved_periods=self.resolved_periods,
            digest=self.digest,
            rendering=self.rendering,
        )


@dataclass(frozen=True, slots=True, eq=False)
class DatasetRef:
    """The exact versions a dataset holds, in the format every DFO client reads.

    The format is fixed, so a ref saved by one client or language loads in another.
    `dfo.fetch(ref)` fetches the versions it names, and
    `dfo.fetch(ref, latest=True)` the newest versions of its specs. A ref holds
    dataset members or derived members, never both. This client loads, saves and
    compares a ref of derived members, and refuses to fetch one.

    Two refs are equal when they name the same specs at the same versions in the
    same renderings, in order, and a derived member the same recipe. Digests,
    sentences and parts stay out, since a version rendered again
    (`ref_digest_changed`) holds the same data. `same_data` asks the other
    question: whether two refs hold the same output.

    Attributes:
        members: One member per distinct built spec or recipe.
    """

    members: tuple[RefMember | DerivedRefMember, ...]

    def __post_init__(self) -> None:
        kinds = {type(member) for member in self.members}
        if len(kinds) > 1:
            raise ValueError(
                "A DatasetRef holds dataset members or derived members, not both"
            )

    def _versions(self) -> tuple[tuple[object, ...], ...]:
        return tuple(_identity(member) for member in self.members)

    @override
    def __eq__(self, other: object) -> bool:
        if not isinstance(other, DatasetRef):
            return NotImplemented
        return self._versions() == other._versions()

    @override
    def __hash__(self) -> int:
        return hash(self._versions())

    @override
    def __repr__(self) -> str:
        count = len(self.members)
        versions = ", ".join(
            f"{member.spec.spec_id} at {member.content_version}"
            for member in self.members
        )
        noun = "member" if count == 1 else "members"
        return single_line(f"DatasetRef({count} {noun}: {versions}, exact)")

    @classmethod
    def of(cls, members: Iterable[Member | DerivedMember], /) -> Self:
        """The ref to a dataset's members."""
        return cls(tuple(member.ref_member() for member in members))

    def same_data(self, other: "DatasetRef", /) -> bool:
        """Whether `other` holds the same output as this ref.

        The refs hold as many members, and at each position both members are
        derived members with the same output digest, or both are dataset members
        with the same version and the same party-totals cut. Recipes, roots,
        execution identities, layouts and file formats stay out, so an engine
        release or an upstream rebuild that moves no number keeps it true.

        Raises:
            TypeError: `other` is not a `DatasetRef`.
        """
        if not isinstance(other, DatasetRef):
            raise TypeError(
                f"same_data compares two DatasetRefs, not {type(other).__name__}"
            )
        return len(self.members) == len(other.members) and all(
            _same_output(mine, theirs)
            for mine, theirs in zip(self.members, other.members, strict=True)
        )

    def to_json(self) -> str:
        """The ref as JSON, read back by `DatasetRef.from_json` in any DFO client.

        A ref of dataset members is written in format 1, and a ref of derived
        members in format 2.
        """
        derived = any(isinstance(member, DerivedRefMember) for member in self.members)
        return json.dumps(
            {
                "format_version": DERIVED_FORMAT if derived else DATASET_FORMAT,
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
        obj = decode(text)
        check_keys(obj, "", required=("format_version", "members"))
        version = obj["format_version"]
        if version not in (DATASET_FORMAT, DERIVED_FORMAT) or isinstance(version, bool):
            raise FormatError(
                "format_invalid",
                "/format_version",
                f"not {DATASET_FORMAT} or {DERIVED_FORMAT}",
            )
        members = obj["members"]
        if not isinstance(members, list) or not members:
            raise FormatError("format_invalid", "/members", "not a non-empty array")
        pointers = [f"/members/{index}" for index in range(len(members))]
        loaded: tuple[RefMember | DerivedRefMember, ...] = (
            tuple(map(_load_member, members, pointers))
            if version == DATASET_FORMAT
            else tuple(map(_load_derived_member, members, pointers))
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


def _identity(member: RefMember | DerivedRefMember) -> tuple[object, ...]:
    """What `==` compares a member on: its spec, version and rendering, and a
    derived member's recipe."""
    versions = (member.spec.spec_id, member.content_version, member.rendering)
    if isinstance(member, DerivedRefMember):
        return (*versions, member.spec.normal_form_hash, member.spec.replay_key)
    return versions


def _same_output(
    mine: RefMember | DerivedRefMember, theirs: RefMember | DerivedRefMember
) -> bool:
    if isinstance(mine, DerivedRefMember) and isinstance(theirs, DerivedRefMember):
        return mine.output_digest == theirs.output_digest
    if isinstance(mine, RefMember) and isinstance(theirs, RefMember):
        return (
            mine.content_version == theirs.content_version
            and mine.rendering.without_party_totals
            is theirs.rendering.without_party_totals
        )
    return False


def _member_object(member: RefMember | DerivedRefMember) -> dict[str, Any]:
    artifact = {"digest": member.digest, "rendering": member.rendering.to_object()}
    if isinstance(member, RefMember):
        return {
            "parts": list(member.parts),
            "sentence": member.sentence,
            "spec": spec_object(member.spec),
            "content_version": member.content_version,
            "artifact": artifact,
        }
    return {
        "parts": list(member.parts),
        "sentence": member.sentence,
        "spec": {
            "spec_id": member.spec.spec_id,
            "recipe": {
                "normal_form_hash": member.spec.normal_form_hash,
                "replay_key": member.spec.replay_key,
            },
        },
        "content_version": member.content_version,
        "output_digest": member.output_digest,
        "roots": [
            {
                "spec_id": root.spec_id,
                "content_version": root.content_version,
                "rendering": root.rendering.to_object(),
            }
            for root in member.roots
        ],
        "execution_identity": member.execution_identity,
        "resolved_periods": [
            {
                "anchor": period.anchor,
                "offset": period.offset,
                "rule": period.rule,
                "period": period.period,
            }
            for period in member.resolved_periods
        ],
        "artifact": artifact,
    }


def _load_rendering(value: object, pointer: str) -> Rendering:
    obj = object_at(value, pointer)
    check_keys(
        obj,
        pointer,
        required=("format", "bundle"),
        allowed=("layout", "without_party_totals"),
    )
    if obj["format"] not in FORMATS:
        raise FormatError("format_invalid", f"{pointer}/format", "not a known format")
    if not isinstance(obj["bundle"], bool):
        raise FormatError("format_invalid", f"{pointer}/bundle", "not a boolean")
    if "layout" in obj and obj["layout"] != "frame":
        raise FormatError("format_invalid", f"{pointer}/layout", 'not "frame"')
    if "without_party_totals" in obj and obj["without_party_totals"] is not True:
        raise FormatError(
            "format_invalid", f"{pointer}/without_party_totals", "not true"
        )
    return Rendering(
        obj["format"],
        obj["bundle"],
        "frame" if "layout" in obj else None,
        without_party_totals="without_party_totals" in obj,
    )


def _matching(pattern: re.Pattern[str], value: object, pointer: str, what: str) -> str:
    """`value` when it is a string `pattern` matches in full."""
    if not matches(pattern, value):
        raise FormatError("format_invalid", pointer, f"not {what}")
    assert isinstance(value, str)
    return value


def _load_text(obj: Mapping[str, Any], pointer: str) -> tuple[tuple[str, ...], str]:
    """A member's `parts` and `sentence`."""
    parts = obj["parts"]
    if not isinstance(parts, list) or not all(is_text(part) for part in parts):
        raise FormatError(
            "format_invalid", f"{pointer}/parts", "not an array of non-empty strings"
        )
    if not is_text(obj["sentence"]):
        raise FormatError(
            "format_invalid", f"{pointer}/sentence", "not a non-empty string"
        )
    return tuple(parts), obj["sentence"]


def _load_artifact(value: object, pointer: str) -> tuple[str, Rendering]:
    """A member's artifact digest and rendering."""
    artifact = object_at(value, pointer)
    check_keys(artifact, pointer, required=("digest", "rendering"))
    digest = _matching(DIGEST, artifact["digest"], f"{pointer}/digest", "a digest")
    return digest, _load_rendering(artifact["rendering"], f"{pointer}/rendering")


def _load_member(value: object, pointer: str) -> RefMember:
    obj = object_at(value, pointer)
    check_keys(
        obj,
        pointer,
        required=("parts", "sentence", "spec", "content_version", "artifact"),
    )
    parts, sentence = _load_text(obj, pointer)
    spec = load_spec(obj["spec"], f"{pointer}/spec")
    content_version = _matching(
        CONTENT_VERSION,
        obj["content_version"],
        f"{pointer}/content_version",
        "a content version",
    )
    digest, rendering = _load_artifact(obj["artifact"], f"{pointer}/artifact")
    return RefMember(
        parts=parts,
        sentence=sentence,
        spec=Spec(spec.spec_id, spec.definition, sentence),
        content_version=content_version,
        digest=digest,
        rendering=rendering,
    )


def _load_derived_member(value: object, pointer: str) -> DerivedRefMember:
    obj = object_at(value, pointer)
    check_keys(
        obj,
        pointer,
        required=(
            "parts",
            "sentence",
            "spec",
            "content_version",
            "output_digest",
            "roots",
            "execution_identity",
            "resolved_periods",
            "artifact",
        ),
    )
    parts, sentence = _load_text(obj, pointer)
    digest, rendering = _load_artifact(obj["artifact"], f"{pointer}/artifact")
    return DerivedRefMember(
        parts=parts,
        sentence=sentence,
        spec=_load_derived_spec(obj["spec"], f"{pointer}/spec"),
        content_version=_matching(
            DERIVED_VERSION,
            obj["content_version"],
            f"{pointer}/content_version",
            "a derived version",
        ),
        output_digest=_matching(
            OUTPUT_DIGEST,
            obj["output_digest"],
            f"{pointer}/output_digest",
            "an output digest",
        ),
        roots=_unique_items(
            obj["roots"], f"{pointer}/roots", _load_root, non_empty=True
        ),
        execution_identity=_matching(
            EXECUTION_IDENTITY,
            obj["execution_identity"],
            f"{pointer}/execution_identity",
            "an execution identity",
        ),
        resolved_periods=_unique_items(
            obj["resolved_periods"],
            f"{pointer}/resolved_periods",
            _load_resolved_period,
            non_empty=False,
        ),
        digest=digest,
        rendering=rendering,
    )


def _load_derived_spec(value: object, pointer: str) -> DerivedSpec:
    obj = object_at(value, pointer)
    check_keys(obj, pointer, required=("spec_id", "recipe"))
    recipe = object_at(obj["recipe"], f"{pointer}/recipe")
    check_keys(recipe, f"{pointer}/recipe", required=("normal_form_hash", "replay_key"))
    return DerivedSpec(
        spec_id=_matching(OPS_ID, obj["spec_id"], f"{pointer}/spec_id", "a recipe id"),
        normal_form_hash=_matching(
            NORMAL_FORM_HASH,
            recipe["normal_form_hash"],
            f"{pointer}/recipe/normal_form_hash",
            "a normal form hash",
        ),
        replay_key=_matching(
            REPLAY_KEY,
            recipe["replay_key"],
            f"{pointer}/recipe/replay_key",
            "a replay key",
        ),
    )


def _unique_items[T](
    value: object,
    pointer: str,
    load: Callable[[object, str], T],
    *,
    non_empty: bool,
) -> tuple[T, ...]:
    """The items of a stored array, each loaded and none repeated."""
    if not isinstance(value, list) or (non_empty and not value):
        noun = "a non-empty array" if non_empty else "an array"
        raise FormatError("format_invalid", pointer, f"not {noun}")
    items = tuple(load(item, f"{pointer}/{index}") for index, item in enumerate(value))
    for index, item in enumerate(items):
        if item in items[:index]:
            raise FormatError("format_invalid", f"{pointer}/{index}", "repeated")
    return items


def _load_root(value: object, pointer: str) -> Root:
    obj = object_at(value, pointer)
    check_keys(obj, pointer, required=("spec_id", "content_version", "rendering"))
    return Root(
        spec_id=_matching(SPEC_ID, obj["spec_id"], f"{pointer}/spec_id", "a spec id"),
        content_version=_matching(
            CONTENT_VERSION,
            obj["content_version"],
            f"{pointer}/content_version",
            "a content version",
        ),
        rendering=_load_rendering(obj["rendering"], f"{pointer}/rendering"),
    )


def _load_resolved_period(value: object, pointer: str) -> ResolvedPeriod:
    obj = object_at(value, pointer)
    check_keys(obj, pointer, required=("anchor", "offset", "rule", "period"))
    if obj["anchor"] != "latest":
        raise FormatError("format_invalid", f"{pointer}/anchor", 'not "latest"')
    offset = obj["offset"]
    if not is_integer(offset) or offset > 0:
        raise FormatError(
            "format_invalid", f"{pointer}/offset", "not an integer of 0 or below"
        )
    if obj["rule"] != "half1":
        raise FormatError("format_invalid", f"{pointer}/rule", 'not "half1"')
    return ResolvedPeriod(
        anchor="latest",
        offset=int(offset),
        rule="half1",
        period=_matching(PERIOD, obj["period"], f"{pointer}/period", "a year"),
    )
