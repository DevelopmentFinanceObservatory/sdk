"""Load the contract's rule vectors, which the tests replay through the client."""

import json
from typing import Any

from ._data import CONTRACT


def vectors(rule: str) -> list[dict[str, Any]]:
    """Return the vectors of `contract/rules/<rule>.json`, refusing an empty file."""
    suite = json.loads(
        (CONTRACT / "rules" / f"{rule}.json").read_text(encoding="utf-8")
    )
    assert suite["rule"] == rule
    assert suite["vectors"], f"{rule} has no vectors"
    return suite["vectors"]


def ids(rule: str) -> list[str]:
    """Return the vector names, as pytest ids."""
    return [vector["name"] for vector in vectors(rule)]
