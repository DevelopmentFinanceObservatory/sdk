"""Tests for fetching: spec builds, narrowing, sentences, downloads and stored versions.

`scripts/gen_sync.py` derives `tests/_sync/datasets/test_fetch.py` from this file,
so the sync client passes the same tests.
"""

import copy
import json
import warnings
from pathlib import Path

import httpx2
import pytest

import dfo._datasets.fetch as fetch_module
import dfo._datasets.resolve as resolve_module
from dfo._core import errors as _errors
from dfo._core.errors import (
    ContractError,
    DataWarning,
    DfoError,
    DfoWarning,
    InvalidRequestError,
    NetworkError,
    NotFoundError,
    PermissionDeniedError,
    ServerError,
    VersionUnavailableError,
)
from dfo._core.parse import parse_spec
from dfo._core.refs import DatasetRef, RefMember
from dfo._core.types import FormatError, Rendering, Spec
from dfo._datasets.build import Reading
from dfo._datasets.cache import Cache, file_entry, manifest_entry, sha256_digest
from dfo._datasets.dataset import build_dataset
from dfo._datasets.fetch import fetch_members
from dfo._datasets.resolve import fetch
from dfo._http.transport import AsyncTransport
from tests._data import load
from tests._fetch_support import (
    BASE,
    CUT,
    CUT_DATA,
    DATA,
    FRAME,
    LONG,
    NARROWED_CV,
    NARROWED_ID,
    ORIGIN,
    POSTED_ID,
    SIGNED,
    FakeCache,
    Replay,
    Server,
    fake_build_dataset,
    files_path,
    json_response,
    live_server,
    manifest,
    parquet,
    posted_spec,
    problem,
    redirect,
    resubmitted,
    with_cut,
)

pytestmark = pytest.mark.anyio

KEY = "dfo_k_4f8Kq2ZtR7mWx1NcB9vLp3YhD6sGa0Ue2wanxe"
SENTENCE = "Germany's gross ODA disbursements to Nigeria for basic health care, 2020 to 2023. Current US dollars · OECD Creditor Reporting System (CRS)."


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
def fake_dataset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(fetch_module, "build_dataset", fake_build_dataset)
    monkeypatch.setattr(resolve_module, "build_dataset", fake_build_dataset)
    monkeypatch.setattr(_errors, "_warned", set())
    monkeypatch.delenv("DFO_OFFLINE", raising=False)


def make(handler, timeline: Timeline | None = None, **options) -> AsyncTransport:
    timeline = timeline or Timeline()
    options.setdefault("api_key", KEY)
    options.setdefault("base_url", BASE)
    return AsyncTransport(
        http_transport=httpx2.MockTransport(handler),
        sleep=timeline.sleep,
        clock=timeline.clock,
        **options,
    )


# What hints name the owner of a call: a client the user builds, or the
# default client behind `dfo.fetch`.
CALLERS = pytest.mark.parametrize("caller", ["client", "dfo"])


def spec(sentence: str | None = None) -> Spec:
    return Spec(
        parse_spec(posted_spec()).spec_id, posted_spec()["definition"], sentence
    )


def ref_member(
    content_version: str = NARROWED_CV,
    data: bytes = DATA,
    rendering: Rendering = LONG,
) -> RefMember:
    body = manifest()
    return RefMember(
        parts=("ODA disbursements for basic health care",),
        sentence=SENTENCE,
        spec=Spec(NARROWED_ID, body["definition"], SENTENCE),
        content_version=content_version,
        digest=sha256_digest(data),
        rendering=rendering,
    )


@pytest.mark.parametrize(
    "target",
    [POSTED_ID, {"spec_id": POSTED_ID, "definition": {}}, None],
    ids=["spec-id", "spec-dict", "none"],
)
async def test_a_target_that_is_not_a_spec_sends_nothing(target: object) -> None:
    server = Server()
    async with make(server) as transport:
        with pytest.raises(InvalidRequestError) as caught:
            await fetch(transport, target)
    assert caught.value.code == "invalid_argument"
    assert server.requests == []


@pytest.mark.parametrize(
    ("target", "options"),
    [
        ("spec", {"strict": "yes"}),
        ("spec", {"progress": 5}),
        ("ref", {"strict": 1}),
        ("ref", {"progress": "no"}),
    ],
    ids=["spec-strict", "spec-progress", "ref-strict", "ref-progress"],
)
async def test_a_switch_that_is_not_a_bool_sends_nothing(
    target: str, options: dict
) -> None:
    server = Server()
    async with make(server) as transport:
        with pytest.raises(InvalidRequestError) as caught:
            if target == "spec":
                await fetch(transport, spec(SENTENCE), **options)
            else:
                await fetch(transport, DatasetRef((ref_member(),)), **options)
    assert caught.value.code == "invalid_argument"
    assert server.requests == []


async def test_a_spec_with_its_sentence_replays_the_recorded_build() -> None:
    replay = Replay("fetch-spec-known-sentence", base_url=BASE)
    call = replay.record["call"][0]["spec"]
    target = Spec(call["spec_id"], call["definition"], call["sentence"])
    async with make(replay) as transport:
        with pytest.warns(DataWarning, match="coverage falls short") as caught:
            built = await fetch(transport, target)
    assert replay.exchanges == []
    expected = replay.record["expect"][0]["dataset"]["members"][0]
    (member,) = built.members
    assert (member.parts, member.spec.spec_id, member.content_version) == (
        tuple(expected["parts"]),
        expected["spec_id"],
        expected["content_version"],
    )
    assert member.sentence == member.spec.sentence == expected["sentence"]
    assert member.digest == sha256_digest(member.data)
    assert member.spec.definition is not target.definition
    assert caught[0].message.code == "coverage_below_scope"
    signed = replay.requests[-1]
    assert "authorization" not in signed.headers
    assert replay.requests[0].headers["authorization"] == f"Bearer {KEY}"
    assert (built.layout, built.complete, built.stale) == ("long", True, False)


async def test_a_narrowed_spec_stores_the_built_identity_and_asks_search_its_sentence() -> (
    None
):
    body = manifest(retention={"pinned": False, "held_until": "2026-11-19T13:59:18Z"})
    server = Server(
        json_response(200, body),
        json_response(200, resubmitted()),
        redirect(),
        parquet(),
    )
    async with make(server) as transport:
        built = await fetch(
            transport,
            spec("Germany's gross ODA disbursements to Nigeria, 1995 to 2024."),
            window=(2020, 2023),
            entities={"destination": ["country/NGA"]},
            facets={"measurementMethod": None},
        )
    assert server.calls() == [
        f"POST {BASE}/datasets",
        f"POST {BASE}/search/resolve",
        f"GET {files_path(body)}",
        f"GET {SIGNED.split('?')[0]}",
    ]
    posted = server.body(0)
    assert posted["input"]["spec_id"] == POSTED_ID
    assert posted["input"]["definition"] == posted_spec()["definition"]
    assert posted["input"]["scope"] == {
        "window": {"kind": "range", "start_year": 2020, "end_year": 2023},
        "entities": {"destination": ["country/NGA"], "origin": ["country/DEU"]},
        "facets": {"measurementMethod": {"ref": None}},
    }
    assert posted["options"] == {"format": "parquet", "bundle": False}
    assert server.body(1) == {
        "schema_version": 1,
        "input": {
            "kind": "dataset_resubmit",
            "entries": [
                {
                    "entry_kind": "identity",
                    "variable_text": "dataset",
                    "identity": body["definition"]["identity"],
                }
            ],
        },
    }
    (member,) = built.members
    assert (member.spec.spec_id, member.content_version) == (NARROWED_ID, NARROWED_CV)
    assert member.sentence == SENTENCE
    assert "2020 to 2023" in member.sentence
    assert member.manifest == body
    assert member.manifest["retention"] == body["retention"]


