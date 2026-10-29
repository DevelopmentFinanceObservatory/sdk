"""Tests for DFO's operations: running a recipe, reading derived frames, and pins.

The replies are recorded from dfo-apis' analysis runner over its test doubles
(`tests/datasets_api/_analysis_doubles.py` and `test_derived.py`): a chain of
`quotient_of` then `growth` that drops three series over two inputs, and a
rolling `rank` that settles on 2022. `scripts/gen_sync.py` derives
`tests/_sync/datasets/test_analysis.py` from this file, so the sync client
passes the same tests.
"""

import json
import warnings
from pathlib import Path
from typing import Any

import httpx2
import pytest

from dfo._core import errors as _errors
from dfo._core.errors import (
    ContractError,
    DfoTimeoutError,
    DfoWarning,
    InvalidRequestError,
    NotFoundError,
    QuotaExceededError,
    SeriesLeftOutWarning,
    ServerError,
    VersionUnavailableError,
)
from dfo._core.periods import latest_year
from dfo._core.refs import DatasetRef, DerivedMember, DerivedRefMember
from dfo._core.types import Spec
from dfo._datasets.analysis import AsyncAnalysis
from dfo._datasets.cache import Cache
from dfo._datasets.dataset import build_dataset, derived_dataset
from dfo._datasets.pin import pin
from dfo._datasets.recipe import recipe
from dfo._datasets.resolve import fetch
from dfo._http.transport import AsyncTransport
from tests._data import DATA, load
from tests._datasets import recorded_member
from tests._fetch_support import BASE, Server, json_response, problem
from tests.rule_vectors import vectors

pytestmark = pytest.mark.anyio

AID = Spec("spec_" + "a" * 32, {})
FILE_QUERY = "format=parquet&bundle=false&layout=frame"


