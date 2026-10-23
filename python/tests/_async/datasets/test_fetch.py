"""Tests for fetching: spec builds, narrowing, sentences, downloads and stored versions.

`scripts/gen_sync.py` derives `tests/_sync/datasets/test_fetch.py` from this file,
so the sync client passes the same tests.
"""

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
    DfoTimeoutError,
    InvalidRequestError,
    NetworkError,
    NotFoundError,
    PermissionDeniedError,
    ServerError,
    VersionUnavailableError,
)
from dfo._core.parse import parse_spec
from dfo._core.refs import DatasetRef, RefMember
from dfo._core.types import Rendering, Spec
from dfo._datasets.build import Reading
from dfo._datasets.cache import Cache, file_entry, sha256_digest
from dfo._datasets.fetch import fetch_members
from dfo._datasets.resolve import fetch
from dfo._http.transport import AsyncTransport
from tests._fetch_support import (
    BASE,
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


def spec(sentence: str | None = None) -> Spec:
    return Spec(
        parse_spec(posted_spec()).spec_id, posted_spec()["definition"], sentence
    )


def ref_member(content_version: str = NARROWED_CV, data: bytes = DATA) -> RefMember:
    body = manifest()
    return RefMember(
        parts=("ODA disbursements for basic health care",),
        sentence=SENTENCE,
        spec=Spec(NARROWED_ID, body["definition"], SENTENCE),
        content_version=content_version,
        digest=sha256_digest(data),
        rendering=LONG,
    )


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


async def test_strict_raises_a_dataset_warning_before_downloading() -> None:
    warning = {"code": "coverage_below_scope", "severity": "warn", "message": "short"}
    info = {"code": "processing_level_undeclared", "severity": "info", "message": "x"}
    server = Server(json_response(200, manifest(POSTED_ID, warnings=[info, warning])))
    async with make(server) as transport:
        with pytest.raises(DataWarning) as caught:
            await fetch(transport, spec(SENTENCE), strict=True)
    assert caught.value.code == "coverage_below_scope"
    assert len(server.requests) == 1


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
    [("location", ELSEWHERE), ("artifact", ELSEWHERE), ("artifact", SIGNED)],
    ids=["location-elsewhere", "artifact-elsewhere", "artifact-on-storage-host"],
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
        (httpx2.ReadTimeout("slow"), DfoTimeoutError, "deadline_exceeded"),
    ],
    ids=["refused", "no-content", "network", "timeout"],
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


async def test_an_expired_file_is_rendered_again_by_the_file_selector() -> None:
    body = manifest()
    server = Server(
        json_response(200, body),
        problem(410, "artifact_expired"),
        redirect(),
        parquet(),
    )
    async with make(server) as transport:
        built = await fetch(transport, DatasetRef((ref_member(),)))
    selector = server.requests[2]
    assert str(selector.url.copy_with(query=None)) == (
        f"{BASE}/datasets/{NARROWED_ID}/{NARROWED_CV}/file"
    )
    assert dict(selector.url.params) == {"format": "parquet", "bundle": "false"}
    assert built.members[0].digest == sha256_digest(DATA)


async def test_an_expired_file_without_the_selector_rebuilds_the_same_version() -> None:
    body = manifest()
    server = Server(
        json_response(200, body),
        problem(410, "artifact_expired"),
        problem(404, "not_found"),
        json_response(200, body),
        redirect(),
        parquet(),
    )
    async with make(server) as transport:
        built = await fetch(transport, DatasetRef((ref_member(),)))
    rebuild = server.body(3)
    assert rebuild["input"]["spec_id"] == NARROWED_ID
    assert "scope" not in rebuild["input"]
    assert built.members[0].content_version == NARROWED_CV
    assert built.members[0].sentence == SENTENCE
    assert len(server.requests) == 6


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


@pytest.mark.parametrize(
    ("versions", "named"),
    [
        (
            json_response(
                200,
                {
                    "spec_id": NARROWED_ID,
                    "versions": [{"content_version": "cv_" + "2" * 32}],
                    "next_cursor": "c1",
                    "complete": False,
                },
            ),
            "cv_" + "2" * 32,
        ),
        (problem(404, "not_found"), None),
        (
            json_response(
                200,
                {
                    "spec_id": NARROWED_ID,
                    "versions": [],
                    "next_cursor": None,
                    "complete": True,
                },
            ),
            None,
        ),
    ],
)
async def test_a_spec_that_cannot_rebuild_names_the_newest_stored_version(
    versions: httpx2.Response, named: str | None
) -> None:
    server = Server(
        json_response(200, manifest()),
        problem(410, "artifact_expired"),
        problem(404, "not_found"),
        problem(422, "definition_not_reproducible"),
        versions,
    )
    async with make(server) as transport:
        with pytest.raises(VersionUnavailableError) as caught:
            await fetch(transport, DatasetRef((ref_member(),)))
    assert server.calls()[-1] == f"GET {BASE}/datasets/{NARROWED_ID}/versions"
    assert dict(server.requests[-1].url.params) == {"limit": "1"}
    assert caught.value.code == "artifact_expired"
    assert caught.value.newest_version == named


@pytest.mark.parametrize(
    ("page", "pointer"),
    [
        ({"spec_id": NARROWED_ID, "items": []}, "/versions"),
        ({"spec_id": NARROWED_ID, "versions": [{}]}, "/versions/0/content_version"),
        ({"spec_id": NARROWED_ID, "versions": ["cv"]}, "/versions/0/content_version"),
    ],
)
async def test_a_versions_page_the_client_cannot_read_raises(
    page: dict, pointer: str
) -> None:
    server = Server(
        json_response(200, manifest()),
        problem(410, "artifact_expired"),
        problem(404, "not_found"),
        problem(422, "definition_not_reproducible"),
        json_response(200, page),
    )
    async with make(server) as transport:
        with pytest.raises(ContractError) as caught:
            await fetch(transport, DatasetRef((ref_member(),)))
    assert (caught.value.code, caught.value.pointer) == ("contract_violation", pointer)


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
        rendering=LONG,
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
        stored = cache.get_manifest(POSTED_ID, NARROWED_CV, LONG)
        assert stored is not None
        assert stored["artifacts"] == [
            transformed["artifacts"][1],
            plain["artifacts"][1],
        ]

        monkeypatch.setenv("DFO_OFFLINE", "1")
        restored = await fetch(transport, spec(SENTENCE), cache=cache)
    assert restored.members[0].data == DATA


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


async def test_a_ref_takes_no_narrowing_and_keeps_its_layout() -> None:
    ref = DatasetRef((ref_member(),))
    server = Server()
    async with make(server) as transport:
        with pytest.raises(InvalidRequestError, match="no narrowing"):
            await fetch(transport, ref, window="latest")
        with pytest.raises(InvalidRequestError, match="long layout"):
            await fetch(transport, ref, layout="frame")
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