@pytest.mark.parametrize(
    ("entities", "posted"),
    [
        (
            {"origin": ["country/FRA"]},
            {"destination": ["country/NGA"], "origin": ["country/FRA"]},
        ),
        (
            {"origin": [" country/FRA\n"]},
            {"destination": ["country/NGA"], "origin": ["country/FRA"]},
        ),
        ({"origin": None}, {"destination": ["country/NGA"]}),
        (None, None),
        ({}, None),
    ],
)
async def test_entities_rebind_only_the_roles_named(
    entities: dict | None, posted: dict | None
) -> None:
    server = Server(
        json_response(200, manifest()),
        json_response(200, resubmitted()),
        redirect(),
        parquet(),
    )
    async with make(server) as transport:
        await fetch(transport, spec(), window="latest", entities=entities)
    assert server.body(0)["input"]["scope"].get("entities") == posted


async def test_an_answer_part_resubmits_with_its_first_part() -> None:
    server = Server(
        json_response(200, manifest()),
        json_response(200, resubmitted()),
        redirect(),
        parquet(),
    )
    async with make(server) as transport:
        built = await fetch_members(
            transport,
            [Reading(("ODA", "aid"), spec())],
            narrowing={"window": {"kind": "latest"}},
        )
    entry = server.body(1)["input"]["entries"][0]
    assert entry["variable_text"] == "ODA"
    assert built.members[0].parts == ("ODA", "aid")


SAHEL = {"label": "Sahel", "group_id": "groups/Sahel"}
EU = {"label": "European Union", "group_id": "groups/EU"}
GROUPS = {"destination": SAHEL, "origin": EU}


@pytest.mark.parametrize(
    ("narrowing", "built", "sent"),
    [
        ({"window": "latest"}, None, GROUPS),
        ({"entities": {"destination": ["country/NGA"]}}, None, GROUPS),
        (
            {"entities": {"origin": ["country/FRA"]}},
            {"destination": ["country/NGA"], "origin": ["country/FRA"]},
            {"destination": SAHEL},
        ),
        (
            {"entities": {"destination": None}},
            {"origin": ["country/DEU"]},
            {"origin": EU},
        ),
        (
            {"entities": {"destination": ["country/GHA"], "origin": ["country/FRA"]}},
            {"destination": ["country/GHA"], "origin": ["country/FRA"]},
            None,
        ),
    ],
)
async def test_a_resubmit_sends_the_groups_of_the_roles_the_build_kept(
    narrowing: dict, built: dict | None, sent: object
) -> None:
    body = manifest()
    if built is not None:
        body["definition"]["identity"]["entities"] = built
    server = Server(
        json_response(200, body),
        json_response(200, resubmitted()),
        redirect(),
        parquet(),
    )
    grouped = Spec(POSTED_ID, posted_spec()["definition"], SENTENCE, GROUPS)
    async with make(server) as transport:
        await fetch(transport, grouped, **narrowing)
    assert server.body(1)["input"]["entries"][0].get("entity_groups") == sent


async def test_a_resubmit_that_answers_another_spec_raises() -> None:
    server = Server(
        json_response(200, manifest()),
        json_response(200, resubmitted(POSTED_ID), {"x-dfo-trace-id": "search"}),
    )
    async with make(server) as transport:
        with pytest.raises(ContractError) as caught:
            await fetch(transport, spec(), window="latest")
    assert (caught.value.code, caught.value.trace_id) == (
        "contract_violation",
        "search",
    )
    assert len(server.requests) == 2


NO_DATA = "No data for Germany's gross ODA disbursements to Nigeria, 1900 to 1901."


def no_data_resubmitted() -> dict[str, object]:
    """The identity resubmit answer with one `no_data` part, as Search answers a
    built identity that holds no data."""
    answer = resubmitted()
    (part,) = [part for part in load("search-3.json")["parts"] if part.get("no_data")]
    part = copy.deepcopy(part) | {"rendered_sentence": NO_DATA}
    part["no_data"]["reason"] = "no_observations"
    answer["parts"] = [part]
    return answer


@pytest.mark.parametrize("rows", [0, 4])
async def test_an_empty_narrowing_takes_the_sentence_of_its_no_data_part(
    rows: int,
) -> None:
    warning = {"code": "coverage_below_scope", "severity": "warn", "message": "none"}
    body = manifest(warnings=[warning])
    body["coverage"]["rows"] = rows
    server = Server(
        json_response(200, body),
        json_response(200, no_data_resubmitted()),
        redirect(),
        parquet(),
    )
    async with make(server) as transport:
        with pytest.warns(DataWarning) as caught_warnings:
            if rows:
                with pytest.raises(ContractError) as caught:
                    await fetch(transport, spec(SENTENCE), window=(1900, 1901))
                assert caught.value.code == "contract_violation"
                return
            built = await fetch(transport, spec(SENTENCE), window=(1900, 1901))
    assert built.members[0].sentence == NO_DATA
    assert built.members[0].spec.spec_id == NARROWED_ID
    assert [item.message.code for item in caught_warnings] == ["coverage_below_scope"]


async def test_strict_raises_a_dataset_warning_before_downloading() -> None:
    warning = {"code": "coverage_below_scope", "severity": "warn", "message": "short"}
    info = {"code": "processing_level_undeclared", "severity": "info", "message": "x"}
    server = Server(json_response(200, manifest(POSTED_ID, warnings=[info, warning])))
    async with make(server) as transport:
        with pytest.raises(DataWarning) as caught:
            await fetch(transport, spec(SENTENCE), strict=True)
    assert caught.value.code == "coverage_below_scope"
    assert len(server.requests) == 1


async def test_a_manifest_warning_has_the_clients_key_redacted() -> None:
    # The success body is redacted where it is read, before a warning quotes it.
    echoed = f"echo {KEY[:12]}\u200b{KEY[12:]}"
    warning = {"code": "coverage_below_scope", "severity": "warn", "message": echoed}
    server = Server(json_response(200, manifest(POSTED_ID, warnings=[warning])))
    async with make(server) as transport:
        with pytest.raises(DataWarning) as caught:
            await fetch(transport, spec(SENTENCE), strict=True)
    assert str(caught.value) == "echo [redacted] [coverage_below_scope]"


async def test_info_warnings_stay_quiet() -> None:
    info = {"code": "processing_level_undeclared", "severity": "info", "message": "x"}
    server = Server(
        json_response(200, manifest(POSTED_ID, warnings=[info])), redirect(), parquet()
    )
    async with make(server) as transport:
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            await fetch(transport, spec(SENTENCE))


async def test_a_frame_with_several_readings_is_refused_before_any_request() -> None:
    other = Spec(NARROWED_ID, manifest()["definition"])
    server = Server()
    async with make(server) as transport:
        with pytest.raises(InvalidRequestError, match="one reading"):
            await fetch_members(
                transport, [Reading((), spec()), Reading((), other)], layout="frame"
            )
    assert server.requests == []


async def test_a_frame_builds_the_frame_rendering() -> None:
    body = manifest(POSTED_ID, data=FRAME, layout="frame")
    server = Server(json_response(200, body), redirect(), parquet(FRAME))
    async with make(server) as transport:
        built = await fetch(transport, spec(SENTENCE), layout="frame")
    assert server.body(0)["options"] == {
        "format": "parquet",
        "bundle": False,
        "layout": "frame",
    }
    assert built.layout == "frame"
    assert built.members[0].data == FRAME


async def test_a_spec_listed_twice_builds_once_for_both_parts() -> None:
    server = Server(json_response(200, manifest(POSTED_ID)), redirect(), parquet())
    async with make(server) as transport:
        built = await fetch_members(
            transport, [Reading(("ODA",), spec(), SENTENCE), Reading(("aid",), spec())]
        )
    assert len(server.requests) == 3
    assert [member.parts for member in built.members] == [("ODA", "aid")]


