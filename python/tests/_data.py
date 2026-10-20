"""Paths to the recorded dev bodies and the client contract."""

import json
from pathlib import Path
from typing import Any

DATA = Path(__file__).parent / "data"
CONTRACT = Path(__file__).resolve().parents[2] / "contract"


def load(name: str) -> Any:
    """A recorded dev body from `tests/data/`, decoded afresh for each call."""
    return json.loads((DATA / name).read_text())
