"""`data.provenance` and `Provenance.from_object`, against the contract's
provenance schema and examples."""

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import jsonschema
import pytest
from referencing import Registry, Resource

import dfo
from dfo._core.types import FormatError
from dfo._datasets.bundle import load as load_saved
from dfo._datasets.dataset import Dataset
from tests._data import CONTRACT
from tests.datasets.test_dataset import _derived, _saved, built

_EXAMPLES = sorted((CONTRACT / "provenance").glob("*.json"))


def _validator() -> jsonschema.Draft202012Validator:
    """The provenance schema, with the schemas it refers to by `$id`."""
    schemas = [
        json.loads((CONTRACT / name).read_text())
        for name in (
            "provenance.schema.json",
            "dataset-ref.schema.json",
            "saved-file.schema.json",
        )
    ]
    registry = Registry().with_resources(
        (schema["$id"], Resource.from_contents(schema)) for schema in schemas
    )
    return jsonschema.Draft202012Validator(schemas[0], registry=registry)


def test_the_examples_exist() -> None:
    assert any("expect" in json.loads(path.read_text()) for path in _EXAMPLES)


@pytest.mark.parametrize("path", _EXAMPLES, ids=lambda path: path.stem)
def test_a_provenance_example_reads_back_unchanged_or_is_refused_as_stated(
    path: Path,
) -> None:
    example = json.loads(path.read_text())
    if example.get("expect") == "accept":
        provenance = dfo.Provenance.from_object(example["provenance"])
        assert provenance.to_object() == example["provenance"]
        return
    with pytest.raises(FormatError) as caught:
        dfo.Provenance.from_object(example["provenance"])
    if example["error"]["by"] == "rule":
        assert caught.value.reason == example["error"]["reason"]


@pytest.mark.parametrize(
    "make", [_saved, _derived, built], ids=["two-members", "derived", "one-member"]
)
def test_a_dataset_and_its_saved_copy_hold_one_provenance(
    make: Callable[[], Dataset], tmp_path: Path
) -> None:
    data = make()
    record = data.provenance.to_object()
    _validator().validate(record)
    # A pipeline stores the record as JSON text and reads it back.
    assert dfo.Provenance.from_object(json.loads(json.dumps(record))) == (
        data.provenance
    )
    path = tmp_path / "saved.parquet"
    data.save(path)
    loaded = load_saved(path)
    assert loaded.provenance == data.provenance
    assert loaded.provenance.to_object() == record


def test_the_provenance_names_the_versions_the_ref_names() -> None:
    data = _saved()
    provenance = data.provenance
    assert provenance.ref == data.ref
    assert provenance.to_object()["ref"] == json.loads(data.ref.to_json())


@pytest.mark.parametrize(
    ("change", "pointer"),
    [
        (json.dumps, ""),
        (lambda record: {**record, "pinned": "no"}, "/pinned"),
        (lambda record: {**record, "fetched_at": "13 November 2026"}, "/fetched_at"),
        (lambda record: {**record, "held_until": "20261118"}, "/held_until"),
        (
            lambda record: {**record, "ref": {**record["ref"], "members": []}},
            "/ref/members",
        ),
        (
            lambda record: {
                **record,
                "members": [
                    {**record["members"][0], "parts": []},
                    record["members"][1],
                ],
            },
            "/members/0/parts",
        ),
    ],
    ids=["json-text", "pinned", "fetched-at", "held-until", "ref", "member-parts"],
)
def test_a_malformed_record_is_refused_at_its_pointer(
    change: Callable[[dict[str, Any]], object], pointer: str
) -> None:
    record = _saved().provenance.to_object()
    with pytest.raises(FormatError) as caught:
        dfo.Provenance.from_object(change(record))
    assert (caught.value.reason, caught.value.pointer) == ("format_invalid", pointer)
