"""The live journey: ten steps against the DFO API at `DFO_BASE_URL`.

Marked `live` and deselected by default; run it with `pytest -m live`. Each step
asserts on what the wire carries: codes, ids, digests, row counts and years. A
step the server cannot serve yet, an async build or a place choice, skips with
what the server served instead.

`DFO_E2E_DIR` names a directory shared with the TypeScript journey: step 10
writes the ref it fetched there as `ref-python.json` and reads back
`ref-typescript.json` when it exists.

Step 6 builds the spec `tests/live/long-builds.json` assigns to this run by the UTC
day's parity, the language and `DFO_E2E_TARGET`. Each spec there is posted every
48 hours, so its stored head is past the server's 24-hour maximum age and the
build runs again as an operation. The step posts it twice, then fetches it in a
fresh process, and checks all three join one operation. `DFO_E2E_SCHEDULED=true` marks a scheduled
run, where a build served inline fails the step; any other run skips it.
"""

import json
import os
import re
import subprocess
import sys
import time
from collections import Counter
from collections.abc import Iterator, Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from dfo import Answer, Client, Dataset, DatasetRef, Spec
from dfo._datasets.build import build_body, rendering_for, resubmit_body
from dfo.errors import IncompleteAnswerError, InvalidRequestError, NotFoundError
from dfo.types import Member

pytestmark = pytest.mark.live

DEFINITE = "ODA disbursements from Germany to Nigeria for basic health care"
# The step needs a question Search reads several ways.
CANDIDATES = "government education spending Kenya"
MIXED = "debt service of Kenya and the price of tea in Kenya"
SEVERAL = (
    "ODA disbursements for health and for education from Germany to Kenya, "
    "and GDP of Kenya"
)
PLACE = "ODA disbursements from Germany to Congo"
LONG_BUILDS = Path(__file__).parents[3] / "tests" / "live" / "long-builds.json"
LANGUAGE = "python"
LONG_COLUMNS = {"stat_var", "time_period", "value", "unit"}
WINDOW = (2020, 2023)
UNKNOWN_VERSION = "cv_" + "0" * 32
JOIN = Path(__file__).with_name("join_build.py")

SPEC_ID = re.compile(r"spec_[0-9a-f]{32}")
CONTENT_VERSION = re.compile(r"cv_[0-9a-f]{32}")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
OPERATION_ID = re.compile(r"op_[0-9a-f]{64}")


@pytest.fixture(scope="module")
def base_url() -> str:
    url = os.environ.get("DFO_BASE_URL")
    if not url:
        pytest.fail("DFO_BASE_URL is unset; the live journey needs a deployed API")
    return url


@pytest.fixture(scope="module")
def client(base_url: str) -> Iterator[Client]:
    with Client(base_url=base_url, cache=False) as client:
        yield client


@pytest.fixture(scope="module")
def definite(client: Client) -> Answer:
    return client.search(DEFINITE)


@pytest.fixture(scope="module")
def dataset(definite: Answer) -> Dataset:
    return definite.fetch(progress=False)


