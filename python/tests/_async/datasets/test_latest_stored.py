"""Tests for `fetch(ref, latest="stored")` on a stub transport.

The recorded fetch's manifest answers `GET /datasets/{spec_id}` for each member,
and the files route answers the file's bytes, as the website's gateway does.
`scripts/gen_sync.py` derives `tests/_sync/datasets/test_latest_stored.py` from
this file, so the sync client passes the same tests.
"""

import copy
import json
from typing import Any

import httpx2
import pytest

from dfo._core.errors import (
    ContractError,
    DfoTimeoutError,
    InvalidRequestError,
    NetworkError,
)
from dfo._core.refs import DatasetRef, RefMember
from dfo._core.types import Rendering, Spec
from dfo._datasets.bundle import load
from dfo._datasets.cache import sha256_digest
from dfo._datasets.recipe import recipe
from dfo._datasets.resolve import current_manifest, fetch
from dfo._http.transport import AsyncTransport
from tests._data import CONTRACT
from tests._data import DATA as RECORDED
from tests._data import load as load_recorded
from tests._datasets import PARQUET, manifest, recorded_member
from tests._fetch_support import (
    BASE,
    OP_ID,
    FakeCache,
    Server,
    json_response,
    operation,
    parquet,
)

pytestmark = pytest.mark.anyio

NEWER = "cv_" + "1" * 32
OTHER = "spec_" + "0" * 32
DATA = PARQUET.read_bytes()
_RECORDED = recorded_member()
HELD = RefMember(
    parts=(),
    sentence=_RECORDED.sentence,
    spec=_RECORDED.spec,
    content_version=_RECORDED.content_version,
    digest=_RECORDED.digest,
    rendering=Rendering("parquet", False, without_party_totals=True),
)


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


def make(server: Server, timeline: Timeline | None = None) -> AsyncTransport:
    timeline = timeline or Timeline()
    return AsyncTransport(
        http_transport=httpx2.MockTransport(server),
        sleep=timeline.sleep,
        clock=timeline.clock,
        api_key=False,
        base_url=BASE,
    )


def manifest_of(spec_id: str) -> dict[str, Any]:
    """The recorded manifest as the stored newest version of `spec_id`, at `NEWER`."""
    body = manifest()
    body["content_version"] = NEWER
    body["definition"]["spec_id"] = spec_id
    body["warnings"] = []
    return body


def member_of(spec_id: str) -> RefMember:
    """The held member under another spec id, so a ref holds two members."""
    definition = {**copy.deepcopy(HELD.spec.definition), "spec_id": spec_id}
    return RefMember(
        parts=("another part",),
        sentence=HELD.sentence,
        spec=Spec(spec_id, definition, HELD.sentence),
        content_version=HELD.content_version,
        digest=HELD.digest,
        rendering=HELD.rendering,
    )


def stated(freshness: str | None) -> dict[str, str]:
    return {} if freshness is None else {"x-dfo-freshness": freshness}


async def test_reads_the_stored_version_in_the_members_rendering_then_its_file() -> (
    None
):
    server = Server(
        json_response(200, manifest_of(HELD.spec.spec_id), stated("pending")),
        parquet(DATA),
    )
    async with make(server) as transport:
        data = await fetch(transport, DatasetRef((HELD,)), latest="stored")
    asked = server.requests[0].url
    assert asked.path == f"/api/v1/datasets/{HELD.spec.spec_id}"
    # The ref's member leaves party totals out, so the read asks for the cut.
    assert dict(asked.params) == {
        "format": "parquet",
        "bundle": "false",
        "party_totals": "false",
    }
    assert "/files/sha256:" in str(server.requests[1].url)
    assert len(server.requests) == 2
    (member,) = data.members
    assert member.content_version == NEWER
    assert data.sentence == HELD.sentence
    assert data.freshness == "pending"
    # The ref names the version read, and neither it nor the saved file holds
    # the freshness.
    assert data.ref.members[0].content_version == NEWER
    assert "freshness" not in data.ref.to_json()
    assert "pending" not in data.ref.to_json()
    assert load(data.to_bytes()).freshness is None


