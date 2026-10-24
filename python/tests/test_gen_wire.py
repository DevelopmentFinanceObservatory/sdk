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
