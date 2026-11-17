"""Write the saved file the cross-language tests read: a dataset of two members.

Run from `python/` with `uv run python -m tests.datasets.write_saved_fixtures`. It replays the
contract scenario `answer-several-readings-folded`, whose answer builds two members that stack
into one table, saves the dataset to `tests/data/saved-python.parquet`, and writes its
provenance record beside it as `saved-python.provenance.json`. TypeScript's
`test/saved.test.ts` reads both. The fetch time is the time of the run, so each run writes new
bytes.
"""

import json
import warnings

import httpx2

from dfo._sync._client.client import Client
from dfo._sync._datasets.fetch import Session
from dfo._sync._http.transport import Transport
from tests._data import DATA
from tests._fetch_support import BASE, Replay

SCENARIO = "answer-several-readings-folded"
PARQUET = DATA / "saved-python.parquet"
PROVENANCE = DATA / "saved-python.provenance.json"


def main() -> None:
    replay = Replay(SCENARIO)
    transport = Transport(
        base_url=BASE, api_key=False, http_transport=httpx2.MockTransport(replay)
    )
    with Client._over(Session(transport, None)) as client:
        answer = client.search(replay.record["call"][0]["question"])
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            data = answer.fetch()
    assert len(data.members) > 1, "the scenario no longer stacks several members"
    data.save(PARQUET)
    PROVENANCE.write_text(
        json.dumps(data.provenance.to_object(), indent=2, ensure_ascii=False) + "\n"
    )
    print(f"wrote {PARQUET} and {PROVENANCE}")


if __name__ == "__main__":
    main()