# Each row gives the members' `x-dfo-freshness` headers, None for none, and the
# dataset's freshness.
@pytest.mark.parametrize(
    ("headers", "freshness"),
    [
        (("current", "stale"), "stale"),
        (("pending", "current"), "pending"),
        (("current", "current"), "current"),
        (("stale", None), None),
        (("current", "fresh"), None),
        ((" Stale ", "current"), "stale"),
    ],
    ids=[
        "stale-worst",
        "pending-worst",
        "current",
        "one-unstated",
        "one-unknown",
        "trimmed-lowered",
    ],
)
async def test_the_freshness_is_the_worst_the_members_state(
    headers: tuple[str | None, str | None], freshness: str | None
) -> None:
    server = Server(
        json_response(200, manifest_of(HELD.spec.spec_id), stated(headers[0])),
        parquet(DATA),
        json_response(200, manifest_of(OTHER), stated(headers[1])),
        parquet(DATA),
    )
    ref = DatasetRef((HELD, member_of(OTHER)))
    async with make(server) as transport:
        data = await fetch(transport, ref, latest="stored")
    assert len(data.members) == 2
    assert data.freshness == freshness


async def test_a_202_is_followed_through_its_operation_to_a_current_version() -> None:
    timeline = Timeline()
    server = Server(
        # The 202 states stale, and the operation that follows it reads the
        # version current.
        json_response(
            202, operation("running"), {"retry-after": "2", **stated("stale")}
        ),
        json_response(200, operation("done", body=manifest_of(HELD.spec.spec_id))),
        parquet(DATA),
    )
    async with make(server, timeline) as transport:
        data = await fetch(transport, DatasetRef((HELD,)), latest="stored")
    assert server.requests[1].method == "GET"
    assert str(server.requests[1].url) == f"{BASE}/datasets/operations/{OP_ID}"
    assert timeline.sleeps == [2.0]
    assert data.members[0].content_version == NEWER
    assert data.freshness == "current"


async def test_an_answer_for_another_spec_raises_contract_violation() -> None:
    server = Server(json_response(200, manifest_of(OTHER)))
    async with make(server) as transport:
        with pytest.raises(ContractError) as raised:
            await fetch(transport, DatasetRef((HELD,)), latest="stored")
    assert raised.value.code == "contract_violation"
    assert raised.value.pointer == "/definition/spec_id"
    assert len(server.requests) == 1


def derived_ref() -> DatasetRef:
    record = json.loads((CONTRACT / "refs" / "ref-derived-member.json").read_text())
    return DatasetRef.from_json(json.dumps(record["ref"]))


@pytest.mark.parametrize(
    ("target", "named"),
    [
        (lambda: HELD.spec, "fetch(spec)"),
        (lambda: "https://site.example/s/CJmD6XzG", 'takes no latest="stored"'),
        (derived_ref, "use latest=True"),
        (lambda: recipe(derived_ref()).rank(by="origin"), "or use latest=True"),
        (
            lambda: recipe(HELD.spec).compare(derived_ref(), on="destination"),
            "or use latest=True",
        ),
        (lambda: recipe(DatasetRef((HELD,))), "A recipe with no step"),
    ],
    ids=[
        "spec",
        "share",
        "derived-ref",
        "recipe-of-a-computed-frame",
        "recipe-whose-other-reading-is-computed",
        "recipe-with-no-step",
    ],
)
async def test_latest_stored_is_refused_before_any_request(
    target: Any, named: str
) -> None:
    server = Server()
    async with make(server) as transport:
        with pytest.raises(InvalidRequestError) as raised:
            await fetch(transport, target(), latest="stored")
    assert raised.value.code == "invalid_argument"
    assert named in str(raised.value)
    assert server.requests == []


def analysed() -> list[httpx2.Response]:
    """The recorded analysis's ready answer, derived manifest and frame."""
    return [
        json_response(200, load_recorded("analysis-rank-ready.json")),
        json_response(200, load_recorded("analysis-rank-manifest.json")),
        parquet((RECORDED / "analysis-rank-frame.parquet").read_bytes()),
    ]


