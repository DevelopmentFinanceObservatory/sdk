"""`scripts/gen_wire.py` refuses a strict-fields contract the served document breaks."""

import importlib.util
from types import ModuleType
from typing import Any

import pytest

from ._data import CONTRACT


def load_generator() -> ModuleType:
    path = CONTRACT.parent / "scripts" / "gen_wire.py"
    spec = importlib.util.spec_from_file_location("gen_wire", path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


gen_wire = load_generator()

SCHEMAS: dict[str, Any] = {
    "Op": {
        "properties": {
            "id": {"type": "string"},
            "poll": {"anyOf": [{"type": "string"}, {"type": "null"}]},
            "note": {"type": "string"},
            "status": {"type": "string", "enum": ["pending", "done"]},
        },
        "required": ["id", "poll", "status"],
    }
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
            ["Op/properties/id", "Op/properties/status"],
            {"Op/properties/status": ["done"]},
        ),
    )
    assert required == {"Op": ["id", "status"]}
    assert enums == {("Op", "status"): ["done"]}


@pytest.mark.parametrize(
    ("required", "enums"),
    [
        (["Op/properties/missing"], {"Op/properties/status": ["done"]}),
        (["Other/properties/id"], {"Op/properties/status": ["done"]}),
        (["Op/properties/note"], {"Op/properties/status": ["done"]}),
        (["Op/properties/poll"], {"Op/properties/status": ["done"]}),
        (["Op/id"], {"Op/properties/status": ["done"]}),
        (["Op/properties/id"], {"Op/properties/status": ["failed"]}),
        (["Op/properties/id"], {}),
    ],
    ids=[
        "unknown-member",
        "unknown-schema",
        "not-required",
        "nullable",
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
