"""Read the saved file TypeScript's `data.toBytes()` wrote, committed with its provenance.

TypeScript's `test/write-saved-fixtures.ts` writes both files, and its `test/saved.test.ts`
reads the file `tests/datasets/write_saved_fixtures.py` writes here.
"""

import itertools
import json
from pathlib import Path

from dfo._datasets.bundle import load

_TYPESCRIPT = Path(__file__).resolve().parents[3] / "typescript" / "test" / "data"


def test_a_file_typescript_wrote_loads_with_its_provenance() -> None:
    data = load(_TYPESCRIPT / "saved-typescript.parquet")
    stored = json.loads((_TYPESCRIPT / "saved-typescript.provenance.json").read_text())
    assert json.loads(data.provenance.to_json()) == stored
    assert len(data.members) > 1
    # The `part` column runs member by member, each run as long as its member's rows.
    parts = data.to_arrow().column("part").to_pylist()
    runs = [len(list(run)) for _, run in itertools.groupby(parts)]
    assert runs == list(data._member_rows)
    assert sum(runs) == len(data)
