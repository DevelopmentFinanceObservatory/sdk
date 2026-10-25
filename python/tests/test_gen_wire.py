"""`scripts/gen_wire.py` refuses a strict-fields contract the served document breaks."""

from typing import Any

import gen_wire
import pytest

SCHEMAS: dict[str, Any] = {
    "Op": {
        "properties": {
            "id": {"type": "string"},
            "poll": {"anyOf": [{"type": "string"}, {"type": "null"}]},
            "note": {"type": "string"},
            "status": {"type": "string", "enum": ["pending", "done"]},
            "body": {"$ref": "#/components/schemas/Body"},
            "count": {"type": "integer"},
            "ratio": {"type": "number"},
        },
        "required": ["id", "poll", "status", "body", "count", "ratio"],
    },
    "Body": {"type": "object", "properties": {}},
}


def fields(required: list[str], enums: dict[str, list[str]]) -> dict[str, Any]:
    prefix = "/components/schemas/"
    return {
        "required": [{"pointer": f"{prefix}{pointer}"} for pointer in required],
        "enums": [
            {"pointer": f"{prefix}{pointer}", "values": values}
            for pointer, values in enums.items()
        ],
    }


def test_a_consistent_contract_groups_by_schema() -> None:
    required, enums = gen_wire.strict_fields(
        SCHEMAS,
        fields(
            [
                "Op/properties/id",
                "Op/properties/status",
                "Op/properties/body",
                "Op/properties/count",
            ],
            {"Op/properties/status": ["done"]},
        ),
    )
    assert required == {
        "Op": [
            ("id", "string"),
            ("status", "string"),
            ("body", "object"),
            ("count", "integer"),
        ]
    }
    assert enums == {("Op", "status"): ["done"]}


@pytest.mark.parametrize(
    ("required", "enums"),
    [
        (["Op/properties/missing"], {"Op/properties/status": ["done"]}),
        (["Other/properties/id"], {"Op/properties/status": ["done"]}),
        (["Op/properties/note"], {"Op/properties/status": ["done"]}),
        (["Op/properties/poll"], {"Op/properties/status": ["done"]}),
        (["Op/properties/ratio"], {"Op/properties/status": ["done"]}),
        (["Op/id"], {"Op/properties/status": ["done"]}),
        (["Op/properties/id"], {"Op/properties/status": ["failed"]}),
        (["Op/properties/id"], {}),
    ],
    ids=[
        "unknown-member",
        "unknown-schema",
        "not-required",
        "nullable",
        "untyped",
        "not-a-property",
        "value-not-served",
        "no-enums",
    ],
)
def test_an_inconsistent_contract_is_refused(
    required: list[str], enums: dict[str, list[str]]
) -> None:
    with pytest.raises(SystemExit):
        gen_wire.strict_fields(SCHEMAS, fields(required, enums))


def test_each_named_enum_is_a_literal_alias_of_the_served_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        gen_wire,
        "NAMED_ENUMS",
        {"OpStatus": (("Op", "properties", "status"), "Where an op stands.")},
    )
    source = gen_wire.named_enums(SCHEMAS, "class Op(TypedDict):\n    id: str\n")
    assert source.startswith('type OpStatus = Literal["pending", "done"]\n')


@pytest.mark.parametrize(
    ("path", "declared"),
    [
        (("Op", "properties", "note"), ""),
        (("Level", "properties", "rank"), ""),
        (("Op", "properties", "missing"), ""),
        (("Op", "properties", "status"), "\nclass OpStatus(TypedDict):\n"),
        (("Op", "properties", "status"), "\ntype OpStatus = str\n"),
    ],
    ids=["no-enum", "not-a-string", "unknown-member", "class-name", "alias-name"],
)
def test_a_named_enum_without_a_string_enum_or_with_a_taken_name_is_refused(
    monkeypatch: pytest.MonkeyPatch, path: tuple[str, ...], declared: str
) -> None:
    monkeypatch.setattr(gen_wire, "NAMED_ENUMS", {"OpStatus": (path, "Doc.")})
    schemas = {**SCHEMAS, "Level": {"properties": {"rank": {"enum": [1, 2]}}}}
    with pytest.raises(SystemExit):
        gen_wire.named_enums(schemas, declared)


def _column_rule(slots: object) -> dict[str, Any]:
    return {"format_version": 1, "rule": "column-order", "reading_columns": slots}


def test_the_reading_columns_render_as_a_tuple_of_slots() -> None:
    source = gen_wire.render_columns(_column_rule([["a"], ["b_label", "b"]]))
    assert "    ('a',),\n    ('b_label', 'b'),\n" in source


@pytest.mark.parametrize(
    "rule",
    [
        {**_column_rule([["a"]]), "format_version": 2},
        {**_column_rule([["a"]]), "rule": "key-format"},
        _column_rule([]),
        _column_rule([[]]),
        _column_rule([["a", 1]]),
        _column_rule([["a"], ["b", "a"]]),
        _column_rule([["a", "a"]]),
        _column_rule([["a"], ["stat_var"]]),
    ],
    ids=[
        "format",
        "rule",
        "no-slot",
        "empty-slot",
        "not-a-name",
        "repeated",
        "repeated-in-slot",
        "stat-var",
    ],
)
def test_a_column_order_rule_that_breaks_the_format_is_refused(
    rule: dict[str, Any],
) -> None:
    with pytest.raises(SystemExit):
        gen_wire.render_columns(rule)
