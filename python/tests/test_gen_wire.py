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
    return {"format_version": 1, "rule": "reading-order", "reading_columns": slots}


def test_the_reading_columns_render_as_a_tuple_of_slots() -> None:
    source = gen_wire.render_reading_order(_column_rule([["a"], ["b_label", "b"]]))
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
        _column_rule([["a"], ["part_label", "part"]]),
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
        "part",
    ],
)
def test_a_reading_order_rule_that_breaks_the_format_is_refused(
    rule: dict[str, Any],
) -> None:
    with pytest.raises(SystemExit):
        gen_wire.render_reading_order(rule)


def _role_rule(keys: object, flow_keys: object = ("origin",)) -> dict[str, Any]:
    return {
        "format_version": 1,
        "rule": "role-keys",
        "keys": keys,
        "flow_keys": list(flow_keys) if isinstance(flow_keys, tuple) else flow_keys,
    }


def test_the_role_keys_render_as_a_map_and_the_flow_keys() -> None:
    source = gen_wire.render_role_keys(
        _role_rule({"place": "observationAbout", "origin": "origin"})
    )
    assert "    'place': 'observationAbout',\n    'origin': 'origin',\n" in source
    assert "FLOW_KEYS: Final[tuple[str, ...]] = ('origin',)" in source


@pytest.mark.parametrize(
    "rule",
    [
        {**_role_rule({"origin": "origin"}), "format_version": 2},
        {**_role_rule({"origin": "origin"}), "rule": "reading-order"},
        _role_rule({}),
        _role_rule(["origin"]),
        _role_rule({"origin": "origin", "place": ""}),
        _role_rule({"origin": "origin", "place": 1}),
        _role_rule({"origin": "origin", "place": "origin"}),
        _role_rule(
            {"origin": "origin", "observationAbout": "x", "place": "observationAbout"}
        ),
        _role_rule({"origin": "origin"}, ()),
        _role_rule({"origin": "origin"}, "origin"),
        _role_rule({"origin": "origin"}, ("origin", "origin")),
        _role_rule({"origin": "origin"}, ("destination",)),
        _role_rule({"origin": "origin", "place": "observationAbout"}, ("place",)),
    ],
    ids=[
        "format",
        "rule",
        "no-key",
        "not-a-map",
        "empty-wire-role",
        "not-a-name",
        "two-keys-one-role",
        "wire-role-is-a-key",
        "no-flow-key",
        "flow-keys-not-a-list",
        "flow-key-repeated",
        "flow-key-unmapped",
        "flow-key-renamed",
    ],
)
def test_a_role_keys_rule_that_breaks_the_format_is_refused(
    rule: dict[str, Any],
) -> None:
    with pytest.raises(SystemExit):
        gen_wire.render_role_keys(rule)


def _selector_rule(keys: object) -> dict[str, Any]:
    return {"format_version": 1, "rule": "file-selector", "query_keys": keys}


def test_the_file_selector_keys_render_as_a_tuple() -> None:
    source = gen_wire.render_file_selector(_selector_rule(["format", "bundle"]))
    assert (
        "SELECTOR_QUERY_KEYS: Final[tuple[str, ...]] = ('format', 'bundle')" in source
    )


@pytest.mark.parametrize(
    "rule",
    [
        {**_selector_rule(["format"]), "format_version": 2},
        {**_selector_rule(["format"]), "rule": "role-keys"},
        _selector_rule([]),
        _selector_rule("format"),
        _selector_rule(["format", ""]),
        _selector_rule(["format", 1]),
        _selector_rule(["format", "format"]),
    ],
    ids=["format", "rule", "no-key", "not-a-list", "empty", "not-a-name", "repeated"],
)
def test_a_file_selector_rule_that_breaks_the_format_is_refused(
    rule: dict[str, Any],
) -> None:
    with pytest.raises(SystemExit):
        gen_wire.render_file_selector(rule)
