"""Tests for the client: search to dataset through its cache, options, raw requests
and lookups.

`scripts/gen_sync.py` derives `tests/_sync/client/test_client.py` from this file,
so the sync client passes the same tests.
"""

import json
import warnings
from datetime import date
from pathlib import Path

import httpx2
import pytest

from dfo._client.client import AsyncClient
from dfo._core.errors import (
    ContractError,
    DfoError,
    InvalidRequestError,
    NetworkError,
    NotFoundError,
    RateLimitError,
    ServerError,
)
from dfo._core.lookup_results import Catalogue, Code, Entity, Match, Node
from dfo._core.refs import DatasetRef, RefMember
from dfo._core.types import Rendering, Spec
from dfo._datasets.cache import Cache
from dfo._datasets.fetch import Session
from dfo._http.transport import AsyncTransport
from tests._fetch_support import (
    BASE,
    ORIGIN,
    Replay,
    Server,
    json_response,
    posted_spec,
    problem,
)

pytestmark = pytest.mark.anyio

QUESTION = "ODA disbursements from Germany to Nigeria for basic health care"


def client_over(handler, cache: Cache | None = None) -> AsyncClient:
    transport = AsyncTransport(
        base_url=BASE, api_key=False, http_transport=httpx2.MockTransport(handler)
    )
    return AsyncClient._over(Session(transport, cache))


