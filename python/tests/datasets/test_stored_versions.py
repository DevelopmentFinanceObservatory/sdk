"""`StoredVersions`, its saved form, and the spec ids and answers of a check,
beyond what the contract's `stored-versions-*` scenarios replay."""

import json
from pathlib import Path
from types import MappingProxyType
from typing import Any

import jsonschema
import pytest

from dfo._core.errors import ContractError, InvalidRequestError
from dfo._core.refs import DatasetRef
from dfo._core.types import FormatError, Spec
from dfo._datasets.bundle import load as load_saved
from dfo._datasets.recipe import Recipe, _Root, recipe
from dfo._datasets.stored_versions import StoredVersions, read_heads, spec_ids
from tests._data import CONTRACT, DATA
from tests.datasets.test_bundle import CSV_BUNDLE, extracted

A = "spec_" + "a" * 32
B = "spec_" + "b" * 32
C = "spec_" + "c" * 32
V1 = "cv_" + "1" * 32
V2 = "cv_" + "2" * 32
OPS = "ops_" + "a" * 32

# The text both clients write for `{A: V1, B: None}`, byte for byte; the
# TypeScript test pins the same string.
SAVED_TEXT = (
    '{"format_version":1,"heads":['
    '{"spec_id":"spec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",'
    '"content_version":"cv_11111111111111111111111111111111"},'
    '{"spec_id":"spec_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","content_version":null}]}'
)


def _spec(spec_id: str) -> Spec:
    return Spec(spec_id, {"schema_version": 1, "spec_id": spec_id})


def _example_ref(name: str) -> DatasetRef:
    example = json.loads((CONTRACT / "refs" / f"{name}.json").read_text())
    return DatasetRef.from_json(json.dumps(example["ref"]))


def test_to_json_writes_the_saved_form_sorted_and_reads_back() -> None:
    found = StoredVersions({B: None, A: V1})
    text = found.to_json()
    schema = json.loads((CONTRACT / "stored-versions.schema.json").read_text())
    jsonschema.Draft202012Validator(schema).validate(json.loads(text))
    assert [head["spec_id"] for head in json.loads(text)["heads"]] == [A, B]
    assert StoredVersions.from_json(text) == found
    assert StoredVersions.from_json(json.loads(text)) == found
    assert hash(StoredVersions.from_json(text.encode())) == hash(found)
    assert StoredVersions.from_json(MappingProxyType(json.loads(text))) == found


def test_to_json_writes_the_text_both_clients_write() -> None:
    assert StoredVersions({B: None, A: V1}).to_json() == SAVED_TEXT


@pytest.mark.parametrize(
    "heads",
    [
        {},
        {f"spec_{index:032x}": None for index in range(65)},
        {"spec_A": V1},
        {OPS: None},
        {A: "ocv_" + "1" * 32},
        {A: 1},
        [(A, V1)],
    ],
    ids=["empty", "65", "bad-id", "ops-id", "bad-version", "number", "not-mapping"],
)
def test_the_constructor_refuses_heads_from_json_would_refuse(heads: Any) -> None:
    with pytest.raises(InvalidRequestError) as caught:
        StoredVersions(heads)
    assert caught.value.code == "invalid_argument"


def test_the_constructor_takes_64_heads() -> None:
    heads = {f"spec_{index:032x}": None for index in range(64)}
    assert len(StoredVersions(heads).heads) == 64


def test_the_repr_counts_the_specs_and_the_stored_versions() -> None:
    assert repr(StoredVersions({A: V1, B: None})) == (
        "StoredVersions(2 specs, 1 with a stored version)"
    )


@pytest.mark.parametrize(
    ("built", "changed"),
    [
        ({A: V1, B: None}, []),
        ({A: V2, B: None}, [A]),
        ({A: None, B: None}, [A]),
        ({A: V1, B: V2}, [B]),
        ({A: V1}, [B]),
        ({A: V1, B: None, C: V1}, []),
    ],
    ids=["same", "other-version", "was-null", "now-null", "not-listed", "extra"],
)
def test_changed_since_names_each_spec_whose_head_differs(
    built: dict[str, str | None], changed: list[str]
) -> None:
    now = StoredVersions({A: V1, B: None})
    assert now.changed_since(StoredVersions(built)) == changed


def test_changed_since_refuses_saved_text() -> None:
    now = StoredVersions({A: V1})
    with pytest.raises(InvalidRequestError, match="from_json") as caught:
        now.changed_since(now.to_json())  # ty: ignore[invalid-argument-type]
    assert caught.value.code == "invalid_argument"


def _saved(**changes: Any) -> dict[str, Any]:
    record: dict[str, Any] = {
        "format_version": 1,
        "heads": [
            {"spec_id": A, "content_version": V1},
            {"spec_id": B, "content_version": None},
        ],
    }
    return record | changes


