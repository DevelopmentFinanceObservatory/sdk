"""`data.provenance` and `Provenance.from_json`, against the contract's
provenance schema and examples."""

import json
from collections.abc import Callable
from dataclasses import replace
from datetime import date
from pathlib import Path
from typing import Any

import jsonschema
import pyarrow.parquet as pq
import pytest
from referencing import Registry, Resource

import dfo
from dfo._core.types import FormatError
from dfo._datasets.bundle import load as load_saved
from dfo._datasets.dataset import Dataset
from tests._data import CONTRACT
from tests.datasets.test_dataset import _derived, _saved, built

_EXAMPLES = sorted((CONTRACT / "provenance").glob("*.json"))
_SCHEMA = json.loads((CONTRACT / "provenance.schema.json").read_text())


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


def _named(record: dict[str, Any]) -> dict[str, Any]:
    """`record` with only the keys the schema names, at the top level and in
    each member, as a reader writes it back."""
    member_keys = _SCHEMA["properties"]["members"]["items"]["properties"]
    named = {
        key: value for key, value in record.items() if key in _SCHEMA["properties"]
    }
    named["members"] = [
        {key: value for key, value in member.items() if key in member_keys}
        for member in record["members"]
    ]
    return named


def test_the_examples_exist() -> None:
    assert any("expect" in json.loads(path.read_text()) for path in _EXAMPLES)


@pytest.mark.parametrize("path", _EXAMPLES, ids=lambda path: path.stem)
def test_a_provenance_example_reads_back_or_is_refused_as_stated(path: Path) -> None:
    example = json.loads(path.read_text())
    text = json.dumps(example["provenance"])
    if example.get("expect") == "accept":
        provenance = dfo.Provenance.from_json(text)
        assert json.loads(provenance.to_json()) == _named(example["provenance"])
        return
    with pytest.raises(FormatError) as caught:
        dfo.Provenance.from_json(text)
    if example["error"]["by"] == "rule":
        assert caught.value.reason == example["error"]["reason"]


def test_a_key_the_format_does_not_name_is_ignored() -> None:
    record = json.loads(_saved().provenance.to_json())
    record["release"] = "2026-11"
    record["members"][0]["release"] = {"name": "2026-11"}
    assert dfo.Provenance.from_json(json.dumps(record)) == _saved().provenance


@pytest.mark.parametrize(
    "make", [_saved, _derived, built], ids=["two-members", "derived", "one-member"]
)
def test_a_dataset_and_its_saved_copy_hold_one_provenance(
    make: Callable[[], Dataset], tmp_path: Path
) -> None:
    data = make()
    text = data.provenance.to_json()
    _validator().validate(json.loads(text))
    assert dfo.Provenance.from_json(text) == data.provenance
    assert dfo.Provenance.from_json(text.encode()) == data.provenance
    path = tmp_path / "saved.parquet"
    data.save(path)
    loaded = load_saved(path)
    assert loaded.provenance == data.provenance
    assert loaded.provenance.to_json() == text


def test_the_provenance_names_the_versions_the_ref_names() -> None:
    data = _saved()
    provenance = data.provenance
    assert provenance.ref == data.ref
    assert json.loads(provenance.to_json())["ref"] == json.loads(data.ref.to_json())


def test_each_member_carries_its_own_retention() -> None:
    record = json.loads(_saved().provenance.to_json())
    assert [(m["pinned"], m["held_until"]) for m in record["members"]] == [
        (False, "2026-11-18"),
        (False, "2026-11-19"),
    ]
    assert (record["pinned"], record["held_until"]) == (False, "2026-11-18")


def test_a_pinned_dataset_pins_every_member() -> None:
    pinned = replace(_saved(), pinned=True, held_until=None)
    assert [(m.pinned, m.held_until) for m in pinned.members] == [(True, None)] * 2
    assert dfo.Provenance.from_json(pinned.provenance.to_json()) == pinned.provenance


@pytest.mark.parametrize(
    ("pinned", "expected"),
    [(False, [(None, None), (None, None)]), (True, [(True, None), (True, None)])],
    ids=["not-pinned", "pinned"],
)
def test_a_file_without_member_retention_reads_what_the_dataset_states(
    pinned: bool, expected: list[tuple[bool | None, date | None]], tmp_path: Path
) -> None:
    data = _saved()
    if pinned:
        data = replace(data, pinned=True, held_until=None)
    path = tmp_path / "saved.parquet"
    data.save(path)
    table = pq.read_table(path)
    metadata = dict(table.schema.metadata)
    del metadata[b"dfo.retention"]
    pq.write_table(table.replace_schema_metadata(metadata), path)
    loaded = load_saved(path)
    assert [(m.pinned, m.held_until) for m in loaded.members] == expected
    assert (loaded.pinned, loaded.held_until) == (data.pinned, data.held_until)


def _member(index: int, **fields: object) -> Callable[[dict[str, Any]], object]:
    def change(record: dict[str, Any]) -> object:
        members = [dict(member) for member in record["members"]]
        members[index].update(fields)
        return {**record, "members": members}

    return change


def _without_member_key(key: str) -> Callable[[dict[str, Any]], object]:
    def change(record: dict[str, Any]) -> object:
        members = [
            {name: value for name, value in member.items() if name != key}
            for member in record["members"]
        ]
        return {**record, "members": members}

    return change


@pytest.mark.parametrize(
    ("change", "pointer"),
    [
        (lambda record: "{", ""),
        (lambda record: [], ""),
        (lambda record: {**record, "format_version": 2}, "/format_version"),
        (lambda record: {**record, "pinned": "no"}, "/pinned"),
        (lambda record: {**record, "fetched_at": "13 November 2026"}, "/fetched_at"),
        (lambda record: {**record, "held_until": "20261118"}, "/held_until"),
        (
            lambda record: {**record, "ref": {**record["ref"], "members": []}},
            "/ref/members",
        ),
        (_member(0, parts=[]), "/members/0/parts"),
        (_member(0, pinned="no"), "/members/0/pinned"),
        (_member(1, held_until="2026-02-30"), "/members/1/held_until"),
        (_without_member_key("held_until"), "/members/0/held_until"),
        (lambda record: {**record, "pinned": True, "held_until": None}, "/pinned"),
        (_member(0, held_until="2026-12-30"), "/held_until"),
    ],
    ids=[
        "not-json",
        "not-an-object",
        "later-format",
        "pinned",
        "fetched-at",
        "held-until",
        "ref",
        "member-parts",
        "member-pinned",
        "member-held-until",
        "member-held-until-missing",
        "pinned-disagrees",
        "held-until-disagrees",
    ],
)
def test_a_malformed_record_is_refused_at_its_pointer(
    change: Callable[[dict[str, Any]], object], pointer: str
) -> None:
    record = json.loads(_saved().provenance.to_json())
    changed = change(record)
    text = changed if isinstance(changed, str) else json.dumps(changed)
    with pytest.raises(FormatError) as caught:
        dfo.Provenance.from_json(text)
    assert (caught.value.reason, caught.value.pointer) == ("format_invalid", pointer)
