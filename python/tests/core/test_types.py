"""Specs and dataset refs: the ref format, equality, same data and pickling."""

import json
import pickle
from pathlib import Path
from typing import Any

import pytest

from dfo._core.errors import InvalidRequestError
from dfo._core.json_text import JSON_MAX_DEPTH
from dfo._core.parse import parse_citation, parse_parts
from dfo._core.refs import DatasetRef, DerivedRefMember, Groupby, Member, RefMember
from dfo._core.types import DefinitePart, FormatError, Rendering, Spec
from tests._data import CONTRACT, load
from tests.rule_vectors import ids, vectors

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


def written(ref_json: dict[str, Any]) -> dict[str, Any]:
    """`ref_json` as a client writes it back: the cut in its ref spelling,
    `without_party_totals: true`, whichever spelling it was read in."""
    ref_json = json.loads(json.dumps(ref_json))
    for member in ref_json["members"]:
        rendering = member["artifact"]["rendering"]
        if rendering.pop("party_totals", None) is False:
            rendering.pop("without_party_totals", None)
            rendering["without_party_totals"] = True
    return ref_json


@pytest.mark.parametrize("path", ACCEPTED, ids=lambda path: path.stem)
def test_accepted_refs_round_trip(path: Path) -> None:
    ref_json = example(path)["ref"]
    ref = DatasetRef.from_json(json.dumps(ref_json))
    assert ref.to_json() == json.dumps(written(ref_json), ensure_ascii=False)
    assert DatasetRef.from_json(ref.to_json()) == ref
    for member, member_json in zip(ref.members, ref_json["members"], strict=True):
        if isinstance(member, RefMember):
            assert member.spec.sentence == member_json["sentence"]


def test_either_spelling_of_the_cut_reads_as_one_ref() -> None:
    old, new, both = (
        DatasetRef.from_json(json.dumps(example(CONTRACT / "refs" / name)["ref"]))
        for name in (
            "ref-without-party-totals.json",
            "ref-party-totals.json",
            "ref-party-totals-both.json",
        )
    )
    assert old.members[0].rendering.without_party_totals
    assert old == new == both
    assert hash(old) == hash(new) == hash(both)
    assert old.same_data(new)
    assert old.same_data(both)


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


def derived_ref() -> dict[str, Any]:
    return example(CONTRACT / "refs" / "ref-derived-member.json")["ref"]


def grouped_ref() -> dict[str, Any]:
    return example(CONTRACT / "refs" / "ref-derived-grouped-root.json")["ref"]


def _edited(ref: dict[str, Any], pointer: str, value: object) -> dict[str, Any]:
    """`ref` with the value at `pointer` replaced."""
    *parents, key = pointer.strip("/").split("/")
    target: Any = ref
    for step in parents:
        target = target[int(step)] if step.isdigit() else target[step]
    if isinstance(target, list):
        target[int(key)] = value
    else:
        target[key] = value
    return ref


@pytest.mark.parametrize(
    ("pointer", "value"),
    [
        ("/format_version", 3),
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
        ("/members/0/artifact/rendering/without_party_totals", False),
        ("/members/0/artifact/rendering/without_party_totals", "true"),
        ("/members/0/artifact/rendering/party_totals", True),
        ("/members/0/artifact/rendering/party_totals", 0),
        ("/members/0/artifact/url", "/api/datasets/x"),
    ],
)
def test_refs_breaking_the_format_name_the_pointer(pointer: str, value: object) -> None:
    ref = _edited(accepted_ref(), pointer, value)
    with pytest.raises(FormatError) as raised:
        DatasetRef.from_json(json.dumps(ref))
    assert (raised.value.reason, raised.value.pointer) == ("format_invalid", pointer)


# Each row breaks one check of a derived member that no contract record pins.
@pytest.mark.parametrize(
    ("pointer", "value"),
    [
        ("/members/0/spec/spec_id", "spec_" + "0" * 32),
        ("/members/0/spec/recipe/normal_form_hash", "rnf_short"),
        ("/members/0/spec/recipe/replay_key", "rnf_" + "0" * 32),
        ("/members/0/content_version", "cv_" + "0" * 32),
        ("/members/0/output_digest", "sha256:" + "0" * 64),
        ("/members/0/roots", []),
        ("/members/0/roots/0/spec_id", "ops_" + "0" * 32),
        ("/members/0/roots/0/content_version", "ocv_" + "0" * 32),
        ("/members/0/execution_identity", "0.9.0|1.1.0"),
        ("/members/0/resolved_periods/0/anchor", "first"),
        ("/members/0/resolved_periods/0/offset", -1.5),
        ("/members/0/resolved_periods/0/rule", "half2"),
        ("/members/0/resolved_periods/0/period", "20x0"),
        (
            "/members/0/resolved_periods/1",
            {"anchor": "latest", "offset": -3, "rule": "half1", "period": "2020"},
        ),
    ],
)
def test_derived_refs_breaking_the_format_name_the_pointer(
    pointer: str, value: object
) -> None:
    ref = _edited(derived_ref(), pointer, value)
    with pytest.raises(FormatError) as raised:
        DatasetRef.from_json(json.dumps(ref))
    assert (raised.value.reason, raised.value.pointer) == ("format_invalid", pointer)