class Timeline:
    """A clock and a sleep that advances it at once, recording each wait."""

    def __init__(self) -> None:
        self.now = 1000.0
        self.sleeps: list[float] = []

    def clock(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


@pytest.fixture(autouse=True)
def fresh(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_errors, "_warned", set())
    monkeypatch.delenv("DFO_OFFLINE", raising=False)


def make(handler, timeline: Timeline | None = None) -> AsyncTransport:
    timeline = timeline or Timeline()
    return AsyncTransport(
        api_key=False,
        base_url=BASE,
        http_transport=httpx2.MockTransport(handler),
        sleep=timeline.sleep,
        clock=timeline.clock,
    )


def ready(name: str = "chain") -> httpx2.Response:
    return json_response(200, load(f"analysis-{name}-ready.json"))


def manifest(name: str = "chain") -> httpx2.Response:
    return json_response(200, load(f"analysis-{name}-manifest.json"))


def frame(name: str = "chain") -> httpx2.Response:
    return httpx2.Response(
        200,
        headers={"content-type": "application/vnd.apache.parquet"},
        content=(DATA / f"analysis-{name}-frame.parquet").read_bytes(),
    )


def pending() -> httpx2.Response:
    recorded = load("analysis-pending.json")
    return json_response(
        recorded["status"],
        recorded["body"],
        {"retry-after": recorded["headers"]["retry-after"]},
    )


def recorded_problem(name: str) -> httpx2.Response:
    recorded = load(f"analysis-{name}.json")
    return json_response(recorded["status"], recorded["body"])


def member(name: str = "chain") -> DerivedRefMember:
    (found,) = DatasetRef.from_json(
        json.dumps(load(f"analysis-{name}-ready.json")["ref"])
    ).members
    assert isinstance(found, DerivedRefMember)
    return found


def frame_paths(name: str = "chain") -> list[str]:
    found = member(name)
    path = f"{BASE}/datasets/derived/{found.spec.spec_id}/{found.content_version}"
    return [f"GET {path}", f"GET {path}/file"]


CHAIN = (
    recipe(AID)
    .quotient_of(Spec("spec_" + "b" * 32, {}), on={"destination": "place"})
    .growth(by="destination", window=(latest_year(-1), latest_year()))
)


async def test_a_recipe_runs_in_one_request_and_reads_its_frame() -> None:
    server = Server(ready(), manifest(), frame())
    async with make(server) as transport:
        with pytest.warns(SeriesLeftOutWarning) as caught:
            data = await fetch(transport, CHAIN)

    assert server.calls() == [f"POST {BASE}/datasets/analysis", *frame_paths()]
    assert server.body(0) == {"tree": CHAIN.tree(), "latest": False}
    assert server.requests[2].url.query.decode() == FILE_QUERY
    assert data.ref == DatasetRef((member(),))
    (built,) = data.members
    assert isinstance(built, DerivedMember)
    assert built.output_digest == member().output_digest
    assert [series.reason for series in data.left_out] == [
        row["reason"] for row in load("analysis-chain-manifest.json")["left_out"]
    ]
    assert len(caught) == 1
    assert "3 series left out" in str(caught[0].message)
    assert isinstance(caught[0].message, SeriesLeftOutWarning)
    assert caught[0].message.code == "series_left_out"
    assert len(data) == 1


async def test_a_recipes_dataset_names_columns_by_the_roles_the_call_used() -> None:
    server = Server(ready(), manifest(), frame())
    async with make(server) as transport:
        with pytest.warns(SeriesLeftOutWarning):
            data = await fetch(transport, CHAIN)

    assert "  Derived: quotient_of by destination, then growth by destination, " in (
        repr(data)
    )
    assert [repr(series) for series in data.left_out] == [
        "LeftOutSeries(destination=country/NGA: growth dropped 1 row from data, "
        "endpoint_missing)",
        "LeftOutSeries(destination=country/GHA: quotient_of dropped 2 rows from "
        "data, unmatched_key)",
        "LeftOutSeries(destination=country/NGA: quotient_of dropped 1 row from "
        "data, period_unmatched)",
    ]
    # The coordinates keep DFO's columns, which the frame's columns match.
    assert data.left_out[0].coordinates["financingRecipient"] == "country/NGA"


async def test_an_operation_takes_strict_and_timeout_as_fetch_does() -> None:
    server = Server(ready(), manifest(), frame())
    async with make(server) as transport:
        operations = AsyncAnalysis(transport)
        with pytest.raises(SeriesLeftOutWarning):
            await operations.growth(
                CHAIN, by="destination", window=(2021, 2022), strict=True
            )
    timeline = Timeline()
    async with make(Server(pending()), timeline) as transport:
        with pytest.raises(DfoTimeoutError) as caught:
            await AsyncAnalysis(transport).rank(AID, by="destination", timeout=1.5)
    assert caught.value.code == "deadline_exceeded"


async def test_strict_raises_the_left_out_warning() -> None:
    server = Server(ready(), manifest(), frame())
    async with make(server) as transport:
        with pytest.raises(SeriesLeftOutWarning):
            await fetch(transport, CHAIN, strict=True)


# A fetch reads one derived member, so the vectors that fetch several are not
# replayable through this client.
LEFT_OUT_VECTORS = [
    vector for vector in vectors("series-left-out") if len(vector["members"]) == 1
]


@pytest.mark.parametrize(
    "vector", LEFT_OUT_VECTORS, ids=[vector["name"] for vector in LEFT_OUT_VECTORS]
)
async def test_the_series_left_out_vectors(vector: dict[str, Any]) -> None:
    (served,) = vector["members"]
    left_out = json_response(200, {**load("analysis-chain-manifest.json"), **served})
    server = Server(left_out, frame())
    async with make(server) as transport:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            if "raises" in vector:
                with pytest.raises(SeriesLeftOutWarning) as raised:
                    await fetch(
                        transport, DatasetRef((member(),)), strict=vector["strict"]
                    )
                assert raised.value.code == vector["raises"]
            else:
                await fetch(transport, DatasetRef((member(),)), strict=vector["strict"])
    issued = [w.message.code for w in caught if isinstance(w.message, DfoWarning)]
    assert issued == vector.get("warnings", [])


async def test_a_recipe_that_leaves_nothing_out_warns_nothing() -> None:
    server = Server(ready("rank"), manifest("rank"), frame("rank"))
    async with make(server) as transport:
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            data = await fetch(
                transport, recipe(AID).rank(by="destination", limit=2), latest=True
            )
    assert server.body(0)["latest"] is True
    assert data.left_out == ()
    (built,) = data.members
    assert isinstance(built, DerivedMember)
    assert [period.period for period in built.resolved_periods] == ["2022"]


async def test_a_pending_run_posts_again_after_its_retry_after() -> None:
    timeline = Timeline()
    server = Server(pending(), ready("rank"), manifest("rank"), frame("rank"))
    async with make(server, timeline) as transport:
        await fetch(transport, recipe(AID).rank(by="destination"))
    assert server.calls()[:2] == [f"POST {BASE}/datasets/analysis"] * 2
    assert server.body(0) == server.body(1)
    assert timeline.sleeps == [2.0]


async def test_a_run_pending_past_its_timeout_raises_deadline_exceeded() -> None:
    timeline = Timeline()
    server = Server(pending())
    async with make(server, timeline) as transport:
        with pytest.raises(DfoTimeoutError) as caught:
            await fetch(transport, recipe(AID).rank(by="destination"), timeout=1.5)
    assert caught.value.code == "deadline_exceeded"
    assert caught.value.retryable is True
    assert timeline.sleeps == []


@pytest.mark.parametrize(
    ("name", "error_class", "code"),
    [
        ("refused-role-ambiguous", InvalidRequestError, "role_ambiguous"),
        ("refused-snapshot-not-found", NotFoundError, "snapshot_not_found"),
    ],
)
async def test_a_refused_run_raises_its_class_with_the_fix(
    name: str, error_class: type[Exception], code: str
) -> None:
    server = Server(recorded_problem(name))
    async with make(server) as transport:
        with pytest.raises(error_class) as caught:
            await fetch(transport, recipe(AID).rank(by="destination"))
    error: Any = caught.value
    assert error.code == code
    assert error.problem["fix"] == load(f"analysis-{name}.json")["body"]["fix"]
    assert len(server.requests) == 1


@pytest.mark.parametrize(
    "answer",
    [
        {"status": "ready"},
        {"status": "ready", "ref": {"format_version": 1, "members": []}},
        {
            "status": "ready",
            "ref": {**load("analysis-chain-ready.json")["ref"], "format_version": 1},
        },
    ],
    ids=["no-ref", "no-members", "dataset-members"],
)
async def test_a_ready_answer_without_one_derived_member_raises_contract_error(
    answer: dict[str, Any],
) -> None:
    server = Server(json_response(200, answer))
    async with make(server) as transport:
        with pytest.raises(ContractError) as caught:
            await fetch(transport, CHAIN)
    assert caught.value.code == "contract_violation"


@pytest.mark.parametrize(
    "options",
    [
        {"window": (2020, 2024)},
        {"entities": {"origin": ["country/DEU"]}},
        {"facets": {"unit": "USD"}},
        {"layout": "long"},
        {"party_totals": True},
        {"progress": False},
    ],
    ids=["window", "entities", "facets", "layout", "party-totals", "progress"],
)
async def test_a_recipe_refuses_the_options_of_a_spec_unsent(
    options: dict[str, Any],
) -> None:
    server = Server()
    async with make(server) as transport:
        with pytest.raises(InvalidRequestError) as caught:
            await fetch(transport, CHAIN, **options)
    assert caught.value.code == "invalid_argument"
    assert server.requests == []


async def test_a_derived_ref_reads_the_frame_it_names() -> None:
    server = Server(manifest(), frame())
    async with make(server) as transport:
        with pytest.warns(SeriesLeftOutWarning):
            data = await fetch(transport, DatasetRef((member(),)))
    assert server.calls() == frame_paths()
    assert data.ref == DatasetRef((member(),))


async def test_a_derived_file_that_misses_the_refs_digest_raises() -> None:
    tampered = (DATA / "analysis-chain-frame.parquet").read_bytes() + b"\0"
    server = Server(
        manifest(),
        httpx2.Response(200, content=tampered),
        httpx2.Response(200, content=tampered),
    )
    async with make(server) as transport:
        with pytest.raises(ServerError) as caught:
            await fetch(transport, DatasetRef((member(),)))
    assert caught.value.code == "digest_mismatch"
    assert server.calls() == [*frame_paths(), frame_paths()[1]]


async def test_a_second_read_of_a_derived_frame_takes_its_file_from_the_cache(
    tmp_path: Path,
) -> None:
    cache = Cache(tmp_path, env={})
    server = Server(manifest(), frame(), manifest())
    ref = DatasetRef((member(),))
    async with make(server) as transport:
        with pytest.warns(SeriesLeftOutWarning):
            first = await fetch(transport, ref, cache=cache)
        with pytest.warns(SeriesLeftOutWarning):
            again = await fetch(transport, ref, cache=cache)
    assert server.calls() == [*frame_paths(), frame_paths()[0]]
    assert again.to_arrow().equals(first.to_arrow())


async def test_a_derived_ref_with_latest_posts_its_bare_root() -> None:
    server = Server(ready("rank"), manifest("rank"), frame("rank"))
    found = member("rank")
    async with make(server) as transport:
        await fetch(transport, DatasetRef((found,)), latest=True)
    assert server.body(0) == {
        "tree": {
            "spec_id": found.spec.spec_id,
            "content_version": found.content_version,
        },
        "latest": True,
    }


async def test_an_expired_derived_frame_is_computed_again_on_its_roots() -> None:
    server = Server(
        problem(410, "artifact_expired"), ready("rank"), manifest("rank"), frame("rank")
    )
    found = member("rank")
    async with make(server) as transport:
        data = await fetch(transport, DatasetRef((found,)))
    assert server.body(1) == {
        "tree": {
            "spec_id": found.spec.spec_id,
            "content_version": found.content_version,
        },
        "latest": False,
    }
    assert data.ref == DatasetRef((found,))


@pytest.mark.parametrize(
    "again",
    [problem(404, "recipe_not_found"), ready("chain")],
    ids=["refused", "another-version"],
)
async def test_an_expired_frame_dfo_cannot_compute_again_is_unavailable(
    again: httpx2.Response,
) -> None:
    server = Server(problem(410, "artifact_expired"), again)
    async with make(server) as transport:
        with pytest.raises(VersionUnavailableError) as caught:
            await fetch(transport, DatasetRef((member("rank"),)))
    assert "fetch(ref, latest=True)" in str(caught.value)
    assert caught.value.newest_version is None
    assert len(server.requests) == 2


async def test_a_transient_refusal_of_a_recomputation_raises_as_it_came() -> None:
    busy = [problem(503, "service_unavailable", retryable=True) for _ in range(3)]
    server = Server(problem(410, "artifact_expired"), *busy)
    async with make(server) as transport:
        with pytest.raises(ServerError) as caught:
            await fetch(transport, DatasetRef((member("rank"),)))
    assert not isinstance(caught.value, VersionUnavailableError)
    assert caught.value.code == "service_unavailable"
    assert caught.value.retryable


async def test_a_recomputed_frame_with_another_digest_reads_it_and_warns() -> None:
    answer = load("analysis-rank-ready.json")
    stale = answer["ref"]["members"][0]["artifact"] | {"digest": "sha256:" + "0" * 64}
    answer["ref"]["members"][0]["artifact"] = stale
    (old,) = DatasetRef.from_json(json.dumps(answer["ref"])).members
    server = Server(
        problem(410, "artifact_expired"), ready("rank"), manifest("rank"), frame("rank")
    )
    async with make(server) as transport:
        with pytest.warns(DfoWarning) as caught:
            data = await fetch(transport, DatasetRef((old,)))
    (record,) = caught
    warning = record.message
    assert type(warning) is DfoWarning
    assert warning.code == "ref_digest_changed"
    assert data.ref == DatasetRef((member("rank"),))


async def test_a_ref_of_two_derived_members_is_refused_unsent() -> None:
    other = member("rank")
    server = Server()
    async with make(server) as transport:
        with pytest.raises(InvalidRequestError):
            await fetch(transport, DatasetRef((member(), other)))
    assert server.requests == []


def pinned_answer(request: httpx2.Request) -> httpx2.Response:
    *_, spec_id, content_version, _ = request.url.path.split("/")
    body = json.loads(request.content)
    return json_response(
        200,
        {
            "schema_version": 1,
            "pinned": {
                "id": spec_id,
                "content_version": content_version,
                "artifact_digest": body["artifact_digest"],
                "pinned_at": "2026-10-28T12:00:00+00:00",
            },
        },
    )


async def test_pin_pins_each_member_and_returns_the_dataset_pinned() -> None:
    data = build_dataset(
        [recorded_member()], layout="long", complete=True, missing=(), stale=False
    )
    requests: list[httpx2.Request] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        requests.append(request)
        return pinned_answer(request)

    async with make(handler) as transport:
        kept = await pin(transport, data)
    (only,) = data.members
    assert [(r.method, r.url.path) for r in requests] == [
        (
            "POST",
            f"/api/v1/datasets/{only.spec.spec_id}/{only.content_version}/pin",
        )
    ]
    assert json.loads(requests[0].content) == {
        "schema_version": 1,
        "artifact_digest": only.digest,
    }
    assert (kept.pinned, kept.held_until, kept.ref) == (True, None, data.ref)
    assert "pinned" in repr(kept)


async def test_pin_refuses_a_derived_dataset_unsent() -> None:
    data = derived_dataset(
        member("rank"),
        load("analysis-rank-manifest.json"),
        (DATA / "analysis-rank-frame.parquet").read_bytes(),
    )
    server = Server()
    async with make(server) as transport:
        with pytest.raises(InvalidRequestError) as caught:
            await pin(transport, data)
    assert caught.value.code == "invalid_argument"
    assert "frame DFO computed" in str(caught.value)
    assert server.requests == []


@pytest.mark.parametrize(
    ("answer", "error_class"),
    [
        (json_response(200, {"schema_version": 1, "pinned": {}}), ContractError),
        (problem(429, "allowance_exhausted"), QuotaExceededError),
    ],
    ids=["another-version", "allowance-spent"],
)
async def test_a_pin_dfo_does_not_confirm_raises(
    answer: httpx2.Response, error_class: type[Exception]
) -> None:
    data = build_dataset(
        [recorded_member()], layout="long", complete=True, missing=(), stale=False
    )
    async with make(Server(answer)) as transport:
        with pytest.raises(error_class):
            await pin(transport, data)