async def test_members_build_one_after_another_each_finished_before_the_next() -> None:
    other = Spec(NARROWED_ID, manifest()["definition"], "Other sentence.")
    second = b"PAR1 second PAR1"
    first_body = manifest(POSTED_ID)
    second_body = manifest(NARROWED_ID, data=second)
    server = Server(
        json_response(200, first_body),
        redirect(),
        parquet(),
        json_response(200, second_body),
        redirect(),
        parquet(second),
    )
    async with make(server) as transport:
        built = await fetch_members(
            transport,
            [Reading(("a",), spec(), SENTENCE), Reading(("b",), other)],
            missing=("gap",),
        )
    assert [call.split(" ")[0] for call in server.calls()] == [
        "POST",
        "GET",
        "GET",
        "POST",
        "GET",
        "GET",
    ]
    assert [member.sentence for member in built.members] == [
        SENTENCE,
        "Other sentence.",
    ]
    assert (built.complete, built.missing) == (False, ("gap",))


async def test_member_not_resolvable_says_to_search_again() -> None:
    server = Server(problem(422, "member_not_resolvable"))
    async with make(server) as transport:
        with pytest.raises(
            InvalidRequestError, match="search the question again"
        ) as caught:
            await fetch(transport, spec(SENTENCE))
    assert caught.value.code == "member_not_resolvable"


def role_ref_refused(**problem: object) -> httpx2.Response:
    return json_response(
        422,
        {
            "code": "invalid_role_ref",
            "status": 422,
            "trace_id": "trace",
            "pointer": "/input/scope/entities/origin",
            **problem,
        },
    )


@pytest.mark.parametrize("stage", ["build", "resubmit"])
@pytest.mark.parametrize(
    ("origin", "refusal", "message"),
    [
        (
            "Germany",
            {"detail": "posted entity reference(s) not found in the graph: Germany"},
            "posted entity reference(s) not found in the graph: Germany at "
            "/input/scope/entities/origin. Entities take dcids; "
            '{caller}.lookup.resolve("Germany") finds one.',
        ),
        (
            "country/XXX",
            {"detail": "not found"},
            "not found at /input/scope/entities/origin",
        ),
        (
            "country/DEX",
            {
                "detail": "not found.",
                "alternatives": [
                    {"ref": "country/FRA", "label": "France"},
                    {"ref": "country/DEU", "label": "Germany"},
                ],
            },
            'not found at /input/scope/entities/origin. Did you mean "country/DEU"? '
            "The server offers country/FRA (France), country/DEU (Germany).",
        ),
        (
            "country/DEX",
            {
                "detail": "not found",
                "issues": [
                    {"alternatives": [{"ref": "country/DEU", "label": "Germany"}]}
                ],
            },
            'not found at /input/scope/entities/origin. Did you mean "country/DEU"? '
            "The server offers country/DEU (Germany).",
        ),
    ],
    ids=["place-name", "unknown-dcid", "alternatives", "issue-alternatives"],
)
@CALLERS
async def test_a_refused_entity_names_the_fix_and_keeps_the_refusal(
    stage: str, origin: str, refusal: dict, message: str, caller: str
) -> None:
    refused = role_ref_refused(**refusal)
    served = (
        [refused] if stage == "build" else [json_response(200, manifest()), refused]
    )
    server = Server(*served)
    async with make(server, caller=caller) as transport:
        with pytest.raises(InvalidRequestError) as caught:
            await fetch(transport, spec(), entities={"origin": [origin]})
    error = caught.value
    message = message.format(caller=caller)
    assert str(error) == f"{message} [invalid_role_ref · trace trace]"
    assert error.alternatives == tuple(refusal.get("alternatives", ()))
    assert error.problem is not None
    assert error.problem["pointer"] == "/input/scope/entities/origin"


async def test_a_signed_download_that_fails_asks_the_files_route_again() -> None:
    body = manifest(POSTED_ID)
    server = Server(
        json_response(200, body),
        redirect(),
        httpx2.Response(403),
        redirect(SIGNED + "&fresh=1"),
        parquet(),
    )
    async with make(server) as transport:
        built = await fetch(transport, spec(SENTENCE))
    assert server.calls()[1] == server.calls()[3] == f"GET {files_path(body)}"
    assert str(server.requests[4].url) == SIGNED + "&fresh=1"
    assert built.members[0].data == DATA