# Each row breaks one check of a root's groupby that no contract record pins.
@pytest.mark.parametrize(
    ("pointer", "value"),
    [
        ("/by", []),
        ("/by", [""]),
        ("/by", ["time_period", "time_period"]),
        ("/levels", {}),
        ("/levels/crsPurpose", 100),
        ("/levels/crsPurpose", True),
        ("/axis", "time_period"),
    ],
)
def test_grouped_roots_breaking_the_format_name_the_pointer(
    pointer: str, value: object
) -> None:
    groupby = "/members/0/roots/0/rendering/groupby"
    ref = _edited(grouped_ref(), groupby + pointer, value)
    with pytest.raises(FormatError) as raised:
        DatasetRef.from_json(json.dumps(ref))
    assert raised.value.reason == "format_invalid"
    assert raised.value.pointer == groupby + pointer


def test_a_grouped_root_keeps_its_groupby() -> None:
    ref = DatasetRef.from_json(json.dumps(grouped_ref()))
    (member,) = ref.members
    assert isinstance(member, DerivedRefMember)
    (root,) = member.roots
    assert root.groupby == Groupby(
        by=("crsPurpose", "time_period"), op="sum", levels={"crsPurpose": 0}
    )
    assert root.rendering.without_party_totals
    revived = pickle.loads(pickle.dumps(ref)).members[0]
    assert revived.roots == member.roots
    assert len({root, *revived.roots}) == 1


def test_a_groupby_is_normalised_at_construction() -> None:
    plain = Groupby(by=("time_period",), op="sum")
    assert Groupby(by=["time_period"], op="sum", levels={}) == plain
    assert hash(Groupby(by=("time_period",), op="sum", levels={})) == hash(plain)
    ordered = Groupby(by=("a", "b"), op="sum", levels={"a": 0, "b": 1})
    reordered = Groupby(by=("a", "b"), op="sum", levels={"b": 1, "a": 0})
    assert (ordered, hash(ordered)) == (reordered, hash(reordered))
    assert reordered.to_object()["levels"] == {"a": 0, "b": 1}
    with pytest.raises(TypeError):
        ordered.levels["a"] = 3


def test_a_root_repeated_with_its_levels_reordered_is_refused() -> None:
    ref = grouped_ref()
    roots = ref["members"][0]["roots"]
    roots[0]["rendering"]["groupby"]["levels"] = {"crsPurpose": 0, "time_period": 1}
    again = json.loads(json.dumps(roots[0]))
    again["rendering"]["groupby"]["levels"] = {"time_period": 1, "crsPurpose": 0}
    roots.append(again)
    with pytest.raises(FormatError) as raised:
        DatasetRef.from_json(json.dumps(ref))
    assert raised.value.pointer == "/members/0/roots/1"


def test_a_repeated_root_is_refused() -> None:
    ref = derived_ref()
    roots = ref["members"][0]["roots"]
    roots.append(roots[0])
    with pytest.raises(FormatError) as raised:
        DatasetRef.from_json(json.dumps(ref))
    assert raised.value.pointer == "/members/0/roots/1"


def test_a_ref_holds_one_kind_of_member() -> None:
    (dataset_member,) = DatasetRef.from_json(json.dumps(accepted_ref())).members
    (derived_member,) = DatasetRef.from_json(json.dumps(derived_ref())).members
    with pytest.raises(InvalidRequestError) as caught:
        DatasetRef((dataset_member, derived_member))
    assert caught.value.code == "invalid_argument"


def test_a_ref_refuses_a_member_of_neither_kind() -> None:
    (member,) = DatasetRef.from_json(json.dumps(accepted_ref())).members
    with pytest.raises(InvalidRequestError, match="not Spec") as caught:
        DatasetRef((member.spec,))
    assert caught.value.code == "invalid_argument"


def _ref(obj: dict[str, Any]) -> DatasetRef:
    return DatasetRef.from_json(json.dumps(obj))