@pytest.fixture(autouse=True)
def online(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DFO_OFFLINE", raising=False)
    monkeypatch.setenv("DFO_PROGRESS", "0")


def _snapshot(client: Client, member: Member) -> dict[str, Any]:
    """The stored version's manifest, read from the snapshot route."""
    path = f"/datasets/{member.spec.spec_id}/{member.content_version}"
    return client.request("GET", path).json()


def _artifact(manifest: Mapping[str, Any], digest: str) -> Mapping[str, Any]:
    found = [a for a in manifest["artifacts"] if a["artifact_digest"] == digest]
    assert len(found) == 1, f"the manifest lists {digest} {len(found)} times"
    return found[0]


def _wire_parts(answer: Answer) -> list[Mapping[str, Any]]:
    return answer.raw["parts"]


def _versions(members: Any) -> list[tuple[str, str, str]]:
    return [(m.spec.spec_id, m.content_version, m.digest) for m in members]


def test_01_search_answers_definite(definite: Answer) -> None:
    (part,) = _wire_parts(definite)
    assert (definite.raw["kind"], definite.raw["status"]) == ("resolution", "definite")
    assert (definite.kind, definite.status) == ("resolution", "definite")
    assert definite.sentence == definite.raw["rendered_sentence"]
    assert SPEC_ID.fullmatch(part["spec"]["spec_id"])
    assert [spec.spec_id for spec in definite.specs] == [part["spec"]["spec_id"]]


def test_02_fetch_reads_back_by_ref_and_offline(
    client: Client,
    definite: Answer,
    dataset: Dataset,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    (member,) = dataset.members
    manifest = _snapshot(client, member)
    artifact = _artifact(manifest, member.digest)
    assert member.spec.spec_id == manifest["definition"]["spec_id"]
    assert member.spec.spec_id == definite.specs[0].spec_id
    assert member.content_version == manifest["content_version"]
    assert CONTENT_VERSION.fullmatch(member.content_version)
    assert DIGEST.fullmatch(member.digest)
    assert 0 < len(dataset) == manifest["coverage"]["rows"]
    assert set(dataset.to_arrow().column_names) >= LONG_COLUMNS
    assert dataset.layout_version == str(artifact["rendering"]["layout"])
    assert member.parts == (definite.parts[0].variable_text,)

    assert dataset.ref is not None
    ref = DatasetRef.from_json(dataset.ref.to_json())
    assert ref == dataset.ref
    assert [m.sentence for m in ref.members] == [member.sentence]
    assert member.sentence

    # With the cache off, the ref is read again from the server, its bytes
    # checked against the digest it names.
    again = client.fetch(ref, progress=False)
    assert _versions(again.members) == _versions(dataset.members)
    assert (len(again), again.stale) == (len(dataset), False)

    with Client(base_url=client.base_url, cache_dir=tmp_path) as cached:
        cached.fetch(ref, progress=False)
    monkeypatch.setenv("DFO_OFFLINE", "1")
    with Client(base_url=client.base_url, cache_dir=tmp_path) as offline:
        stored = offline.fetch(ref, progress=False)
    assert _versions(stored.members) == _versions(dataset.members)
    assert (len(stored), stored.stale) == (len(dataset), True)


def test_03_candidates_raise_and_a_choice_fetches(client: Client) -> None:
    answer = client.search(CANDIDATES)
    (part,) = _wire_parts(answer)
    assert part["status"] == "candidates"
    specs = part["candidates"]["specs"]
    assert len(specs) >= 2

    with pytest.raises(IncompleteAnswerError) as caught:
        answer.fetch(progress=False)
    assert caught.value.code == "answer_incomplete"
    numbered = re.findall(r"^ +\[(\d+)\] ", str(caught.value), re.MULTILINE)
    assert numbered == [str(i) for i in range(len(specs))]

    data = answer.choose(0).fetch(progress=False)
    assert len(data) > 0
    assert [m.spec.spec_id for m in data.members] == [specs[0]["spec_id"]]


def test_04_a_mixed_answer_raises_then_fetches_partial(client: Client) -> None:
    answer = client.search(MIXED)
    statuses = [part["status"] for part in _wire_parts(answer)]
    assert len(statuses) == 2
    assert statuses.count("definite") == 1
    answered = statuses.index("definite")

    with pytest.raises(IncompleteAnswerError) as caught:
        answer.fetch(progress=False)
    assert caught.value.code == "answer_incomplete"

    data = answer.fetch(partial=True, progress=False)
    (member,) = data.members
    spec_id = _wire_parts(answer)[answered]["spec"]["spec_id"]
    assert member.spec.spec_id == spec_id
    assert data.complete is False
    assert [gap.part_index for gap in data.missing] == [1 - answered]
    assert len(data) > 0


def test_05_several_readings_stack_into_one_dataset(client: Client) -> None:
    answer = client.search(SEVERAL)
    parts = _wire_parts(answer)
    assert {part["status"] for part in parts} == {"definite"}
    distinct = list(dict.fromkeys(part["spec"]["spec_id"] for part in parts))
    assert len(distinct) >= 2

    data = answer.fetch(progress=False)
    table = data.to_arrow()
    assert table.column_names[0] == "part"
    assert [m.spec.spec_id for m in data.members] == distinct
    labels = ["; ".join(m.parts) for m in data.members]
    counts = Counter(table.column("part").to_pylist())
    assert list(counts) == labels
    assert all(counts.values())
    assert sum(counts.values()) == len(data)


def _long_build() -> Spec:
    """The spec `LONG_BUILDS` assigns to this run's UTC day, language and target."""
    target = os.environ.get("DFO_E2E_TARGET")
    if not target:
        pytest.fail("DFO_E2E_TARGET is unset; step 6 picks its spec by target")
    parity = int(time.time() // 86_400) % 2
    entries = json.loads(LONG_BUILDS.read_text())
    (entry,) = [
        e
        for e in entries
        if (e["day_parity"], e["language"], e["target"]) == (parity, LANGUAGE, target)
    ]
    return Spec(entry["spec"]["spec_id"], entry["spec"]["definition"])


def _download_rows(client: Client, spec: Spec) -> int:
    """The rows Search says a build of `spec` downloads, from its identity."""
    body = resubmit_body(spec.definition, "dataset")
    (part,) = client.request("POST", "/search/resolve", json=body).json()["parts"]
    assert part["status"] == "definite", part["status"]
    assert part["spec"]["spec_id"] == spec.spec_id
    return part["spec"]["resolved"]["download"]["rows"]


def _served_inline(client: Client, spec: Spec, manifest: Mapping[str, Any]) -> str:
    """Why the build answered 200, with the age of the version it served.

    The server publishes no head age, so this is the age of the served version's
    `prepared_at`, at least the head's age.
    """
    version = manifest["content_version"]
    stored = client.request("GET", f"/datasets/{spec.spec_id}/{version}").json()
    prepared = datetime.fromisoformat(stored["prepared_at"])
    hours = (datetime.now(UTC) - prepared).total_seconds() / 3600
    return (
        f"POST /datasets served {spec.spec_id} inline (200) at {version}, "
        f"prepared {hours:.1f} h ago; a 48-hour rotation should find its head "
        "past the server's maximum age"
    )


def _post_build(client: Client, spec: Spec) -> tuple[int, dict[str, Any]]:
    """The status and body `POST /datasets` answers for `spec`'s long build, in
    the rendering a default fetch posts, so the fetch joins it."""
    body = build_body(spec, rendering_for("long", party_totals=False))
    # A build answers within 150 s; the client's default attempt is 30 s.
    response = client.with_options(timeout=160.0).request(
        "POST", "/datasets", json=body
    )
    return response.status_code, response.json()


def test_06_a_long_build_runs_as_an_operation_that_a_repeated_fetch_joins(
    client: Client, base_url: str
) -> None:
    spec = _long_build()
    caps = client.request("GET", "/datasets/capabilities").json()["caps"]
    budget_rows, budget_requests = (
        caps["sync_budget_rows"],
        caps["sync_budget_requests"],
    )
    assert isinstance(budget_requests, int)
    # The server publishes a build's row count before it runs, through Search;
    # it publishes no request count, so only the rows budget is checked here.
    assert _download_rows(client, spec) > budget_rows

    status, first = _post_build(client, spec)
    if status == 200:
        reason = _served_inline(client, spec, first)
        if os.environ.get("DFO_E2E_SCHEDULED") == "true":
            pytest.fail(reason)
        pytest.skip(reason)
    assert status == 202
    operation_id = first["operation"]["operation_id"]
    assert OPERATION_ID.fullmatch(operation_id)
    assert first["operation"]["status"] in {"pending", "running"}
    # An identical build joins the running one.
    again_status, again = _post_build(client, spec)
    assert again_status in {200, 202}
    if again_status == 202:
        assert again["operation"]["operation_id"] == operation_id

    joined = subprocess.run(
        [sys.executable, str(JOIN), base_url],
        input=json.dumps({"spec_id": spec.spec_id, "definition": spec.definition}),
        capture_output=True,
        text=True,
        timeout=3600,
        check=True,
    )
    read = json.loads(joined.stdout.splitlines()[-1])
    polls, waits = read["polls"], read["waits"]
    # The fetch's build joins the operation, whether it posts while the build
    # runs (202) or after it is done (200, with no poll).
    assert read["posted"] in {None, operation_id}
    assert {poll["operation_id"] for poll in polls} <= {operation_id}
    assert [poll["http_status"] for poll in polls] == [200] * len(polls)
    if polls:
        assert polls[-1]["status"] == "done"
        assert {poll["status"] for poll in polls[:-1]} <= {"pending", "running"}
    # Each wait after the first follows the poll before it, at its pacing.
    for poll, wait in zip(polls, waits[1:], strict=False):
        if poll["retry_after_ms"] is not None:
            assert wait == poll["retry_after_ms"] / 1000, poll
        elif poll["retry_after"] is not None:
            assert wait == float(poll["retry_after"]), poll
        if poll["estimate_rows"] is not None:
            assert poll["estimate_rows"] > budget_rows, poll
    assert read["spec_id"] == spec.spec_id
    assert CONTENT_VERSION.fullmatch(read["content_version"])
    assert DIGEST.fullmatch(read["digest"])
    assert read["rows"] > budget_rows


def test_07_a_place_choice_answers_definite(client: Client) -> None:
    answer = client.search(PLACE)
    (gap,) = answer.gaps
    assert gap.kind == "choice"
    no_data = _wire_parts(answer)[gap.part_index]["no_data"]
    if not gap.options:
        pytest.skip(
            f"Search offers no option for the place choice: no_data reason "
            f"{no_data['reason']!r}, {len(no_data.get('ambiguous_entities', []))} "
            f"ambiguous entities, and no options member"
        )
    chosen = answer.choose("Congo [DRC]", part="Congo")
    assert chosen.status == "definite"
    (part,) = _wire_parts(chosen)
    entities = part["spec"]["definition"]["identity"]["entities"]
    assert "country/COD" in [ref for refs in entities.values() for ref in refs]


def test_08_a_window_narrows_to_a_new_spec(client: Client, definite: Answer) -> None:
    spec = definite.specs[0]
    data = client.fetch(spec, window=WINDOW, progress=False)
    (member,) = data.members
    assert SPEC_ID.fullmatch(member.spec.spec_id)
    assert member.spec.spec_id != spec.spec_id
    assert len(data) == _snapshot(client, member)["coverage"]["rows"] > 0
    years = {
        int(str(value)[:4]) for value in data.to_arrow()["time_period"].to_pylist()
    }
    assert years
    assert years <= set(range(WINDOW[0], WINDOW[1] + 1))
    assert f"{WINDOW[0]} to {WINDOW[1]}" in member.sentence


def test_09_refusals_carry_their_codes(
    client: Client, definite: Answer, dataset: Dataset
) -> None:
    assert dataset.ref is not None
    obj = json.loads(dataset.ref.to_json())
    obj["members"][0]["content_version"] = UNKNOWN_VERSION
    with pytest.raises(NotFoundError) as unknown:
        client.fetch(DatasetRef.from_json(json.dumps(obj)), progress=False)
    assert unknown.value.code == "snapshot_not_found"

    with pytest.raises(InvalidRequestError) as malformed:
        client.fetch(definite.specs[0], facets={"colour": "red"}, progress=False)
    assert malformed.value.code == "request_invalid"


def test_10_a_ref_crosses_languages(client: Client, dataset: Dataset) -> None:
    directory = os.environ.get("DFO_E2E_DIR")
    if not directory:
        pytest.skip("DFO_E2E_DIR is unset, so no ref is shared with TypeScript")
    shared = Path(directory)
    shared.mkdir(parents=True, exist_ok=True)
    assert dataset.ref is not None
    (shared / "ref-python.json").write_text(dataset.ref.to_json())

    other = shared / "ref-typescript.json"
    if not other.exists():
        pytest.skip(f"wrote ref-python.json; {other} does not exist yet")
    ref = DatasetRef.from_json(other.read_text())
    data = client.fetch(ref, progress=False)
    assert [(m.content_version, m.digest) for m in data.members] == [
        (m.content_version, m.digest) for m in ref.members
    ]
