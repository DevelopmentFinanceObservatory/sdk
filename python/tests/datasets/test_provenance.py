"""`data.provenance` and `Provenance.from_json`, against the contract's
provenance schema and examples."""

import json
from collections.abc import Callable
from dataclasses import replace
from datetime import date
from pathlib import Path
from typing import Any

import httpx2
import jsonschema
import pyarrow.parquet as pq
import pytest
from referencing import Registry, Resource

import dfo
from dfo._core.types import FormatError, Option
from dfo._datasets.bundle import load as load_saved
from dfo._datasets.dataset import Dataset
from dfo._sync._client.client import Client
from dfo._sync._datasets.fetch import Session
from dfo._sync._http.transport import Transport
from tests._data import CONTRACT
from tests._fetch_support import BASE, Replay
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
            "scenario.schema.json",
        )
    ]
    registry = Registry().with_resources(
        (schema["$id"], Resource.from_contents(schema)) for schema in schemas
    )
    return jsonschema.Draft202012Validator(schemas[0], registry=registry)


def _named(value: object, schema: dict[str, Any] = _SCHEMA) -> object:
    """`value` with only the keys the schema names, in every object it holds
    but the ref, which follows its own schema, as a reader writes it back."""
    if (ref := schema.get("$ref", "")).startswith("#/$defs/"):
        schema = _SCHEMA["$defs"][ref.removeprefix("#/$defs/")]
    if isinstance(value, dict) and "properties" in schema:
        properties = schema["properties"]
        return {
            key: _named(item, properties[key])
            for key, item in value.items()
            if key in properties
        }
    if isinstance(value, list) and "items" in schema:
        return [_named(item, schema["items"]) for item in value]
    return value


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
    record["citation"]["doi"] = "10.1787/x"
    record["citation"]["sources"][0]["publisher"] = "OECD"
    record["members"][1]["citation"]["doi"] = "10.1787/x"
    record["missing"][1]["source"] = "OECD"
    record["warnings"] = [
        {"code": "c", "severity": "info", "message": "m", "spec_id": None, "url": "u"}
    ]
    expected = json.loads(_saved().provenance.to_json())
    expected["warnings"] = [
        {"code": "c", "severity": "info", "message": "m", "spec_id": None}
    ]
    read = dfo.Provenance.from_json(json.dumps(record))
    assert json.loads(read.to_json()) == expected


@pytest.mark.parametrize("value", [42, None, ["{}"]], ids=["number", "null", "list"])
def test_a_value_neither_json_text_nor_an_object_is_refused(value: object) -> None:
    with pytest.raises(FormatError) as caught:
        dfo.Provenance.from_json(value)  # ty: ignore[invalid-argument-type]
    assert (caught.value.reason, caught.value.pointer) == ("format_invalid", "")


def _place_choice() -> Dataset:
    """`_saved` with the gap of a part that awaits a choice of place, whose options
    name the ambiguous wording they settle by `entity_choice`."""
    replay = Replay("choose-place-one-part")
    transport = Transport(
        base_url=BASE, api_key=False, http_transport=httpx2.MockTransport(replay)
    )
    with Client._over(Session(transport, None)) as client:
        answer = client.search(replay.record["call"][0]["question"])
    (gap,) = answer.gaps
    assert any(
        isinstance(option, Option) and option.entity_choice is not None
        for option in gap.options
    )
    return replace(_saved(), complete=False, missing=(gap,))


@pytest.mark.parametrize(
    "make",
    [_saved, _derived, built, _place_choice],
    ids=["two-members", "derived", "one-member", "place-choice"],
)
def test_a_dataset_and_its_saved_copy_hold_one_provenance(
    make: Callable[[], Dataset], tmp_path: Path
) -> None:
    data = make()
    text = data.provenance.to_json()
    _validator().validate(json.loads(text))
    assert dfo.Provenance.from_json(text) == data.provenance
    assert dfo.Provenance.from_json(text.encode()) == data.provenance
    assert dfo.Provenance.from_json(json.loads(text)) == data.provenance
    path = tmp_path / "saved.parquet"
    data.save(path)
    loaded = load_saved(path)
    assert loaded.provenance == data.provenance
    assert loaded.provenance.to_json() == text


def test_a_partial_dataset_states_what_it_left_out() -> None:
    partial = _saved()
    complete = replace(partial, complete=True, missing=())
    record = json.loads(partial.provenance.to_json())
    assert (record["complete"], [gap["kind"] for gap in record["missing"]]) == (
        False,
        ["choice", "no_data"],
    )
    assert json.loads(complete.provenance.to_json())["missing"] == []
    assert partial.provenance != complete.provenance
    read = dfo.Provenance.from_json(record)
    assert (read.complete, read.missing) == (partial.complete, partial.missing)


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


_NOV_18, _NOV_19 = date(2026, 11, 18), date(2026, 11, 19)


@pytest.mark.parametrize(
    ("retention", "expected"),
    [
        ([(True, None), (True, None)], (True, None)),
        ([(True, None), (False, _NOV_19)], (False, _NOV_19)),
        ([(False, _NOV_19), (False, _NOV_18)], (False, _NOV_18)),
        ([(None, None), (False, _NOV_19)], (False, _NOV_19)),
        ([(None, None), (None, None)], (False, None)),
        ([(True, None), (None, _NOV_18)], (False, _NOV_18)),
        ([], (False, None)),
    ],
    ids=[
        "every-member-pinned",
        "one-held",
        "earliest-held",
        "one-unknown",
        "all-unknown",
        "unknown-with-a-date",
        "no-members",
    ],
)
def test_the_dataset_retention_is_the_members(
    retention: list[tuple[bool | None, date | None]],
    expected: tuple[bool, date | None],
) -> None:
    saved = _saved()
    members = tuple(
        replace(member, pinned=pinned, held_until=held)
        for member, (pinned, held) in zip(saved.members, retention, strict=False)
    )
    rows = saved._member_rows if members else ()
    data = replace(saved, members=members, _member_rows=rows)
    assert (data.pinned, data.held_until) == expected
    assert (data.provenance.pinned, data.provenance.held_until) == expected


@pytest.mark.parametrize(
    ("pinned", "expected"),
    [
        (False, [(None, date(2026, 11, 18))] * 2),
        (True, [(True, None), (True, None)]),
    ],
    ids=["not-pinned", "pinned"],
)
def test_a_file_without_member_retention_reads_what_the_dataset_states(
    pinned: bool, expected: list[tuple[bool | None, date | None]], tmp_path: Path
) -> None:
    data = _saved()
    if pinned:
        data = replace(
            data,
            members=tuple(
                replace(member, pinned=True, held_until=None) for member in data.members
            ),
        )
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
        (lambda record: {**record, "complete": "no"}, "/complete"),
        (lambda record: {**record, "complete": True}, "/complete"),
        (lambda record: {**record, "missing": []}, "/complete"),
        (lambda record: {**record, "missing": {}}, "/missing"),
        (
            lambda record: {
                **record,
                "missing": [{**record["missing"][0], "kind": "gone"}],
            },
            "/missing/0/kind",
        ),
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
        "complete-not-boolean",
        "complete-beside-missing",
        "incomplete-without-missing",
        "missing-not-a-list",
        "missing-kind",
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