@pytest.mark.parametrize(
    "vector", vectors("output-comparison"), ids=ids("output-comparison")
)
def test_the_output_comparison_vectors(vector: dict[str, Any]) -> None:
    left, right = _ref(vector["left"]), _ref(vector["right"])
    for mine, theirs in ((left, right), (right, left)):
        assert (mine == theirs) is vector["equal"]
        assert mine.same_data(theirs) is vector["same_data"]
    if vector["equal"]:
        assert hash(left) == hash(right)


def test_same_data_takes_a_ref() -> None:
    stored = derived_ref()
    with pytest.raises(InvalidRequestError) as caught:
        # The ref's JSON in place of the ref, the mistake the check names.
        _ref(stored).same_data(stored)
    assert caught.value.code == "invalid_argument"


@pytest.mark.parametrize(
    "text",
    ["", "[]", "{", b"\xff", "[" * (JSON_MAX_DEPTH + 1) + "]" * (JSON_MAX_DEPTH + 1)],
    ids=["empty", "array", "cut-off", "not-utf-8", "past-the-depth-bound"],
)
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
    search, build = scenario["exchanges"][:2]
    manifest = build["response"]["json"]
    (part,) = parse_parts(search["response"]["json"])
    assert isinstance(part, DefinitePart)
    assert part.spec.sentence is not None
    member = Member(
        parts=("ODA disbursements for basic health care",),
        spec=part.spec,
        content_version=manifest["content_version"],
        sentence=part.spec.sentence,
        citation=parse_citation(manifest["citation"]),
        digest=manifest["artifacts"][0]["artifact_digest"],
        rendering=Rendering("parquet", bundle=False, without_party_totals=True),
    )
    ref = DatasetRef.of([member])
    stored = json.loads(ref.to_json())
    assert stored["members"][0]["spec"]["definition"] == manifest["definition"]
    assert stored == accepted_ref()


def test_specs_are_equal_and_hashed_on_spec_id() -> None:
    (part,) = parse_parts(load("search-1.json"))
    assert isinstance(part, DefinitePart)
    bare = Spec(part.spec.spec_id, {"spec_id": part.spec.spec_id})
    assert bare == part.spec
    assert len({bare, part.spec}) == 1
    assert repr(bare) == f"Spec({bare.spec_id})"


def test_answer_parts_hash_and_pickle() -> None:
    parts = parse_parts(load("search-4.json")) + parse_parts(load("search-2.json"))
    assert len(set(parts)) == len(parts)
    assert pickle.loads(pickle.dumps(parts)) == parts


@pytest.mark.parametrize("ref_json", [accepted_ref(), derived_ref()])
def test_a_ref_pickles(ref_json: dict[str, Any]) -> None:
    ref = DatasetRef.from_json(json.dumps(ref_json))
    assert pickle.loads(pickle.dumps(ref)) == ref


# The format writes `without_party_totals` only when true, so a plain rendering is
# the key removed.
DROPPED = object()


@pytest.mark.parametrize(
    ("pointer", "value", "equal"),
    [
        ("/content_version", "cv_" + "0" * 32, False),
        ("/artifact/rendering/without_party_totals", DROPPED, False),
        ("/artifact/digest", "sha256:" + "0" * 64, True),
        ("/sentence", "Another sentence for the same reading.", True),
        ("/parts", ["another part"], True),
    ],
)
def test_refs_are_equal_on_spec_version_and_rendering(
    pointer: str, value: object, *, equal: bool
) -> None:
    ref_json = accepted_ref()
    edited = json.loads(json.dumps(ref_json))
    *parents, key = pointer.strip("/").split("/")
    target: Any = edited["members"][0]
    for step in parents:
        target = target[step]
    if value is DROPPED:
        del target[key]
    else:
        target[key] = value
    ref = DatasetRef.from_json(json.dumps(ref_json))
    other = DatasetRef.from_json(json.dumps(edited))
    assert (ref == other, hash(ref) == hash(other)) == (equal, equal)


def test_a_ref_repr_names_each_spec_at_its_version() -> None:
    ref = DatasetRef.from_json(json.dumps(accepted_ref()))
    (member,) = ref.members
    text = repr(ref)
    assert text.startswith("DatasetRef(1 member: ")
    assert f"{member.spec.spec_id} at {member.content_version}" in text


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
        # The party-totals flag plays no part in the match.
        (
            Rendering("parquet", bundle=False),
            {"format": "parquet", "bundle": False, "without_party_totals": True},
            True,
        ),
        (
            Rendering("parquet", bundle=False, without_party_totals=True),
            {"format": "parquet", "bundle": False, "layout": 3},
            True,
        ),
    ],
)
def test_a_rendering_matches_on_format_bundle_and_frame(
    selector: Rendering, server: dict[str, Any], matches: bool
) -> None:
    assert selector.matches(server) is matches