@pytest.fixture(autouse=True)
def online(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DFO_OFFLINE", raising=False)
    monkeypatch.setenv("DFO_PROGRESS", "0")


@pytest.mark.parametrize(
    ("argument", "named"),
    [(None, True), (BASE, False)],
    ids=["environment", "argument"],
)
async def test_the_repr_names_dfo_base_url_when_the_base_url_came_from_it(
    monkeypatch: pytest.MonkeyPatch, argument: str | None, named: bool
) -> None:
    monkeypatch.setenv("DFO_BASE_URL", "https://env.example.org/api")
    async with AsyncClient(base_url=argument, api_key=False, cache=False) as client:
        assert client.base_url in repr(client)
        assert ("(from DFO_BASE_URL)" in repr(client)) is named


async def test_a_clients_hints_name_client_and_so_do_its_copies() -> None:
    spec = Spec("spec_x", posted_spec()["definition"])
    async with AsyncClient(base_url=BASE, api_key=False, cache=False) as client:
        for each in (client, client.with_options(timeout=5)):
            with pytest.raises(InvalidRequestError) as caught:
                await each.fetch(spec, latest=True)
            assert "drop it: client.fetch(spec)." in str(caught.value)


async def test_offline_search_raises_before_any_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DFO_OFFLINE", "1")
    server = Server()
    async with client_over(server) as client:
        with pytest.raises(NetworkError) as caught:
            await client.search(QUESTION)
    assert caught.value.code == "offline"
    assert server.requests == []


async def test_an_answer_fetches_through_the_clients_cache(tmp_path: Path) -> None:
    replay = Replay("answer-definite-fetch")
    expected = replay.record["expect"][1]["dataset"]
    async with client_over(replay, Cache(tmp_path)) as client:
        answer = await client.search(QUESTION)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            data = await answer.fetch()
        assert (len(data), list(data.to_arrow().column_names)) == (
            expected["rows"],
            expected["columns"],
        )
        assert data.members[0].parts == (answer.parts[0].variable_text,)
        assert replay.exchanges == []

        # The cache now holds the version, so the ref reads back with no request.
        ref = DatasetRef.from_json(data.ref.to_json())
        again = await client.fetch(ref)
    assert len(again) == len(data)
    assert len(replay.requests) == 4


async def test_with_options_shares_the_connections_and_only_the_owner_closes() -> None:
    server = Server(json_response(200, {"ok": True}), json_response(200, {"ok": 1}))
    client = client_over(server)
    quick = client.with_options(timeout=5.0, max_retries=0)
    assert (quick.base_url, quick._current().cache) == (BASE, None)
    assert quick._current().transport.timeout == 5.0
    await quick.aclose()
    assert (await client.request("GET", "/datasets/capabilities")).json() == {
        "ok": True
    }
    await client.aclose()
    await client.aclose()
    calls = [
        lambda: quick.request("GET", "/datasets/capabilities"),
        lambda: client.search(QUESTION),
        client.lookup.catalogue,
    ]
    for call in calls:
        with pytest.raises(InvalidRequestError, match="closed") as caught:
            await call()
        assert caught.value.code == "invalid_argument"
    assert len(server.requests) == 1


async def test_request_returns_the_raw_response_and_raises_a_refusal() -> None:
    server = Server(
        json_response(200, {"versions": []}, {"x-dfo-trace-id": "t1"}),
        problem(404, "spec_not_found"),
    )
    async with client_over(server) as client:
        raw = await client.request(
            "GET", "/datasets/spec_x/versions", params={"limit": 1}
        )
        with pytest.raises(NotFoundError) as caught:
            await client.request("POST", "/datasets", json={"input": {}})
    assert (raw.status_code, raw.headers["x-dfo-trace-id"], raw.json()) == (
        200,
        "t1",
        {"versions": []},
    )
    assert caught.value.code == "spec_not_found"
    assert server.calls() == [
        f"GET {BASE}/datasets/spec_x/versions",
        f"POST {BASE}/datasets",
    ]
    assert server.requests[0].url.params["limit"] == "1"
    assert server.body(1) == {"input": {}}


async def test_a_refused_method_is_the_callers_on_a_raw_request_only() -> None:
    refused = problem(405, "method_not_allowed")
    server = Server(refused, refused)
    async with client_over(server) as client:
        with pytest.raises(InvalidRequestError) as raw:
            await client.request("DELETE", "/search/catalogue")
        with pytest.raises(ContractError) as wrapped:
            await client.lookup.catalogue()
    assert (raw.value.code, raw.value.status) == ("method_not_allowed", 405)
    assert raw.value.trace_id == "trace"
    assert isinstance(raw.value.__cause__, ContractError)
    assert wrapped.value.code == "method_not_allowed"


@pytest.mark.parametrize(
    "path",
    [
        "//files.example.net/x",
        f"{ORIGIN}/api/datasets",
        "datasets/schema",
        "/../../etc/passwd",
    ],
    ids=["scheme-relative", "absolute-on-origin", "no-slash", "dot-segments"],
)
async def test_request_refuses_what_is_not_a_path_under_the_base_url(
    path: str,
) -> None:
    server = Server()
    async with client_over(server) as client:
        with pytest.raises(InvalidRequestError) as caught:
            await client.request("GET", path)
    assert caught.value.code == "invalid_argument"
    assert server.calls() == []


_FOREIGN_MEMBER = RefMember(
    parts=(),
    sentence="A reading.",
    spec=Spec("../../search/resolve", {}),
    content_version="cv_" + "0" * 32,
    digest="sha256:" + "0" * 64,
    rendering=Rendering("parquet", bundle=False),
)


@pytest.mark.parametrize(
    "call",
    [
        lambda client: client.lookup.node("../x"),
        lambda client: client.lookup.node("country/%2e%2e/admin"),
        lambda client: client.lookup.node("country/NGA?x=1"),
        lambda client: client.lookup.node("country/NGA#x"),
        lambda client: client.lookup.node("country/\tNGA"),
        lambda client: client.lookup.node(""),
        lambda client: client.fetch(DatasetRef((_FOREIGN_MEMBER,))),
        lambda client: client.lookup.code("../datasets"),
        lambda client: client.lookup.code("Spec_Not_Found"),
        lambda client: client.lookup.code("spec not found"),
        lambda client: client.lookup.code("_spec"),
        lambda client: client.lookup.code(""),
    ],
    ids=[
        "dcid-dots",
        "dcid-encoded-dots",
        "dcid-query",
        "dcid-fragment",
        "dcid-control",
        "dcid-empty",
        "ref-spec-id",
        "code-dots",
        "code-upper",
        "code-space",
        "code-leading-underscore",
        "code-empty",
    ],
)
async def test_an_id_that_would_leave_its_route_is_refused_unsent(call) -> None:
    server = Server()
    async with client_over(server) as client:
        with pytest.raises(InvalidRequestError) as caught:
            await call(client)
    assert caught.value.code == "invalid_argument"
    assert server.calls() == []


_SPEC = Spec(posted_spec()["spec_id"], posted_spec()["definition"])


@pytest.mark.parametrize(
    "call",
    [
        lambda client: client.search(""),
        lambda client: client.search(" \t\n"),
        lambda client: client.search(b"GDP of Kenya"),
        lambda client: client.search("GDP \ud800 Kenya"),
        lambda client: client.fetch(_SPEC, layout=""),
        lambda client: client.fetch(_SPEC, window=(2020, 2010)),
        lambda client: client.fetch(_SPEC, window=(10**30, 10**31)),
        lambda client: client.fetch(_SPEC, entities={"origin": 5}),
        lambda client: client.fetch(_SPEC, entities=["origin"]),
        lambda client: client.fetch(_SPEC, facets="unit"),
    ],
    ids=[
        "question-empty",
        "question-whitespace",
        "question-bytes",
        "question-lone-surrogate",
        "layout-empty",
        "window-reversed",
        "window-past-json-integers",
        "role-bound-to-a-number",
        "entities-a-list",
        "facets-a-string",
    ],
)
async def test_an_argument_the_client_checks_is_refused_unsent(call) -> None:
    server = Server()
    async with client_over(server) as client:
        with pytest.raises(InvalidRequestError) as caught:
            await call(client)
    assert caught.value.code == "invalid_argument"
    assert server.calls() == []


LOOKUPS = {
    "resolve": lambda client: client.lookup.resolve("Nigeria"),
    "node": lambda client: client.lookup.node("country/NGA"),
    "code": lambda client: client.lookup.code("spec_not_found"),
    "catalogue": lambda client: client.lookup.catalogue(),
}


@pytest.mark.parametrize("lookup", LOOKUPS.values(), ids=LOOKUPS.keys())
@pytest.mark.parametrize(
    ("code", "error", "raised"),
    [
        ("service_unavailable", ServerError, "service_unavailable"),
        ("query_too_long", InvalidRequestError, "query_too_long"),
        ("rate_limited", RateLimitError, "rate_limited"),
        ("a_code_from_the_future", ContractError, "contract_violation"),
    ],
)
async def test_a_lookup_answering_a_problem_document_raises_its_error(
    lookup, code: str, error: type[DfoError], raised: str
) -> None:
    server = Server(json_response(200, {"code": code, "trace_id": "t-1"}))
    async with client_over(server) as client:
        with pytest.raises(error) as caught:
            await lookup(client)
    assert (caught.value.code, caught.value.trace_id) == (raised, "t-1")


CATALOGUE = {"catalogue_version": "v1", "counts": {}, "examples": []}


@pytest.mark.parametrize(
    ("lookup", "body", "pointer"),
    [
        ("resolve", [], ""),
        ("resolve", {"results": {}}, "/results"),
        ("resolve", {"results": [{"status": "resolved"}]}, "/results/0/input"),
        (
            "resolve",
            {"results": [{"input": "Nigeria", "status": "resolved", "entity": {}}]},
            "/results/0/entity/ref",
        ),
        (
            "resolve",
            {"results": [{"input": "x", "status": "not_found", "near_matches": [1]}]},
            "/results/0/near_matches/0",
        ),
        ("node", {"kind": 1, "ref": "country/NGA"}, "/kind"),
        ("node", {"kind": "country"}, "/ref"),
        ("code", None, ""),
        ("catalogue", {"counts": {}, "examples": []}, "/catalogue_version"),
        ("catalogue", {**CATALOGUE, "counts": []}, "/counts"),
        ("catalogue", {**CATALOGUE, "examples": None}, "/examples"),
    ],
)
async def test_a_lookup_refuses_a_body_its_schema_does_not_fit(
    lookup: str, body: object, pointer: str
) -> None:
    server = Server(json_response(200, body, headers={"x-dfo-trace-id": "t-1"}))
    async with client_over(server) as client:
        with pytest.raises(ContractError) as caught:
            await LOOKUPS[lookup](client)
    assert (caught.value.code, caught.value.pointer, caught.value.trace_id) == (
        "contract_violation",
        pointer,
        "t-1",
    )


NIGERIA = {"ref": "country/NGA", "label": "Nigeria", "kind": "country"}
RESOLVED = {
    "results": [
        {"input": "Nigeria", "status": "resolved", "entity": NIGERIA},
        {
            "input": "Nigria",
            "status": "not_found",
            "entity": None,
            "candidates": None,
            "near_matches": [NIGERIA],
        },
    ]
}
NODE = {
    "ref": "country/NGA",
    "label": "Nigeria",
    "kind": "country",
    "types": ["Country"],
}
ENTRY = {"code": "spec_not_found", "definition": "No such spec.", "mappings": []}
PLACE_CATALOGUE = {
    "catalogue_version": "v1",
    "counts": {"publishers": 7, "variables": 13847, "aid": {}},
    "examples": [{"text": "ODA to Nigeria since 2015"}, {"template": "x"}],
}


async def test_lookups_reach_the_graph_the_registry_and_the_catalogue() -> None:
    server = Server(
        json_response(200, RESOLVED),
        json_response(200, NODE),
        json_response(200, ENTRY),
        json_response(200, PLACE_CATALOGUE),
    )
    async with client_over(server) as client:
        resolved = await client.lookup.resolve(
            "Nigeria", "Sahel", kinds=["country", "group"], expand_members=True
        )
        node = await client.lookup.node("country/NGA", as_of=date(2026, 1, 31))
        entry = await client.lookup.code("spec_not_found")
        catalogue = await client.lookup.catalogue(place="country/NGA")
    nigeria = Entity("country/NGA", "Nigeria", "country")
    assert resolved == [
        Match("Nigeria", "resolved", nigeria, (), (), RESOLVED["results"][0]),
        Match("Nigria", "not_found", None, (), (nigeria,), RESOLVED["results"][1]),
    ]
    assert [match.raw for match in resolved] == RESOLVED["results"]
    assert node == Node("country/NGA", "Nigeria", "country", ("Country",), NODE)
    assert entry == Code("spec_not_found", "No such spec.", ENTRY)
    # An example without its text is left out.
    assert catalogue == Catalogue(
        "v1", PLACE_CATALOGUE["counts"], ("ODA to Nigeria since 2015",), PLACE_CATALOGUE
    )
    assert (node.raw, entry.raw, catalogue.raw) == (NODE, ENTRY, PLACE_CATALOGUE)
    assert [str(request.url) for request in server.requests] == [
        f"{BASE}/graph/resolve",
        f"{BASE}/graph/node/country/NGA?as_of=2026-01-31",
        f"{ORIGIN}/codes/spec_not_found",
        f"{BASE}/search/catalogue?place=country%2FNGA",
    ]
    assert json.loads(server.requests[0].content) == {
        "texts": ["Nigeria", "Sahel"],
        "kinds": ["country", "group"],
        "expand": ["members"],
    }
