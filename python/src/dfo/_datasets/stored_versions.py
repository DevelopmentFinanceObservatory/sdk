"""Stored versions: the version a `latest="stored"` read of each spec serves now.

`spec_ids(targets)` gives the spec ids a check names, each once, sorted by code
point, so two checks of the same specs send the same URL and share an edge
cache entry: a Spec's own; for a ref, or a Dataset by its ref, each dataset
member's and each derived member's roots'; for a recipe, each root's. `read_heads` reads the answer of
`GET /datasets/heads` into a `StoredVersions`, whose `to_json` writes the saved
form `stored-versions.schema.json` gives and `StoredVersions.from_json` reads
back.

This module is sync and shared by both clients.
"""

import json
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, override

from dfo._core.codes import CONTRACT_VIOLATION, INVALID_ARGUMENT
from dfo._core.errors import ContractError, InvalidRequestError, client_error
from dfo._core.refs import OPS_ID, DatasetRef, DerivedRefMember, load_ref
from dfo._core.types import (
    CONTENT_VERSION,
    SPEC_ID,
    FormatError,
    Spec,
    check_keys,
    decode,
    matches,
    object_at,
)
from dfo._datasets.dataset import Dataset
from dfo._datasets.recipe import Recipe, root_nodes

HEADS_PATH = "/datasets/heads"
"""The route that answers each spec's stored head."""

MAX_SPECS = 64
"""The most specs one check names, as `GET /datasets/heads` takes them."""

FORMAT_VERSION = 1
"""The format of the JSON `StoredVersions.to_json` writes."""

_ROUTE = f"GET {HEADS_PATH}"

type StoredTarget = Spec | DatasetRef | Dataset | Recipe
"""What a stored-versions check reads spec ids from."""


@dataclass(frozen=True, slots=True, eq=False)
class StoredVersions:
    """The version a `latest="stored"` read of each spec would serve from its
    stored head when the check ran, or None when that read would not serve
    from the head: no head, a head whose import was replaced, a head too old
    to serve, a revoked version, or a spec DFO has not registered.

    `dfo.stored_versions(targets)` returns one. Save `to_json()` beside what
    you built from the data, check again later, and re-read the specs
    `changed_since` names. Two are equal when they hold the same heads.

    Attributes:
        heads: Each spec id the check named, sorted, with its stored version
            (`cv_…`) or None.
    """

    heads: Mapping[str, str | None]

    def __post_init__(self) -> None:
        heads = MappingProxyType(dict(sorted(self.heads.items())))
        object.__setattr__(self, "heads", heads)

    @override
    def __eq__(self, other: object) -> bool:
        if not isinstance(other, StoredVersions):
            return NotImplemented
        return dict(self.heads) == dict(other.heads)

    @override
    def __hash__(self) -> int:
        return hash(tuple(self.heads.items()))

    @override
    def __repr__(self) -> str:
        count = len(self.heads)
        stored = sum(version is not None for version in self.heads.values())
        noun = "spec" if count == 1 else "specs"
        return f"StoredVersions({count} {noun}, {stored} with a stored version)"

    def changed_since(self, built: "StoredVersions", /) -> list[str]:
        """The spec ids, sorted, whose stored version differs from the one
        `built` records: another version, a version where `built` holds None
        or the reverse, or a spec `built` does not list. A spec None in both
        has not changed.

        Args:
            built: An earlier check, as `StoredVersions.from_json` reads it
                back from what the build saved.

        Raises:
            InvalidRequestError: `built` is not a `StoredVersions`
                (`invalid_argument`).
        """
        if not isinstance(built, StoredVersions):
            hint = (
                "; read saved JSON with StoredVersions.from_json first"
                if isinstance(built, str | bytes | Mapping)
                else ""
            )
            raise client_error(
                INVALID_ARGUMENT,
                f"changed_since takes a StoredVersions, not {type(built).__name__}"
                f"{hint}",
            )
        before = built.heads
        return [
            spec_id
            for spec_id, version in self.heads.items()
            if spec_id not in before or before[spec_id] != version
        ]

    def to_json(self) -> str:
        """The check as JSON text, `{format_version, heads}`, each head
        `{spec_id, content_version}` sorted by spec id, which
        `StoredVersions.from_json` reads back in any DFO client."""
        return json.dumps(
            {
                "format_version": FORMAT_VERSION,
                "heads": [
                    {"spec_id": spec_id, "content_version": version}
                    for spec_id, version in self.heads.items()
                ],
            }
        )

    @classmethod
    def from_json(cls, value: str | bytes | Mapping[str, Any], /) -> "StoredVersions":
        """Read a check any DFO client saved, from its JSON text, as str or
        bytes, or from the object `json.loads` gives for it. The TypeScript
        client's `StoredVersions.fromJSON` takes the text or the parsed value
        too.

        Raises:
            FormatError: The value is neither JSON text nor a JSON object,
                comes from a later format version, holds a key the format does
                not name, lists no head or more than 64, names a spec twice,
                or holds a spec id or version that is neither `spec_…` nor
                `cv_…` (`format_invalid`), with the pointer of the fault.
        """
        record = (
            decode(value) if isinstance(value, str | bytes) else object_at(value, "")
        )
        check_keys(record, "", required=("format_version", "heads"))
        version = record["format_version"]
        if version != FORMAT_VERSION or isinstance(version, bool):
            raise FormatError(
                "format_invalid",
                "/format_version",
                f"not {FORMAT_VERSION}; a later client reads it",
            )
        entries = record["heads"]
        if not isinstance(entries, list) or not 1 <= len(entries) <= MAX_SPECS:
            raise FormatError(
                "format_invalid", "/heads", f"not a list of 1 to {MAX_SPECS} heads"
            )
        heads: dict[str, str | None] = {}
        for index, entry in enumerate(entries):
            pointer = f"/heads/{index}"
            head = object_at(entry, pointer)
            check_keys(head, pointer, required=("spec_id", "content_version"))
            spec_id, content_version = head["spec_id"], head["content_version"]
            if not matches(SPEC_ID, spec_id):
                raise FormatError(
                    "format_invalid", f"{pointer}/spec_id", "not a spec id"
                )
            if spec_id in heads:
                raise FormatError(
                    "format_invalid", f"{pointer}/spec_id", f"{spec_id} is listed twice"
                )
            if content_version is not None and not matches(
                CONTENT_VERSION, content_version
            ):
                raise FormatError(
                    "format_invalid",
                    f"{pointer}/content_version",
                    "neither a dataset version nor null",
                )
            heads[spec_id] = content_version
        return cls(heads)