async def test_a_recipe_runs_on_each_readings_stored_version_without_its_file() -> None:
    other = Spec(OTHER, {})
    server = Server(
        json_response(200, manifest_of(HELD.spec.spec_id), stated("current")),
        json_response(200, manifest_of(OTHER), stated("stale")),
        *analysed(),
    )
    chain = (
        recipe(DatasetRef((HELD,)))
        .quotient_of(other, on={"destination": "place"})
        .rank(by="destination", per="origin", limit=2)
    )
    async with make(server) as transport:
        data = await fetch(transport, chain, latest="stored")

    held, spec = server.requests[0].url, server.requests[1].url
    assert held.path == f"/api/v1/datasets/{HELD.spec.spec_id}"
    assert dict(held.params) == {
        "format": "parquet",
        "bundle": "false",
        "party_totals": "false",
    }
    # A Spec root is read in the frame without party totals, as its rendering
    # states.
    assert spec.path == f"/api/v1/datasets/{OTHER}"
    assert dict(spec.params) == {**dict(held.params), "layout": "frame"}
    assert [request.method for request in server.requests] == [
        "GET",
        "GET",
        "POST",
        "GET",
        "GET",
    ]
    tree = chain.tree()
    tree["inputs"]["data"]["inputs"]["data"]["content_version"] = NEWER
    tree["inputs"]["data"]["inputs"]["other"]["content_version"] = NEWER
    assert server.body(2) == {"tree": tree, "latest": False}
    assert data.freshness == "stale"


async def test_a_spec_two_roots_read_is_looked_up_once() -> None:
    server = Server(json_response(200, manifest_of(HELD.spec.spec_id)), *analysed())
    chain = recipe(DatasetRef((HELD,))).share_of(DatasetRef((HELD,)))
    async with make(server) as transport:
        data = await fetch(transport, chain, latest="stored")
    assert [request.method for request in server.requests] == [
        "GET",
        "POST",
        "GET",
        "GET",
    ]
    inputs = server.body(1)["tree"]["inputs"]
    assert inputs["data"]["content_version"] == NEWER
    assert inputs["other"]["content_version"] == NEWER
    assert data.freshness is None


async def test_a_root_of_several_members_is_refused_before_any_request() -> None:
    server = Server()
    chain = recipe(DatasetRef((HELD, member_of(OTHER)))).rank(by="origin")
    async with make(server) as transport:
        with pytest.raises(InvalidRequestError) as raised:
            await fetch(transport, chain, latest="stored")
    assert raised.value.code == "several_members"
    assert server.requests == []


async def test_offline_each_member_reads_its_newest_cached_version_as_stale(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cache = FakeCache()
    cache.put_bytes(sha256_digest(DATA), DATA)
    cache.put_manifest(
        HELD.spec.spec_id, NEWER, HELD.rendering, manifest_of(HELD.spec.spec_id)
    )
    monkeypatch.setenv("DFO_OFFLINE", "1")
    server = Server()
    async with make(server) as transport:
        data = await fetch(transport, DatasetRef((HELD,)), latest="stored", cache=cache)
    assert server.requests == []
    assert data.stale is True
    assert data.freshness is None
    (member,) = data.members
    assert member.content_version == NEWER


async def test_offline_a_member_with_nothing_cached_raises_offline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DFO_OFFLINE", "1")
    server = Server()
    async with make(server) as transport:
        with pytest.raises(NetworkError) as raised:
            await fetch(
                transport, DatasetRef((HELD,)), latest="stored", cache=FakeCache()
            )
    assert raised.value.code == "offline"
    assert server.requests == []


async def test_a_deadline_on_the_first_get_is_a_plain_read_timeout() -> None:
    timeline = Timeline()
    server = Server(httpx2.ReadTimeout("slow"))

    def handler(request: httpx2.Request) -> httpx2.Response:
        timeline.now += 5.0
        return server(request)

    async with make(handler, timeline) as transport:
        with pytest.raises(DfoTimeoutError) as raised:
            await fetch(transport, DatasetRef((HELD,)), latest="stored", timeout=5.0)
    assert raised.value.code == "deadline_exceeded"
    assert "still running" not in str(raised.value)


async def test_a_deadline_while_polling_says_the_build_is_still_running() -> None:
    timeline = Timeline()
    server = Server(
        json_response(202, operation("running"), {"retry-after": "2"}),
        json_response(200, operation("running")),
    )
    async with make(server, timeline) as transport:
        with pytest.raises(DfoTimeoutError) as raised:
            await fetch(transport, DatasetRef((HELD,)), latest="stored", timeout=1.0)
    assert raised.value.code == "deadline_exceeded"
    assert "still running" in str(raised.value)


async def test_current_manifest_refuses_a_spec_id_that_is_not_a_server_id() -> None:
    server = Server()
    async with make(server) as transport:
        with pytest.raises(InvalidRequestError) as raised:
            await current_manifest(
                transport,
                "not-a-spec",
                HELD.rendering,
                deadline=None,
                timeout=None,
                on_progress=lambda *_: None,
            )
    assert raised.value.code == "invalid_argument"
    assert server.requests == []
