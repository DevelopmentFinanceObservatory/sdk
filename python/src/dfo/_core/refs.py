"""The DatasetRef format: a dataset's members and the exact versions a ref names.

The format is fixed, so a ref saved by one client or language loads in another.
`Spec` and the JSON helpers its own format shares with this one live in
`dfo._core.types`.
"""

import json
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any, Self

from dfo._core.types import (
    CONTENT_VERSION,
    DIGEST,
    Citation,
    FormatError,
    Rendering,
    Spec,
    check_keys,
    decode,
    is_text,
    load_spec,
    matches,
    object_at,
    spec_object,
)

FORMAT_VERSION = 1
FORMATS = ("csv", "xlsx", "parquet")


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
        obj = decode(text)
        check_keys(obj, "", required=("format_version", "members"))
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


def _member_object(member: RefMember) -> dict[str, Any]:
    return {
        "parts": list(member.parts),
        "sentence": member.sentence,
        "spec": spec_object(member.spec, with_sentence=False),
        "content_version": member.content_version,
        "artifact": {
            "digest": member.digest,
            "rendering": member.rendering.to_object(),
        },
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


def _load_member(value: object, pointer: str) -> RefMember:
    obj = object_at(value, pointer)
    check_keys(
        obj,
        pointer,
        required=("parts", "sentence", "spec", "content_version", "artifact"),
    )
    parts = obj["parts"]
    if not isinstance(parts, list) or not all(is_text(part) for part in parts):
        raise FormatError(
            "format_invalid", f"{pointer}/parts", "not an array of non-empty strings"
        )
    if not is_text(obj["sentence"]):
        raise FormatError(
            "format_invalid", f"{pointer}/sentence", "not a non-empty string"
        )
    spec = load_spec(obj["spec"], f"{pointer}/spec")
    if not matches(CONTENT_VERSION, obj["content_version"]):
        raise FormatError(
            "format_invalid", f"{pointer}/content_version", "not a content version"
        )
    artifact = object_at(obj["artifact"], f"{pointer}/artifact")
    check_keys(artifact, f"{pointer}/artifact", required=("digest", "rendering"))
    if not matches(DIGEST, artifact["digest"]):
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