@pytest.mark.parametrize(
    ("record", "pointer"),
    [
        (_saved(format_version=2), "/format_version"),
        (_saved(format_version=True), "/format_version"),
        (_saved(heads=[]), "/heads"),
        (_saved(extra=1), "/extra"),
        (_saved(heads=[{"spec_id": A}]), "/heads/0/content_version"),
        (
            _saved(heads=[{"spec_id": A, "content_version": V1, "x": 1}]),
            "/heads/0/x",
        ),
        (
            _saved(heads=[{"spec_id": "ops_" + "a" * 32, "content_version": None}]),
            "/heads/0/spec_id",
        ),
        (
            _saved(heads=[{"spec_id": A, "content_version": "ocv_" + "1" * 32}]),
            "/heads/0/content_version",
        ),
        (
            _saved(
                heads=[
                    {"spec_id": A, "content_version": V1},
                    {"spec_id": A, "content_version": V2},
                ]
            ),
            "/heads/1/spec_id",
        ),
    ],
)
def test_from_json_refuses_a_record_that_breaks_the_format(
    record: dict[str, Any], pointer: str
) -> None:
    with pytest.raises(FormatError) as caught:
        StoredVersions.from_json(json.dumps(record))
    assert (caught.value.code, caught.value.pointer) == ("format_invalid", pointer)


def test_spec_ids_reads_each_spec_once_sorted() -> None:
    chain = recipe(_spec(C)).share_of(_spec(A), by="origin")
    assert spec_ids([_spec(B), chain, _spec(A)]) == [A, B, C]


def test_a_recipe_of_several_readings_reads_each_member() -> None:
    members = [
        _example_ref(name).members[0]
        for name in ("ref-one-member", "ref-answer-member")
    ]
    ref = DatasetRef(tuple(members))
    assert len({member.spec.spec_id for member in members}) == 2
    asked = spec_ids([recipe(ref).rank(by="origin", limit=5)])
    assert asked == sorted(member.spec.spec_id for member in ref.members)


def test_a_dataset_names_the_specs_its_ref_names() -> None:
    data = load_saved(DATA / "saved-python.parquet")
    expected = [
        "spec_7a02b6facd2dc17b5d0d7c35c11bf5d2",
        "spec_b5673e60c045b10f8beeed2ce50dbd18",
    ]
    assert spec_ids([data]) == expected
    assert spec_ids([data.ref]) == expected


def test_a_dataset_that_names_no_version_is_refused(tmp_path: Path) -> None:
    data = load_saved(extracted(CSV_BUNDLE, tmp_path / "bundle"))
    with pytest.raises(InvalidRequestError) as caught:
        spec_ids([data])
    assert caught.value.code == "ref_unavailable"


def test_a_derived_member_names_its_roots() -> None:
    ref = _example_ref("ref-derived-member")
    assert spec_ids([ref]) == ["spec_cb5baa4161de718f18583060674dbca6"]


def test_a_check_names_64_specs_and_refuses_65() -> None:
    specs = [_spec(f"spec_{index:032x}") for index in range(65)]
    assert len(spec_ids(specs[:64])) == 64
    with pytest.raises(InvalidRequestError) as caught:
        spec_ids(specs)
    assert caught.value.code == "invalid_argument"


@pytest.mark.parametrize(
    "target",
    [
        _spec("spec_A"),
        _spec(OPS),
        recipe(_spec("spec_A")).aggregate(),
        Recipe(_Root({"spec_id": None}, "none")),
        Recipe(_Root({"rendering": {}}, "nothing")),
    ],
    ids=["spec-bad-id", "spec-ops-id", "recipe-bad-id", "root-null-id", "root-no-id"],
)
def test_a_target_that_names_no_spec_id_is_refused(target: Any) -> None:
    with pytest.raises(InvalidRequestError) as caught:
        spec_ids([target])
    assert caught.value.code == "invalid_argument"


@pytest.mark.parametrize(
    "targets",
    [_spec(A), "spec_" + "a" * 32, [A], [None], {"spec": A}],
    ids=["one-target", "text", "id", "none", "mapping"],
)
def test_spec_ids_refuses_what_is_not_a_list_of_targets(targets: object) -> None:
    with pytest.raises(InvalidRequestError) as caught:
        spec_ids(targets)
    assert caught.value.code == "invalid_argument"


@pytest.mark.parametrize(
    ("body", "pointer"),
    [
        ([], "/heads"),
        ({"heads": {}}, "/heads"),
        ({"heads": ["x"]}, "/heads/0/spec_id"),
        ({"heads": [{"spec_id": C, "content_version": None}]}, "/heads/0/spec_id"),
        (
            {
                "heads": [
                    {"spec_id": A, "content_version": None},
                    {"spec_id": A, "content_version": None},
                ]
            },
            "/heads/1/spec_id",
        ),
        ({"heads": [{"spec_id": A}]}, "/heads/0/content_version"),
        ({"heads": [{"spec_id": A, "content_version": 1}]}, "/heads/0/content_version"),
        ({"heads": [{"spec_id": A, "content_version": V1}]}, "/heads"),
    ],
    ids=[
        "not-object",
        "not-list",
        "not-entry",
        "not-asked",
        "repeated",
        "no-version",
        "bad-version",
        "missing-spec",
    ],
)
def test_read_heads_refuses_an_answer_it_cannot_read(
    body: object, pointer: str
) -> None:
    with pytest.raises(ContractError) as caught:
        read_heads(body, [A, B], "trace")
    error = caught.value
    assert (error.code, error.pointer, error.trace_id) == (
        "contract_violation",
        pointer,
        "trace",
    )


def test_read_heads_reads_entries_in_any_order_and_ignores_added_members() -> None:
    body = {
        "heads": [
            {"spec_id": B, "content_version": None, "added": 1},
            {"spec_id": A, "content_version": V1},
        ],
        "added": True,
    }
    assert read_heads(body, [A, B], None) == StoredVersions({A: V1, B: None})
