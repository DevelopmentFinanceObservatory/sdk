"""Specs and dataset refs: the stored formats, equality and pickling."""

import json
import pickle
from pathlib import Path
from typing import Any

import pytest

from dfo._core.parse import parse_citation, parse_parts
from dfo._core.refs import DatasetRef, Member
from dfo._core.types import DefinitePart, FormatError, Rendering, Spec
from tests._data import CONTRACT, load

REF_EXAMPLES = sorted((CONTRACT / "refs").glob("*.json"))
ACCEPTED = [
    path for path in REF_EXAMPLES if "error" not in json.loads(path.read_text())
]
REJECTED = [path for path in REF_EXAMPLES if path not in ACCEPTED]


def example(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def test_the_contract_has_accepted_and_rejected_refs() -> None:
    assert ACCEPTED
    assert REJECTED


@pytest.mark.parametrize("path", ACCEPTED, ids=lambda path: path.stem)
def test_accepted_refs_round_trip(path: Path) -> None:
    ref_json = example(path)["ref"]
    ref = DatasetRef.from_json(json.dumps(ref_json))
    assert json.loads(ref.to_json()) == ref_json
    assert DatasetRef.from_json(ref.to_json()) == ref
    for member, member_json in zip(ref.members, ref_json["members"], strict=True):
        assert member.spec.sentence == member_json["sentence"]


@pytest.mark.parametrize("path", REJECTED, ids=lambda path: path.stem)
def test_rejected_refs_raise_with_their_reason(path: Path) -> None:
    record = example(path)
    expected = (
        "format_invalid"
        if record["error"]["by"] == "schema"
        else record["error"]["reason"]
    )
    with pytest.raises(FormatError) as raised:
        DatasetRef.from_json(json.dumps(record["ref"]))
    assert raised.value.reason == expected


def accepted_ref() -> dict[str, Any]:
    return example(CONTRACT / "refs" / "ref-answer-member.json")["ref"]


@pytest.mark.parametrize(
    ("pointer", "value"),
    [
        ("/format_version", 2),
        ("/format_version", True),
        ("/extra", 1),
        ("/members/0/parts", [""]),
        ("/members/0/sentence", ""),
        ("/members/0/spec/sentence", "a sentence"),
        ("/members/0/spec/spec_id", "spec_short"),
        ("/members/0/spec/definition/schema_version", 1.5),
        ("/members/0/spec/definition/schema_version", True),
        ("/members/0/spec/definition/sentence", "a sentence"),
        ("/members/0/spec/definition/identity", "spec1"),
        ("/members/0/content_version", "cv_short"),
        ("/members/0/artifact/digest", "sha256:abc"),
        ("/members/0/artifact/rendering/format", "json"),
        ("/members/0/artifact/rendering/bundle", 0),
        ("/members/0/artifact/rendering/layout", "long"),
        ("/members/0/artifact/url", "/api/datasets/x"),
    ],
)
def test_refs_breaking_the_format_name_the_pointer(pointer: str, value: object) -> None:
    ref = accepted_ref()
    *parents, key = pointer.strip("/").split("/")
    target: Any = ref
    for step in parents:
        target = target[int(step)] if step.isdigit() else target[step]
    target[key] = value
    with pytest.raises(FormatError) as raised:
        DatasetRef.from_json(json.dumps(ref))
    assert (raised.value.reason, raised.value.pointer) == ("format_invalid", pointer)


@pytest.mark.parametrize("text", ["", "[]", "{", b"\xff"])
def test_text_that_is_not_a_json_object_raises(text: str | bytes) -> None:
    with pytest.raises(FormatError) as raised:
        DatasetRef.from_json(text)
    assert raised.value.reason == "format_invalid"


@pytest.mark.parametrize("schema_version", [2, 1.0])
def test_a_ref_keeps_the_definition_as_stored(schema_version: float) -> None:
    ref_json = accepted_ref()
    definition = ref_json["members"][0]["spec"]["definition"]
    definition["schema_version"] = schema_version
    definition["identity"]["novel"] = {"kept": [1, 2]}
    ref = DatasetRef.from_json(json.dumps(ref_json))
    assert ref.members[0].spec.definition == definition
    assert json.loads(ref.to_json())["members"][0]["spec"]["definition"] == definition


def test_a_ref_of_dataset_members_writes_the_stored_format() -> None:
    # The manifest of the build the contract's ref names, which serves its member.
    record = example(CONTRACT / "refs" / "ref-answer-member.json")
    scenario = example(CONTRACT / "scenarios" / f"{record['scenario']}.json")
    manifest = scenario["exchanges"][0]["response"]["json"]
    (part,) = parse_parts(load("probe-resubmit-identity.json"))
    assert isinstance(part, DefinitePart)
    assert part.spec.sentence is not None
    member = Member(
        parts=("ODA disbursements for basic health care",),
        spec=part.spec,
        content_version=manifest["content_version"],
        sentence=part.spec.sentence,
        citation=parse_citation(manifest["citation"]),
        digest=manifest["artifacts"][0]["artifact_digest"],
        rendering=Rendering("parquet", bundle=False),
    )
    ref = DatasetRef.of([member])
    stored = json.loads(ref.to_json())
    assert stored["members"][0]["spec"]["definition"] == manifest["definition"]
    assert stored == accepted_ref()


def test_spec_round_trips_with_its_sentence() -> None:
    (part,) = parse_parts(load("search-1.json"))
    assert isinstance(part, DefinitePart)
    loaded = Spec.from_json(part.spec.to_json())
    assert loaded == part.spec
    assert (loaded.definition, loaded.sentence) == (
        part.spec.definition,
        part.spec.sentence,
    )


@pytest.mark.parametrize(
    ("edit", "reason"),
    [
        ({"sentence": ""}, "format_invalid"),
        ({"resolved": {}}, "format_invalid"),
        (
            {"spec_id": "spec_" + "0" * 32},
            "definition_spec_id_mismatch",
        ),
    ],
)
def test_spec_json_breaking_the_format_raises(
    edit: dict[str, Any], reason: str
) -> None:
    (part,) = parse_parts(load("search-1.json"))
    assert isinstance(part, DefinitePart)
    obj = json.loads(part.spec.to_json()) | edit
    with pytest.raises(FormatError) as raised:
        Spec.from_json(json.dumps(obj))
    assert raised.value.reason == reason


def test_specs_are_equal_and_hashed_on_spec_id() -> None:
    (part,) = parse_parts(load("search-1.json"))
    assert isinstance(part, DefinitePart)
    bare = Spec(part.spec.spec_id, {"spec_id": part.spec.spec_id})
    assert bare == part.spec
    assert len({bare, part.spec}) == 1
    assert repr(bare) == f"Spec(spec_id='{bare.spec_id}', sentence=None)"


def test_answer_parts_hash_and_pickle() -> None:
    parts = parse_parts(load("search-4.json")) + parse_parts(load("search-2.json"))
    assert len(set(parts)) == len(parts)
    assert pickle.loads(pickle.dumps(parts)) == parts


def test_a_ref_pickles() -> None:
    ref = DatasetRef.from_json(json.dumps(accepted_ref()))
    assert pickle.loads(pickle.dumps(ref)) == ref


@pytest.mark.parametrize(
    ("selector", "server", "matches"),
    [
        (
            Rendering("parquet", bundle=False),
            {"bundle": False, "format": "parquet", "layout": 3},
            True,
        ),
        (Rendering("parquet", bundle=False), {"statistics": "series"}, False),
        (
            Rendering("parquet", bundle=False),
            {"format": "parquet", "bundle": True},
            False,
        ),
        (
            Rendering("parquet", bundle=False, layout="frame"),
            {"format": "parquet", "bundle": False, "layout": "frame"},
            True,
        ),
        (
            Rendering("parquet", bundle=False, layout="frame"),
            {"format": "parquet", "bundle": False, "layout": 3},
            False,
        ),
        (Rendering("csv", bundle=True), {"format": "csv", "bundle": True}, True),
    ],
)
def test_a_rendering_matches_on_format_bundle_and_frame(
    selector: Rendering, server: dict[str, Any], matches: bool
) -> None:
    assert selector.matches(server) is matches