def spec_ids(targets: object) -> list[str]:
    """The spec ids a check of `targets` names, each once, sorted by code point.

    Raises:
        InvalidRequestError: `targets` is not a list of Specs, DatasetRefs,
            Datasets and Recipes, names no spec or more than `MAX_SPECS`, or a
            recipe root reads a frame DFO computed, which holds no stored head
            (`invalid_argument`); a Dataset names no version, as a website
            bundle opened from a folder does not (`ref_unavailable`).
    """
    if isinstance(targets, Spec | DatasetRef | Dataset | Recipe):
        raise _refusal(
            f"stored_versions takes a list of targets, as [{type(targets).__name__}]"
        )
    if isinstance(targets, str | bytes | Mapping) or not isinstance(targets, Sequence):
        raise _refusal(
            "stored_versions takes a list of Specs, DatasetRefs, Datasets and "
            "Recipes, not "
            f"{type(targets).__name__}"
        )
    found = {spec_id for target in targets for spec_id in _read_ids(target)}
    if not found:
        raise _refusal("stored_versions names no spec; pass the specs, refs or recipes")
    if len(found) > MAX_SPECS:
        raise _refusal(
            f"stored_versions names {len(found)} specs, past the {MAX_SPECS} one check "
            "takes; split the targets over several checks"
        )
    return sorted(found)


def _read_ids(target: object) -> Iterator[str]:
    """The spec ids one target reads."""
    if isinstance(target, Spec):
        yield target.spec_id
    elif isinstance(target, DatasetRef):
        yield from _ref_ids(target)
    elif isinstance(target, Dataset):
        yield from _ref_ids(target.ref)
    elif isinstance(target, Recipe):
        for node in root_nodes(target):
            if "ref" in node:
                yield from _ref_ids(load_ref(node["ref"], "/ref"))
            elif matches(OPS_ID, spec_id := node.get("spec_id")):
                raise _refusal(
                    f"The recipe {target!r} reads {spec_id}, a frame DFO computed, "
                    "which holds no stored head; check the DatasetRef it came "
                    "from, whose derived member names the datasets it read"
                )
            else:
                yield str(spec_id)
    else:
        raise _refusal(
            "stored_versions takes Specs, DatasetRefs, Datasets and Recipes, not "
            f"{type(target).__name__}"
        )


def _ref_ids(ref: DatasetRef) -> Iterator[str]:
    for member in ref.members:
        if isinstance(member, DerivedRefMember):
            yield from (root.spec_id for root in member.roots)
        else:
            yield member.spec.spec_id


def _refusal(message: str) -> InvalidRequestError:
    return client_error(INVALID_ARGUMENT, message)


def read_heads(
    body: object, asked: Sequence[str], trace_id: str | None
) -> StoredVersions:
    """The check `GET /datasets/heads` answered for the specs `asked`, each
    entry read by its `spec_id` whatever the order.

    Raises:
        ContractError: The body is not an object with a `heads` list, an entry
            names a spec the request did not or names one twice, an asked spec
            has no entry, or an entry lacks `content_version` or holds one that
            is neither null nor a `cv_` version (`contract_violation`).
    """
    entries = body.get("heads") if isinstance(body, Mapping) else None
    if not isinstance(entries, list):
        raise _violation("/heads", "is not a list", trace_id)
    wanted = set(asked)
    heads: dict[str, str | None] = {}
    for index, entry in enumerate(entries):
        head = entry if isinstance(entry, Mapping) else {}
        spec_id = head.get("spec_id")
        if not isinstance(spec_id, str) or spec_id not in wanted:
            raise _violation(
                f"/heads/{index}/spec_id", "names no spec the request named", trace_id
            )
        if spec_id in heads:
            raise _violation(f"/heads/{index}/spec_id", "repeats a spec", trace_id)
        version = head.get("content_version")
        if "content_version" not in head or not (
            version is None or matches(CONTENT_VERSION, version)
        ):
            raise _violation(
                f"/heads/{index}/content_version",
                "is neither null nor a dataset version",
                trace_id,
            )
        heads[spec_id] = version
    if missing := [spec_id for spec_id in asked if spec_id not in heads]:
        raise _violation("/heads", f"leaves out {', '.join(missing)}", trace_id)
    return StoredVersions(heads)


def _violation(pointer: str, fault: str, trace_id: str | None) -> ContractError:
    error = client_error(
        CONTRACT_VIOLATION,
        f"{_ROUTE} answered heads whose {pointer} {fault}",
        trace_id=trace_id,
    )
    error.pointer = pointer
    return error