@pytest.mark.parametrize(
    ("location", "path"),
    [
        ("/__e2e__/blob/bucket/object?sig=1", "/__e2e__/blob/bucket/object?sig=1"),
        ("blob?sig=1", "blob?sig=1"),
    ],
    ids=["root-relative", "path-relative"],
)
async def test_a_relative_location_resolves_against_the_files_route(
    location: str, path: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A real httpx2 client, whose transport refuses a URL with no host; NO_PROXY
    # keeps a configured proxy off the loopback requests.
    monkeypatch.setenv("NO_PROXY", "*")
    body = manifest(POSTED_ID)
    route = body["artifacts"][1]["url"]
    blob = path if path.startswith("/") else route.rsplit("/", 1)[0] + "/" + path
    responses = {
        "/api/v1/datasets": (
            200,
            {"content-type": "application/json"},
            json.dumps(body).encode(),
        ),
        route: (302, {"location": location}, b""),
        blob: (200, {}, DATA),
    }
    with live_server(responses) as server:
        async with AsyncTransport(
            base_url=server.origin + "/api/v1", api_key=KEY
        ) as transport:
            built = await fetch(transport, spec(SENTENCE))
    assert [(method, seen) for method, seen, _ in server.seen] == [
        ("POST", "/api/v1/datasets"),
        ("GET", route),
        ("GET", blob),
    ]
    # The file is on the API's origin, so the fetch carries the key.
    assert "authorization" in {name.lower() for name in server.seen[2][2]}
    assert built.members[0].data == DATA


ELSEWHERE = "https://files.example.net/bucket/object"


@pytest.mark.parametrize(
    ("off", "url"),
    [
        ("location", ELSEWHERE),
        ("artifact", ELSEWHERE),
        ("artifact", SIGNED),
        ("artifact", "/api/datasets/../../admin/x"),
        ("artifact", "/api/%2e%2e/%2E%2E/admin/x"),
        ("artifact", "/api\\..\\admin/x"),
    ],
    ids=[
        "location-elsewhere",
        "artifact-elsewhere",
        "artifact-on-storage-host",
        "artifact-dot-segments",
        "artifact-encoded-dot-segments",
        "artifact-backslash-dot-segment",
    ],
)
async def test_a_file_url_off_its_allowed_origins_raises(off: str, url: str) -> None:
    # A Location may name the storage host; an artifact url names the API only.
    body = manifest(POSTED_ID)
    if off == "artifact":
        body["artifacts"][1]["url"] = url
    server = Server(
        json_response(200, body, {"x-dfo-trace-id": "build-trace"}),
        httpx2.Response(302, headers={"location": url, "x-dfo-trace-id": "route"}),
    )
    async with make(server) as transport:
        with pytest.raises(ContractError) as caught:
            await fetch(transport, spec(SENTENCE))
    assert caught.value.code == "contract_violation"
    assert len(server.requests) == (2 if off == "location" else 1)
    # The error carries the trace id of the response that named the URL.
    assert caught.value.trace_id == ("route" if off == "location" else "build-trace")


@pytest.mark.parametrize("status", [204, 301, 303, 307, 308])
async def test_a_files_route_answering_another_2xx_or_3xx_is_unexpected(
    status: int,
) -> None:
    other = httpx2.Response(status, headers={"location": SIGNED})
    server = Server(json_response(200, manifest(POSTED_ID)), other)
    async with make(server) as transport:
        with pytest.raises(ContractError) as caught:
            await fetch(transport, spec(SENTENCE))
    assert (caught.value.code, caught.value.status) == ("unexpected_response", status)
    assert len(server.requests) == 2


@pytest.mark.parametrize(
    ("failure", "error", "code"),
    [
        (httpx2.Response(403), ServerError, "download_failed"),
        (httpx2.Response(204), ServerError, "download_failed"),
        (httpx2.ConnectError("reset"), NetworkError, "network_error"),
        # A read that waits `DOWNLOAD_STALL_S` with no byte is a stall.
        (httpx2.ReadTimeout("stalled"), NetworkError, "network_error"),
    ],
    ids=["refused", "no-content", "network", "stall"],
)
async def test_a_signed_fetch_that_fails_twice_raises_its_own_failure(
    failure: httpx2.Response | Exception, error: type[Exception], code: str
) -> None:
    body = manifest(POSTED_ID)
    server = Server(json_response(200, body), redirect(), failure, redirect(), failure)
    async with make(server) as transport:
        with pytest.raises(error) as caught:
            await fetch(transport, spec(SENTENCE))
    assert caught.value.code == code
    assert server.calls()[1] == server.calls()[3] == f"GET {files_path(body)}"
    assert len(server.requests) == 5


@pytest.mark.parametrize("signed", [False, True], ids=["files-route", "signed-url"])
@pytest.mark.parametrize(
    ("size", "cap", "fits"),
    [
        (len(DATA), None, True),
        (len(DATA) - 1, None, False),
        (10**12, len(DATA) - 1, False),
    ],
    ids=["fits", "past-its-size", "size-past-the-cap"],
)
async def test_a_file_is_read_up_to_its_manifest_size_within_the_cap(
    signed: bool,
    size: int,
    cap: int | None,
    fits: bool,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A manifest's size can lower the download cap, never lift it.
    if cap is not None:
        monkeypatch.setattr(fetch_module, "DOWNLOAD_MAX_BYTES", cap)
    file = [redirect(), parquet()] if signed else [parquet()]
    server = Server(json_response(200, manifest(POSTED_ID, size=size)), *file)
    async with make(server) as transport:
        if fits:
            built = await fetch(transport, spec(SENTENCE))
            assert built.members[0].data == DATA
            return
        with pytest.raises(ServerError) as caught:
            await fetch(transport, spec(SENTENCE))
    assert caught.value.code == "response_too_large"
    assert len(server.requests) == 1 + len(file)


FILE = b"PAR1" + b"x" * 242 + b"PAR1"


@pytest.mark.parametrize(
    "route",
    [
        [httpx2.Response(302, headers={"location": SIGNED}, content=b"r" * 251)],
        [
            httpx2.Response(
                502, headers={"content-type": "text/html"}, content=b"p" * 1000
            ),
            redirect(),
        ],
    ],
    ids=["redirect-body", "refusal-page"],
)
async def test_a_route_body_past_the_file_size_is_read_under_the_json_cap(
    route: list[httpx2.Response],
) -> None:
    # The 250-byte file's size bounds its own body alone, so a longer redirect
    # body is read and a longer 502 page is retried.
    body = manifest(POSTED_ID, data=FILE, size=len(FILE))
    server = Server(json_response(200, body), *route, parquet(FILE))
    async with make(server) as transport:
        built = await fetch(transport, spec(SENTENCE))
    assert built.members[0].data == FILE
    assert len(server.requests) == 2 + len(route)


async def test_bytes_that_miss_their_digest_twice_raise() -> None:
    server = Server(
        json_response(200, manifest(POSTED_ID)),
        redirect(),
        parquet(b"other"),
        redirect(),
        parquet(b"other"),
    )
    async with make(server) as transport:
        with pytest.raises(ServerError) as caught:
            await fetch(transport, spec(SENTENCE))
    assert caught.value.code == "digest_mismatch"


async def test_a_cache_entry_that_misses_its_digest_is_downloaded_again(
    tmp_path: Path,
) -> None:
    cache = Cache(tmp_path, env={})
    digest = sha256_digest(DATA)
    cache.put_bytes(digest, DATA)
    (cache.directory / file_entry(digest)).write_bytes(b"damaged")
    server = Server(json_response(200, manifest(POSTED_ID)), redirect(), parquet())
    async with make(server) as transport:
        built = await fetch(transport, spec(SENTENCE), cache=cache)
    assert len(server.requests) == 3
    assert built.members[0].data == DATA
    assert cache.get_bytes(digest) == DATA


async def test_a_served_digest_that_is_not_sha256_fails_its_download(
    tmp_path: Path,
) -> None:
    body = manifest(POSTED_ID)
    body["artifacts"][1]["artifact_digest"] = "md5:" + "0" * 32
    cache = Cache(tmp_path, env={})
    server = Server(
        json_response(200, body), redirect(), parquet(), redirect(), parquet()
    )
    async with make(server) as transport:
        with pytest.raises(ServerError) as caught:
            await fetch(transport, spec(SENTENCE), cache=cache)
    assert caught.value.code == "digest_mismatch"
    assert not (cache.directory / "files").exists()


@pytest.mark.parametrize("target", ["spec", "ref"])
async def test_an_artifact_that_does_not_read_raises_and_leaves_the_cache(
    monkeypatch: pytest.MonkeyPatch, target: str
) -> None:
    # The fake's DATA hashes right but is no Parquet file.
    monkeypatch.setattr(fetch_module, "build_dataset", build_dataset)
    monkeypatch.setattr(resolve_module, "build_dataset", build_dataset)
    cache = FakeCache()
    fetched: Spec | DatasetRef = spec(SENTENCE)
    server = Server(json_response(200, manifest(POSTED_ID)), redirect(), parquet())
    if target == "ref":
        cache.put_bytes(sha256_digest(DATA), DATA)
        cache.put_manifest(NARROWED_ID, NARROWED_CV, LONG, manifest())
        fetched, server = DatasetRef((ref_member(),)), Server()
    async with make(server) as transport:
        with pytest.raises(ContractError) as caught:
            await fetch(transport, fetched, cache=cache)
    assert caught.value.code == "unexpected_response"
    assert cache.files == {}


async def test_cached_bytes_skip_the_download_and_new_ones_are_stored() -> None:
    cache = FakeCache()
    body = manifest(POSTED_ID)
    server = Server(json_response(200, body), redirect(), parquet())
    async with make(server) as transport:
        await fetch(transport, spec(SENTENCE), cache=cache)
        assert cache.files == {sha256_digest(DATA): DATA}
        assert (POSTED_ID, NARROWED_CV, LONG) in cache.manifests
        server.responses.append(json_response(200, body))
        built = await fetch(transport, spec(SENTENCE), cache=cache)
    assert len(server.requests) == 4
    assert built.members[0].data == DATA
    assert cache.manifests[(POSTED_ID, NARROWED_CV, LONG)]["artifacts"] == [
        body["artifacts"][1]
    ]


async def test_offline_a_spec_reads_its_newest_cached_version_as_stale(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    older = manifest(POSTED_ID, "cv_" + "1" * 32)
    older["prepared_at"] = "2026-01-01T00:00:00Z"
    newer = manifest(POSTED_ID)
    cache = FakeCache()
    cache.put_bytes(sha256_digest(DATA), DATA)
    cache.put_manifest(POSTED_ID, "cv_" + "1" * 32, LONG, older)
    cache.put_manifest(POSTED_ID, NARROWED_CV, LONG, newer)
    monkeypatch.setenv("DFO_OFFLINE", "1")
    server = Server()
    async with make(server) as transport:
        built = await fetch(transport, spec(SENTENCE), cache=cache)
        assert built.stale is True
        assert built.members[0].content_version == NARROWED_CV
        assert built.members[0].data == DATA
        for target, options in [
            (spec(SENTENCE), {"window": "latest"}),
            (spec(SENTENCE), {"entities": {"origin": ["country/FRA"]}}),
            (Spec(NARROWED_ID, newer["definition"], SENTENCE), {}),
        ]:
            with pytest.raises(NetworkError) as caught:
                await fetch(transport, target, cache=cache, **options)
            assert caught.value.code == "offline"
        with pytest.raises(NetworkError) as caught:
            await fetch(transport, spec(SENTENCE), cache=None)
        assert caught.value.code == "offline"
    assert server.requests == []


async def test_offline_a_spec_skips_a_newer_projected_version(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    older_version = "cv_" + "1" * 32
    older = manifest(POSTED_ID, older_version)
    older["prepared_at"] = "2026-01-01T00:00:00Z"
    newer = manifest(POSTED_ID)
    newer["prepared_at"] = "2026-02-01T00:00:00Z"
    projected = b"PAR1 projected version PAR1"
    projected_artifact = {
        "artifact_digest": sha256_digest(projected),
        "rendering": {
            "format": "parquet",
            "bundle": False,
            "layout": 3,
            "columns": ["value"],
        },
        "url": f"/api/datasets/{POSTED_ID}/{NARROWED_CV}/files/projected",
    }
    cache = FakeCache()
    cache.put_bytes(sha256_digest(DATA), DATA)
    cache.put_manifest(POSTED_ID, older_version, LONG, older)
    cache.put_bytes(sha256_digest(projected), projected)
    newer["artifacts"] = [projected_artifact]
    cache.put_manifest(POSTED_ID, NARROWED_CV, LONG, newer)
    monkeypatch.setenv("DFO_OFFLINE", "1")
    server = Server()
    async with make(server) as transport:
        built = await fetch(transport, spec(SENTENCE), cache=cache)
    assert built.members[0].content_version == older_version
    assert built.members[0].data == DATA
    assert server.requests == []


async def test_offline_a_spec_falls_back_when_its_newest_file_is_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    older_version = "cv_" + "1" * 32
    older = manifest(POSTED_ID, older_version)
    older["prepared_at"] = "2026-01-01T00:00:00Z"
    newer = manifest(POSTED_ID, data=b"PAR1 newest version PAR1")
    newer["prepared_at"] = "2026-02-01T00:00:00Z"
    cache = FakeCache()
    cache.put_bytes(sha256_digest(DATA), DATA)
    cache.put_manifest(POSTED_ID, older_version, LONG, older)
    cache.put_manifest(POSTED_ID, NARROWED_CV, LONG, newer)
    monkeypatch.setenv("DFO_OFFLINE", "1")
    server = Server()
    async with make(server) as transport:
        built = await fetch(transport, spec(SENTENCE), cache=cache)
    assert built.members[0].content_version == older_version
    assert server.requests == []


async def test_offline_a_spec_falls_back_when_its_newest_file_is_damaged(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    older_version = "cv_" + "1" * 32
    older = manifest(POSTED_ID, older_version)
    older["prepared_at"] = "2026-01-01T00:00:00Z"
    newest_data = b"PAR1 newest version PAR1"
    newer = manifest(POSTED_ID, data=newest_data)
    newer["prepared_at"] = "2026-02-01T00:00:00Z"
    cache = Cache(tmp_path, env={})
    cache.put_bytes(sha256_digest(DATA), DATA)
    cache.put_manifest(POSTED_ID, older_version, LONG, older)
    newest_digest = sha256_digest(newest_data)
    cache.put_bytes(newest_digest, newest_data)
    cache.put_manifest(POSTED_ID, NARROWED_CV, LONG, newer)
    (cache.directory / file_entry(newest_digest)).write_bytes(b"damaged")
    monkeypatch.setenv("DFO_OFFLINE", "1")
    server = Server()
    async with make(server) as transport:
        built = await fetch(transport, spec(SENTENCE), cache=cache)
    assert built.members[0].content_version == older_version
    assert server.requests == []


async def test_offline_refuses_every_request_before_it_is_sent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DFO_OFFLINE", "1")
    server = Server()
    async with make(server) as transport:
        for call in (
            lambda: transport.request("POST", "/search/resolve", json={}),
            lambda: transport.download(SIGNED),
        ):
            with pytest.raises(NetworkError) as caught:
                await call()
            assert caught.value.code == "offline"
            assert "Signature" not in str(caught.value)
    assert server.requests == []


async def test_a_ref_reads_its_version_through_the_snapshot_and_files_routes() -> None:
    body = manifest()
    server = Server(json_response(200, body), redirect(), parquet())
    member = ref_member()
    async with make(server) as transport:
        built = await fetch(transport, DatasetRef((member,)))
    assert server.calls() == [
        f"GET {BASE}/datasets/{NARROWED_ID}/{NARROWED_CV}",
        f"GET {files_path(body)}",
        f"GET {SIGNED.split('?')[0]}",
    ]
    (fetched,) = built.members
    assert (fetched.parts, fetched.sentence, fetched.digest) == (
        member.parts,
        SENTENCE,
        member.digest,
    )
    assert built.stale is False


async def test_a_ref_with_an_unknown_version_raises_at_the_snapshot() -> None:
    server = Server(problem(404, "snapshot_not_found"))
    async with make(server) as transport:
        with pytest.raises(NotFoundError) as caught:
            await fetch(transport, DatasetRef((ref_member("cv_" + "0" * 32),)))
    assert caught.value.code == "snapshot_not_found"
    assert len(server.requests) == 1


# The selector renders a version with the options it was minted with, so a cut
# ref asks it for format and bundle alone.
@pytest.mark.parametrize(("rendering", "data"), [(LONG, DATA), (CUT, CUT_DATA)])
async def test_an_expired_file_is_rendered_again_by_the_file_selector(
    rendering: Rendering, data: bytes
) -> None:
    body = with_cut(manifest())
    server = Server(
        json_response(200, body),
        problem(410, "artifact_expired"),
        redirect(),
        parquet(data),
    )
    member = ref_member(data=data, rendering=rendering)
    async with make(server) as transport:
        built = await fetch(transport, DatasetRef((member,)))
    selector = server.requests[2]
    assert str(selector.url.copy_with(query=None)) == (
        f"{BASE}/datasets/{NARROWED_ID}/{NARROWED_CV}/file"
    )
    assert dict(selector.url.params) == {"format": "parquet", "bundle": "false"}
    assert built.members[0].digest == sha256_digest(data)


@pytest.mark.parametrize(
    ("rendering", "data", "options"),
    [
        (LONG, DATA, {"format": "parquet", "bundle": False}),
        (
            CUT,
            CUT_DATA,
            {"format": "parquet", "bundle": False, "without_party_totals": True},
        ),
    ],
)
async def test_an_expired_file_without_the_selector_rebuilds_the_same_version(
    rendering: Rendering, data: bytes, options: dict
) -> None:
    body = with_cut(manifest())
    server = Server(
        json_response(200, body),
        problem(410, "artifact_expired"),
        problem(404, "not_found"),
        json_response(200, body),
        redirect(),
        parquet(data),
    )
    member = ref_member(data=data, rendering=rendering)
    async with make(server) as transport:
        built = await fetch(transport, DatasetRef((member,)))
    rebuild = server.body(3)
    assert rebuild["input"]["spec_id"] == NARROWED_ID
    assert "scope" not in rebuild["input"]
    assert rebuild["options"] == options
    (fetched,) = built.members
    assert (fetched.content_version, fetched.digest) == (NARROWED_CV, member.digest)
    assert fetched.rendering == rendering
    assert fetched.sentence == SENTENCE
    assert len(server.requests) == 6


# The client's own warning, so `strict`, which raises the server's warnings,
# leaves it a warning.
@pytest.mark.parametrize("strict", [False, True])
async def test_a_rebuild_whose_file_has_another_digest_warns_naming_both(
    strict: bool,
) -> None:
    member = ref_member(data=b"PAR1 bytes another writer wrote PAR1")
    body = manifest()
    server = Server(
        json_response(200, body),
        problem(404, "not_found"),
        json_response(200, body),
        redirect(),
        parquet(),
    )
    served = sha256_digest(DATA)
    async with make(server) as transport:
        with pytest.warns(DfoWarning) as caught:
            built = await fetch(transport, DatasetRef((member,)), strict=strict)
    (record,) = caught
    warning = record.message
    assert type(warning) is DfoWarning
    assert built.members[0].digest == served
    assert warning.code == "ref_digest_changed"
    assert member.digest in str(warning)
    assert served in str(warning)
    assert server.calls()[1] == f"GET {BASE}/datasets/{NARROWED_ID}/{NARROWED_CV}/file"


async def test_a_rebuild_with_another_version_names_the_newest() -> None:
    newer = "cv_" + "1" * 32
    server = Server(
        json_response(200, manifest()),
        problem(410, "artifact_expired"),
        problem(404, "not_found"),
        json_response(200, manifest(content_version=newer)),
    )
    async with make(server) as transport:
        with pytest.raises(VersionUnavailableError, match=newer) as caught:
            await fetch(transport, DatasetRef((ref_member(),)))
    assert caught.value.code == "artifact_expired"
    assert caught.value.newest_version == newer
    assert len(server.requests) == 4


OLDER, NEWER = "cv_" + "1" * 32, "cv_" + "2" * 32


def plain(content_version: str) -> dict:
    return {
        "content_version": content_version,
        "base_content_version": None,
        "rendering": "plain",
    }


def derived(content_version: str, base: str) -> dict:
    return {
        "content_version": content_version,
        "base_content_version": base,
        "rendering": "groupby",
    }


def cut(content_version: str, base: str) -> dict:
    return {
        "content_version": content_version,
        "base_content_version": base,
        "rendering": "without_party_totals",
        "without_party_totals": True,
    }


def versions_page(versions: list, next_cursor: object = None) -> httpx2.Response:
    return json_response(
        200,
        {
            "spec_id": NARROWED_ID,
            "versions": versions,
            "next_cursor": next_cursor,
            "complete": next_cursor is None,
        },
    )


async def versions_lookup(
    *pages: httpx2.Response, rendering: Rendering = LONG, caller: str = "client"
) -> tuple[Server, Exception]:
    """A ref whose build is refused, so the lookup reads the versions `pages`."""
    member = ref_member(rendering=rendering)
    body = manifest()
    body["artifacts"][1]["rendering"].update(rendering.to_object())
    server = Server(
        json_response(200, body),
        problem(410, "artifact_expired"),
        problem(404, "not_found"),
        problem(422, "definition_not_reproducible"),
        *pages,
    )
    async with make(server, caller=caller) as transport:
        with pytest.raises(DfoError) as caught:
            await fetch(transport, DatasetRef((member,)))
    return server, caught.value


# A page that lists only groupby versions, each naming the next page.
ENDLESS = [versions_page([derived(NEWER, OLDER)], f"c{page}") for page in range(20)]


# Each row gives the ref member's rendering, the responses the versions route
# answers in turn, the cursor each page after the first is asked with, and the
# newest version the error names. The last row reads `VERSIONS_PAGE_BUDGET` pages.
@pytest.mark.parametrize(
    ("rendering", "pages", "cursors", "named"),
    [
        (LONG, [versions_page([plain(NEWER)], "c1")], [], NEWER),
        (LONG, [versions_page([derived(NEWER, OLDER), plain(OLDER)])], [], OLDER),
        (LONG, [versions_page([cut(NEWER, OLDER), plain(OLDER)])], [], OLDER),
        (CUT, [versions_page([plain(NEWER), cut(OLDER, NEWER)])], [], OLDER),
        (CUT, [versions_page([plain(NEWER), derived(OLDER, NEWER)])], [], None),
        (
            LONG,
            [
                versions_page([derived(NEWER, OLDER)], "c/2"),
                versions_page([plain(OLDER)]),
            ],
            ["c/2"],
            OLDER,
        ),
        (LONG, [versions_page([derived(NEWER, OLDER)])], [], None),
        (LONG, [versions_page([])], [], None),
        (LONG, [problem(404, "not_found")], [], None),
        (LONG, ENDLESS, [f"c{page}" for page in range(19)], None),
    ],
    ids=[
        "plain",
        "derived-first",
        "cut-first",
        "cut-ref",
        "cut-ref-none",
        "second-page",
        "no-plain",
        "none",
        "not-found",
        "page-budget",
    ],
)
async def test_a_spec_that_cannot_rebuild_names_the_newest_stored_version(
    rendering: Rendering,
    pages: list[httpx2.Response],
    cursors: list[str],
    named: str | None,
) -> None:
    server, error = await versions_lookup(*pages, rendering=rendering)
    versions = f"GET {BASE}/datasets/{NARROWED_ID}/versions"
    assert server.calls()[4:] == [versions] * (1 + len(cursors))
    assert [dict(request.url.params) for request in server.requests[4:]] == [
        {"limit": "100"},
        *({"limit": "100", "cursor": cursor} for cursor in cursors),
    ]
    assert isinstance(error, VersionUnavailableError)
    assert error.code == "artifact_expired"
    assert error.newest_version == named


@pytest.mark.parametrize(
    ("listed", "names_latest"),
    [(NARROWED_CV, False), (NEWER, True), (None, True)],
    ids=["the-ref-version", "another-version", "none-listed"],
)
@CALLERS
async def test_the_unavailable_error_names_the_latest_fetch_unless_it_is_newest(
    listed: str | None, caller: str, *, names_latest: bool
) -> None:
    page = versions_page([plain(listed)] if listed is not None else [])
    _, error = await versions_lookup(page, caller=caller)
    assert isinstance(error, VersionUnavailableError)
    assert error.newest_version == listed
    assert (f"{caller}.fetch(ref, latest=True)" in str(error)) is names_latest
    assert listed is None or listed in str(error)


@pytest.mark.parametrize(
    ("pages", "pointer"),
    [
        ([json_response(200, {"spec_id": NARROWED_ID, "items": []})], "/versions"),
        ([versions_page([{}])], "/versions/0/content_version"),
        ([versions_page(["cv"])], "/versions/0/content_version"),
        ([versions_page([plain("cv_" + "A" * 32)])], "/versions/0/content_version"),
        ([versions_page([{"content_version": OLDER}])], "/versions/0/rendering"),
        (
            [versions_page([plain(NEWER), {**plain(OLDER), "rendering": None}])],
            "/versions/1/rendering",
        ),
        ([versions_page([derived(NEWER, OLDER)], 2)], "/next_cursor"),
        (
            [
                versions_page([derived(NEWER, OLDER)], "c1"),
                versions_page([derived(NEWER, OLDER)], "c2"),
                versions_page([derived(NEWER, OLDER)], "c1"),
            ],
            "/next_cursor",
        ),
        (
            [versions_page([derived(NEWER, OLDER)], "c1"), versions_page([{}])],
            "/versions/0/content_version",
        ),
    ],
)
async def test_a_versions_page_the_client_cannot_read_raises(
    pages: list[httpx2.Response], pointer: str
) -> None:
    _, error = await versions_lookup(*pages)
    assert isinstance(error, ContractError)
    assert (error.code, error.pointer) == ("contract_violation", pointer)


async def test_a_refused_versions_lookup_raises() -> None:
    server = Server(
        json_response(200, manifest()),
        problem(410, "artifact_expired"),
        problem(404, "not_found"),
        problem(422, "definition_not_reproducible"),
        problem(403, "publish_not_permitted"),
    )
    async with make(server) as transport:
        with pytest.raises(PermissionDeniedError) as caught:
            await fetch(transport, DatasetRef((ref_member(),)))
    assert caught.value.code == "publish_not_permitted"


async def test_a_cached_ref_needs_no_request_and_offline_marks_it_stale(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    body = manifest()
    cache = FakeCache()
    cache.put_bytes(sha256_digest(DATA), DATA)
    cache.put_manifest(NARROWED_ID, NARROWED_CV, LONG, body)
    server = Server()
    async with make(server) as transport:
        built = await fetch(
            transport, DatasetRef((ref_member(),)), entities={}, cache=cache
        )
        assert built.stale is False
        monkeypatch.setenv("DFO_OFFLINE", "1")
        offline = await fetch(transport, DatasetRef((ref_member(),)), cache=cache)
        assert offline.stale is True
        with pytest.raises(NetworkError, match="cache lacks"):
            await fetch(transport, DatasetRef((ref_member(),)), cache=FakeCache())
    assert server.requests == []
    assert offline.members[0].manifest == body


def _drop_member_artifact(body: dict) -> None:
    del body["artifacts"][1]


def _drop_definition(body: dict) -> None:
    del body["definition"]


def _other_version(body: dict) -> None:
    body["content_version"] = "cv_" + "0" * 32


@pytest.mark.parametrize(
    "tamper", [_drop_member_artifact, _drop_definition, _other_version]
)
async def test_a_tampered_cached_manifest_is_fetched_again_and_replaced(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, tamper
) -> None:
    body = manifest()
    cache = Cache(tmp_path, env={})
    cache.put_bytes(sha256_digest(DATA), DATA)
    cache.put_manifest(NARROWED_ID, NARROWED_CV, LONG, body)
    path = cache.directory / manifest_entry(NARROWED_ID, NARROWED_CV, LONG)
    tampered = copy.deepcopy(body)
    tamper(tampered)
    path.write_text(json.dumps(tampered))
    server = Server(json_response(200, body), redirect(), parquet())
    async with make(server) as transport:
        monkeypatch.setenv("DFO_OFFLINE", "1")
        with pytest.raises(NetworkError, match="cache lacks"):
            await fetch(transport, DatasetRef((ref_member(),)), cache=cache)
        monkeypatch.delenv("DFO_OFFLINE")
        built = await fetch(transport, DatasetRef((ref_member(),)), cache=cache)
    assert server.calls()[0] == f"GET {BASE}/datasets/{NARROWED_ID}/{NARROWED_CV}"
    assert built.members[0].manifest == body
    assert cache.get_manifest(NARROWED_ID, NARROWED_CV, LONG) is not None


@pytest.mark.parametrize(("rendering", "data"), [(LONG, DATA), (CUT, CUT_DATA)])
async def test_bytes_the_file_selector_served_are_a_cache_hit_online_and_offline(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, rendering: Rendering, data: bytes
) -> None:
    served = manifest(data=b"PAR1 a later rendering PAR1")
    cache = Cache(tmp_path, env={})
    server = Server(json_response(200, served), redirect(), parquet(data))
    member = ref_member(data=data, rendering=rendering)
    async with make(server) as transport:
        first = await fetch(transport, DatasetRef((member,)), cache=cache)
        again = await fetch(transport, DatasetRef((member,)), cache=cache)
        monkeypatch.setenv("DFO_OFFLINE", "1")
        offline = await fetch(transport, DatasetRef((member,)), cache=cache)
    assert len(server.requests) == 3
    assert server.requests[1].url.path.endswith(f"/{NARROWED_CV}/file")
    assert first.members[0].manifest == served
    assert again.members[0].digest == offline.members[0].digest == member.digest
    assert offline.stale is True


async def test_exact_refs_merge_projected_and_plain_artifacts_for_offline_spec(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    projected = b"PAR1 projected columns PAR1"
    retention = {"pinned": False, "held_until": "2026-11-19T13:59:18Z"}
    body = manifest(POSTED_ID, retention=retention)
    projected_digest = sha256_digest(projected)
    body["artifacts"].insert(
        1,
        {
            "artifact_digest": projected_digest,
            "rendering": {
                "format": "parquet",
                "bundle": False,
                "layout": 3,
                "columns": ["value"],
            },
            "url": f"/api/datasets/{POSTED_ID}/{NARROWED_CV}/files/{projected_digest}",
        },
    )
    projected_member = RefMember(
        parts=(),
        sentence=SENTENCE,
        spec=Spec(POSTED_ID, body["definition"], SENTENCE),
        content_version=NARROWED_CV,
        digest=projected_digest,
        rendering=LONG,
    )
    plain_member = RefMember(
        parts=(),
        sentence=SENTENCE,
        spec=Spec(POSTED_ID, body["definition"], SENTENCE),
        content_version=NARROWED_CV,
        digest=sha256_digest(DATA),
        rendering=LONG,
    )
    cache = FakeCache()
    server = Server(
        json_response(200, body),
        redirect(),
        parquet(projected),
        json_response(200, body),
        redirect(),
        parquet(),
    )
    async with make(server) as transport:
        restored = await fetch(transport, DatasetRef((projected_member,)), cache=cache)
        stored = cache.get_manifest(POSTED_ID, NARROWED_CV, LONG)
        assert stored is not None
        assert stored["artifacts"] == [body["artifacts"][1]]
        assert stored["warnings"] == body["warnings"]
        assert stored["retention"] == retention
        assert stored["prepared_at"] == body["prepared_at"]
        assert restored.members[0].data == projected

        restored = await fetch(transport, DatasetRef((plain_member,)), cache=cache)
        assert restored.members[0].data == DATA
        stored = cache.get_manifest(POSTED_ID, NARROWED_CV, LONG)
        assert stored is not None
        assert stored["artifacts"] == body["artifacts"][1:]

        monkeypatch.setenv("DFO_OFFLINE", "1")
        restored = await fetch(transport, DatasetRef((projected_member,)), cache=cache)
        assert restored.members[0].data == projected
        restored = await fetch(transport, DatasetRef((plain_member,)), cache=cache)
        assert restored.members[0].data == DATA
        restored = await fetch(
            transport,
            Spec(POSTED_ID, body["definition"], SENTENCE),
            cache=cache,
        )
    assert restored.members[0].data == DATA
    assert len(server.requests) == 6


async def test_same_version_projected_download_keeps_a_plain_cached_artifact(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    plain = manifest(POSTED_ID)
    plain["prepared_at"] = "2026-01-01T00:00:00Z"
    projected = b"PAR1 projected columns PAR1"
    later = manifest(POSTED_ID, retention={"pinned": True, "held_until": None})
    later["prepared_at"] = "2026-02-01T00:00:00Z"
    projected_digest = sha256_digest(projected)
    later["artifacts"].append(
        {
            "artifact_digest": projected_digest,
            "rendering": {
                "format": "parquet",
                "bundle": False,
                "layout": 3,
                "columns": ["value"],
            },
            "url": f"/api/datasets/{POSTED_ID}/{NARROWED_CV}/files/{projected_digest}",
        }
    )
    projected_member = RefMember(
        parts=(),
        sentence=SENTENCE,
        spec=Spec(POSTED_ID, later["definition"], SENTENCE),
        content_version=NARROWED_CV,
        digest=projected_digest,
        rendering=LONG,
    )
    cache = FakeCache()
    server = Server(
        json_response(200, plain),
        redirect(),
        parquet(),
        json_response(200, later),
        redirect(),
        parquet(projected),
    )
    async with make(server) as transport:
        await fetch(transport, spec(SENTENCE), cache=cache)
        await fetch(transport, DatasetRef((projected_member,)), cache=cache)
        stored = cache.get_manifest(POSTED_ID, NARROWED_CV, LONG)
        assert stored is not None
        assert stored["prepared_at"] == later["prepared_at"]
        assert stored["retention"] == later["retention"]
        assert stored["artifacts"] == [plain["artifacts"][1], later["artifacts"][2]]

        monkeypatch.setenv("DFO_OFFLINE", "1")
        restored = await fetch(transport, spec(SENTENCE), cache=cache)
    assert restored.members[0].data == DATA


async def test_same_bytes_under_two_renderings_keep_the_plain_offline_artifact(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    transformed = manifest(POSTED_ID)
    transformed["artifacts"][1]["rendering"]["without_party_totals"] = True
    plain = manifest(POSTED_ID)
    transformed_member = RefMember(
        parts=(),
        sentence=SENTENCE,
        spec=Spec(POSTED_ID, transformed["definition"], SENTENCE),
        content_version=NARROWED_CV,
        digest=sha256_digest(DATA),
        rendering=CUT,
    )
    cache = FakeCache()
    server = Server(
        json_response(200, transformed),
        redirect(),
        parquet(),
        json_response(200, plain),
    )
    async with make(server) as transport:
        await fetch(transport, DatasetRef((transformed_member,)), cache=cache)
        await fetch(transport, spec(SENTENCE), cache=cache)
        for rendering, body in ((CUT, transformed), (LONG, plain)):
            stored = cache.get_manifest(POSTED_ID, NARROWED_CV, rendering)
            assert stored is not None
            assert stored["artifacts"] == [body["artifacts"][1]]

        monkeypatch.setenv("DFO_OFFLINE", "1")
        restored = await fetch(transport, spec(SENTENCE), cache=cache)
    assert restored.members[0].data == DATA


async def test_a_ref_digest_listed_under_another_rendering_raises_before_download() -> (
    None
):
    cut_listing = manifest()
    cut_listing["artifacts"][1]["rendering"]["without_party_totals"] = True
    plain_member = ref_member(rendering=LONG)
    server = Server(json_response(200, cut_listing))
    async with make(server) as transport:
        with pytest.raises(FormatError) as caught:
            await fetch(transport, DatasetRef((plain_member,)))
    assert (caught.value.reason, caught.value.pointer) == (
        "format_invalid",
        "/members/0/artifact/rendering",
    )
    assert len(server.requests) == 1


async def test_plain_and_cut_files_of_one_version_share_a_manifest_and_stay_apart(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    body = with_cut(manifest(POSTED_ID))
    cache = Cache(tmp_path, env={})
    server = Server(
        json_response(200, body),
        redirect(),
        parquet(),
        json_response(200, body),
        redirect(),
        parquet(CUT_DATA),
    )
    async with make(server) as transport:
        plain = await fetch(transport, spec(SENTENCE), cache=cache)
        cut = await fetch(
            transport, spec(SENTENCE), without_party_totals=True, cache=cache
        )
        assert "without_party_totals" not in server.body(0)["options"]
        assert server.body(3)["options"]["without_party_totals"] is True
        assert (plain.members[0].data, cut.members[0].data) == (DATA, CUT_DATA)
        assert cut.members[0].rendering == CUT
        manifests = list((cache.directory / "manifests" / POSTED_ID).rglob("*.json"))
        assert [path.name for path in manifests] == ["parquet.json"]

        monkeypatch.setenv("DFO_OFFLINE", "1")
        plain = await fetch(transport, spec(SENTENCE), cache=cache)
        cut = await fetch(
            transport, spec(SENTENCE), without_party_totals=True, cache=cache
        )
    assert (plain.members[0].data, cut.members[0].data) == (DATA, CUT_DATA)
    assert len(server.requests) == 6


async def test_incomplete_metadata_artifact_stays_eligible_offline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    body = manifest(POSTED_ID)
    body["artifacts"][1]["rendering"]["metadata"] = "incomplete"
    cache = FakeCache()
    server = Server(json_response(200, body), redirect(), parquet())
    async with make(server) as transport:
        await fetch(transport, spec(SENTENCE), cache=cache)
        monkeypatch.setenv("DFO_OFFLINE", "1")
        restored = await fetch(transport, spec(SENTENCE), cache=cache)
    assert restored.members[0].data == DATA


@pytest.mark.parametrize(
    ("target", "options", "names"),
    [
        ("ref", {"window": "latest"}, "for the newest version use latest=True."),
        (
            "ref",
            {"window": "latest", "latest": True},
            '{caller}.fetch(ref.members[0].spec, window="latest").',
        ),
        (
            "ref",
            {"window": (2015, 2020)},
            "{caller}.fetch(ref.members[0].spec, window=(2015, 2020)).",
        ),
        (
            "ref",
            {"window": (2015, 2020), "latest": True},
            "{caller}.fetch(ref.members[0].spec, window=(2015, 2020)).",
        ),
        (
            "ref",
            {"entities": {"recipient": None}},
            "{caller}.fetch(ref.members[0].spec, entities=...)",
        ),
        ("ref", {"facets": {"unit": "USD"}}, "{caller}.fetch(ref.members[0].spec"),
        ("ref", {"latest": 1}, "not 1"),
        ("spec", {"latest": True}, "{caller}.fetch(spec)"),
        ("spec", {"latest": "yes"}, "not 'yes'"),
    ],
    ids=[
        "ref-window",
        "latest-ref-window",
        "ref-years",
        "latest-ref-years",
        "ref-entities",
        "ref-facets",
        "latest-not-a-bool",
        "latest-spec",
        "latest-spec-not-a-bool",
    ],
)
@CALLERS
async def test_a_refused_latest_or_ref_narrowing_names_the_call_to_run(
    target: str, options: dict, names: str, caller: str
) -> None:
    server = Server()
    fetched = DatasetRef((ref_member(),)) if target == "ref" else spec(SENTENCE)
    async with make(server, caller=caller) as transport:
        with pytest.raises(InvalidRequestError) as raised:
            await fetch(transport, fetched, **options)
    assert raised.value.code == "invalid_argument"
    assert names.format(caller=caller) in str(raised.value)
    assert server.requests == []


@pytest.mark.parametrize("rendering", [LONG, CUT], ids=["long", "cut"])
async def test_a_latest_ref_fetch_builds_each_spec_in_the_refs_rendering(
    rendering: Rendering,
) -> None:
    held = ref_member(rendering=rendering)
    body = with_cut(manifest(content_version=NEWER))
    server = Server(
        json_response(200, body),
        redirect(),
        parquet(CUT_DATA if rendering == CUT else DATA),
    )
    async with make(server) as transport:
        built = await fetch(transport, DatasetRef((held,)), latest=True)
    assert server.calls()[0] == f"POST {BASE}/datasets"
    options = server.body(0)["options"]
    assert options.get("without_party_totals", False) is rendering.without_party_totals
    (member,) = built.members
    assert (member.parts, member.content_version) == (held.parts, NEWER)
    assert (member.spec.spec_id, member.rendering) == (NARROWED_ID, rendering)
    assert built.complete


@CALLERS
async def test_a_latest_fetch_refuses_a_ref_of_mixed_renderings(caller: str) -> None:
    other = Spec(POSTED_ID, posted_spec()["definition"], SENTENCE)
    mixed = DatasetRef(
        (
            ref_member(),
            RefMember(
                parts=("another part",),
                sentence=SENTENCE,
                spec=other,
                content_version=NARROWED_CV,
                digest=sha256_digest(CUT_DATA),
                rendering=CUT,
            ),
        )
    )
    server = Server()
    async with make(server, caller=caller) as transport:
        with pytest.raises(InvalidRequestError) as raised:
            await fetch(transport, mixed, latest=True)
    assert raised.value.code == "invalid_argument"
    assert f"{caller}.fetch(ref.members[1].spec" in str(raised.value)
    assert "without_party_totals=True" in str(raised.value)
    assert server.requests == []


async def test_a_ref_keeps_its_layout() -> None:
    ref = DatasetRef((ref_member(),))
    server = Server()
    async with make(server) as transport:
        with pytest.raises(InvalidRequestError, match="long layout"):
            await fetch(transport, ref, layout="frame")
        with pytest.raises(InvalidRequestError, match="without_party_totals=False"):
            await fetch(transport, ref, without_party_totals=True)
        cut_ref = DatasetRef((ref_member(rendering=CUT),))
        with pytest.raises(InvalidRequestError, match="without_party_totals=True"):
            await fetch(transport, cut_ref, without_party_totals=False)
        bundled = RefMember(
            parts=(),
            sentence=SENTENCE,
            spec=ref_member().spec,
            content_version=NARROWED_CV,
            digest=sha256_digest(DATA),
            rendering=Rendering("csv", True),
        )
        with pytest.raises(InvalidRequestError, match="bare Parquet"):
            await fetch(transport, DatasetRef((bundled,)))
    assert server.requests == []


async def test_a_snapshot_for_another_version_raises() -> None:
    server = Server(json_response(200, manifest(content_version="cv_" + "3" * 32)))
    async with make(server) as transport:
        with pytest.raises(ContractError, match="answered"):
            await fetch(transport, DatasetRef((ref_member(),)))


async def test_a_manifest_without_a_strict_field_raises_before_downloading() -> None:
    body = manifest(POSTED_ID)
    body["contentVersion"] = body.pop("content_version")
    server = Server(json_response(200, body))
    async with make(server) as transport:
        with pytest.raises(ContractError, match="content_version"):
            await fetch(transport, spec(SENTENCE))
    assert len(server.requests) == 1


async def test_the_files_route_resolves_against_the_origin_under_any_base_path() -> (
    None
):
    body = manifest(POSTED_ID)
    server = Server(json_response(200, body), redirect(), parquet())
    async with make(server, base_url=ORIGIN + "/proxy/api/v1") as transport:
        await fetch(transport, spec(SENTENCE))
    assert str(server.requests[0].url) == ORIGIN + "/proxy/api/v1/datasets"
    assert str(server.requests[1].url) == files_path(body)
    assert json.loads(server.requests[0].content)["input"]["kind"] == "spec_id"
