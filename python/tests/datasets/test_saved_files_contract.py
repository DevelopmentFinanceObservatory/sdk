"""Load every example in `contract/saved-files/` through `dfo.load`."""

import json
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from dfo._core.types import FormatError
from dfo._datasets.bundle import load as load_saved
from dfo._datasets.dataset import _party_totals_object
from tests._data import CONTRACT

_EXAMPLES = sorted((CONTRACT / "saved-files").glob("*.json"))


def _saved_file(example: dict[str, Any]) -> bytes:
    """The example's metadata as the key-value metadata of a Parquet file whose
    rows match its `member_rows`. The Arrow schema key is the writer's to set."""
    metadata = {
        key: value.encode()
        for key, value in example["metadata"].items()
        if key != "ARROW:schema"
    }
    rows = 0
    if "dfo.dataset" in example["metadata"]:
        try:
            rows = sum(json.loads(example["metadata"]["dfo.dataset"])["member_rows"])
        except (ValueError, KeyError, TypeError):
            rows = 0
    table = pa.table({"value": list(range(rows))})
    sink = pa.BufferOutputStream()
    pq.write_table(table.replace_schema_metadata(metadata), sink)
    return sink.getvalue().to_pybytes()


def test_the_examples_exist() -> None:
    assert _EXAMPLES


@pytest.mark.parametrize("path", _EXAMPLES, ids=lambda path: path.stem)
def test_a_saved_file_example_loads_or_is_refused_as_stated(path: Path) -> None:
    example = json.loads(path.read_text())
    content = _saved_file(example)
    if example.get("expect") == "accept":
        loaded = load_saved(content)
        assert loaded.sentence == example["metadata"]["dfo.sentence"]
        # A loader gives an accepted file's entries as its report, entry for
        # entry and in order.
        assert [
            _party_totals_object(entry) for entry in loaded.party_totals_left_out
        ] == json.loads(example["metadata"].get("dfo.party_totals_left_out", "[]"))
        # The retention the file states, with or without `dfo.retention`.
        stated = json.loads(example["metadata"]["dfo.dataset"])
        held = loaded.held_until.isoformat() if loaded.held_until else None
        assert (loaded.pinned, held) == (stated["pinned"], stated["held_until"])
        return
    with pytest.raises(FormatError) as caught:
        load_saved(content)
    if example["error"]["by"] == "rule":
        assert caught.value.reason == example["error"]["reason"]
