"""The dashboard journey against the dfo-apis local stack at `DFO_BASE_URL`.

Marked `live` and deselected by default. `scripts/local-stack-journeys.sh` in
the repository root brings the stack up, seeds it, runs this module, and brings
the stack down; `both` in place of `python` also runs the TypeScript journey
and then this module's crossing test, which reads the ref that journey wrote:

    DFO_APIS_DIR=/path/to/dfo-apis scripts/local-stack-journeys.sh python

or by hand, with the stack up and seeded (`just local-stack up` and
`just local-stack seed` in dfo-apis):

    cd python
    DFO_BASE_URL=http://127.0.0.1:58083/api uv run pytest -m live \\
        tests/e2e/test_local_stack.py

The journey divides German ODA by Kenya's population on DFO, checks the derived
Dataset's rows, ref, file and repr, reads it back under `latest`, saves and
loads it, draws a line and a stat card of it, and walks a live share from create
to unshare. The stack seeds four readings; the ids below are those its README
lists, and a change to its fixture changes them.

The local stack has no Search, so each seeded spec carries its sentence, and its
download links point at the storage emulator, which the client refuses as a
host other than the API and Google Cloud Storage. `Shim` moves those links onto
the API's origin and forwards them to the emulator, and records every request.

`DFO_E2E_DIR` names a directory shared with the TypeScript journey: the module
writes `derived-python.json` there and reads `derived-typescript.json` when the
TypeScript journey has written it. Without it the files go to a temporary
directory and the crossing test skips.
"""

import hashlib
import json
import os
from collections.abc import Iterator, Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, override

import httpx2
import pytest

import dfo
from dfo import Client, Dataset, DatasetRef, Spec
from dfo._sync._datasets.fetch import Session
from dfo._sync._http.transport import Transport
from dfo.errors import InvalidRequestError, NotFoundError, PermissionDeniedError
from dfo.types import Card, DerivedRefMember, Share

pytestmark = [
    pytest.mark.live,
    pytest.mark.filterwarnings("ignore::dfo.errors.SeriesLeftOutWarning"),
]

ODA = (
    "spec_7f535e528a2a527aa54b316d4eccbb6e",
    "cv_46e66114368dacdffa282c61ee456e0f",
    "ODA from Germany to Kenya, Ghana and Nigeria, 2018 to 2023",
)
POPULATION = (
    "spec_429926a07022f78c65e0379e8004ae6d",
    "cv_3f610869372f93965119e3c0221847f6",
    "Kenya population, 2015 to 2024",
)
GNI = (
    "spec_fb3e3180bb4bac8acb968f3b6fccc6dd",
    "cv_96556e3d3e312acb219d633392cd1d05",
    "Kenya GNI (PPP), 2015 to 2024",
)
PAIRING = {"destination": "place"}
SHARES = "/presentation/shares"
WRONG_TOKEN = "shw_" + "0" * 22
# Where `Shim` moves a download link that points off the API's origin.
MOVED = "/__moved__"
ROW_COLUMNS = ("time_period", "financingRecipient", "value")


class Shim(httpx2.BaseTransport):
    """An HTTP transport that records every request, moves download links off
    the API's origin onto it, and can lose the reply to the next share create.

    The local stack redirects a files route to its storage emulator. The link
    is rewritten to `<api origin>/__moved__<path>`, and a request there goes to
    the emulator, so the client reads it as a download from the API.
    """

    def __init__(self, api_origin: str) -> None:
        self.inner = httpx2.HTTPTransport()
        self.api_origin = api_origin
        self.moved_origin: str | None = None
        self.sent: list[tuple[str, str, Any]] = []
        self.lose_next_share_reply = False
        self.lost_reply: Mapping[str, Any] | None = None

    @override
    def handle_request(self, request: httpx2.Request) -> httpx2.Response:
        if request.url.path.startswith(MOVED):
            assert self.moved_origin is not None
            moved = str(request.url).removeprefix(self.api_origin + MOVED)
            request = httpx2.Request("GET", self.moved_origin + moved)
        body = json.loads(request.content) if request.content else None
        self.sent.append((request.method, request.url.path, body))
        response = self.inner.handle_request(request)
        if (
            self.lose_next_share_reply
            and request.method == "POST"
            and request.url.path.endswith(SHARES)
        ):
            self.lose_next_share_reply = False
            response.read()
            self.lost_reply = response.json()
            response.close()
            raise httpx2.ReadError("the reply was lost in transit", request=request)
        location = response.headers.get("location", "")
        if location and not location.startswith(self.api_origin):
            origin = httpx2.URL(location)
            self.moved_origin = f"{origin.scheme}://{origin.netloc.decode()}"
            moved = location.removeprefix(self.moved_origin)
            response.headers["location"] = self.api_origin + MOVED + moved
        return response

    @override
    def close(self) -> None:
        self.inner.close()


@pytest.fixture(scope="module")
def base_url() -> str:
    url = os.environ.get("DFO_BASE_URL")
    if not url:
        pytest.fail("DFO_BASE_URL is unset; point it at the local stack's /api")
    return url


@pytest.fixture(scope="module")
def shim(base_url: str) -> Shim:
    url = httpx2.URL(base_url)
    return Shim(f"{url.scheme}://{url.netloc.decode()}")


@pytest.fixture(scope="module")
def client(base_url: str, shim: Shim) -> Iterator[Client]:
    # A direct call names its caller from the rightmost X-Forwarded-For entry,
    # which Cloud Run appends in production.
    transport = Transport(
        base_url=base_url,
        api_key=False,
        headers={"X-Forwarded-For": "127.0.0.1"},
        http_transport=shim,
    )
    with Client._over(Session(transport, None)) as client:
        yield client


@pytest.fixture(autouse=True)
def online(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DFO_OFFLINE", raising=False)
    monkeypatch.setenv("DFO_PROGRESS", "0")


@pytest.fixture(scope="module")
def e2e_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    given = os.environ.get("DFO_E2E_DIR")
    path = Path(given) if given else tmp_path_factory.mktemp("e2e")
    path.mkdir(parents=True, exist_ok=True)
    return path


def _seeded(client: Client, reading: tuple[str, str, str]) -> Dataset:
    spec_id, content_version, sentence = reading
    manifest = client.request("GET", f"/datasets/{spec_id}/{content_version}").json()
    data = client.fetch(Spec(spec_id, manifest["definition"], sentence=sentence))
    (member,) = data.members
    assert (member.spec.spec_id, member.content_version) == (spec_id, content_version)
    return data


@pytest.fixture(scope="module")
def oda(client: Client) -> Dataset:
    return _seeded(client, ODA)


@pytest.fixture(scope="module")
def population(client: Client) -> Dataset:
    return _seeded(client, POPULATION)


@pytest.fixture(scope="module")
def quotient(client: Client, oda: Dataset, population: Dataset) -> Dataset:
    return client.analysis.quotient_of(oda, population, on=PAIRING)


@pytest.fixture(scope="module")
def cards(client: Client, quotient: Dataset) -> tuple[Card, Card]:
    line = client.cards.line(quotient, title="Aid per person")
    stat = client.cards.stat(quotient, year=2023, compare_to=2018, change="percent")
    return line, stat


@pytest.fixture(scope="module")
def share(client: Client, cards: tuple[Card, Card]) -> Share:
    return client.share(list(cards), latest=True)


def _rows(data: Dataset) -> list[dict[str, Any]]:
    return data.to_arrow().select(ROW_COLUMNS).to_pylist()


def _derived(data: Dataset) -> tuple[str, str]:
    (member,) = data.ref.members
    return member.spec.spec_id, member.content_version


def _without_ids(value: object) -> object:
    """A card payload without what differs between two creates of one intent."""
    if isinstance(value, Mapping):
        return {
            key: _without_ids(item)
            for key, item in value.items()
            if key not in {"component_id", "generated_at"}
        }
    if isinstance(value, list):
        return [_without_ids(item) for item in value]
    return value


def _payload(client: Client, card_id: str) -> Mapping[str, Any]:
    return client.request("GET", f"/presentation/components/{card_id}").json()[
        "resolved_payload"
    ]


def test_01_quotient_of_answers_the_fixture_quotients(
    oda: Dataset, population: Dataset, quotient: Dataset
) -> None:
    # A derived frame names its years as text, a dataset's long layout as numbers.
    people = {
        str(row["time_period"]): row["value"]
        for row in population.to_arrow().to_pylist()
    }
    expected = [
        {
            "time_period": str(row["time_period"]),
            "financingRecipient": "country/KEN",
            "value": pytest.approx(row["value"] / people[str(row["time_period"])]),
        }
        for row in oda.to_arrow().to_pylist()
        if row["financingRecipient"] == "country/KEN"
        and str(row["time_period"]) in people
    ]
    assert len(expected) == 6
    assert sorted(_rows(quotient), key=lambda row: row["time_period"]) == expected
    assert {(series.reason, series.side) for series in quotient.left_out} == {
        ("unmatched_key", "data"),
        ("period_unmatched", "other"),
    }
    assert len(quotient.left_out) == 3


def test_02_derived_ref_file_and_repr(
    client: Client, oda: Dataset, population: Dataset, quotient: Dataset
) -> None:
    ref = json.loads(quotient.ref.to_json())
    assert ref["format_version"] == 2
    (member,) = quotient.ref.members
    assert isinstance(member, DerivedRefMember)
    spec_id, content_version = _derived(quotient)
    assert spec_id.startswith("ops_")
    assert content_version.startswith("ocv_")
    assert [(root.spec_id, root.content_version) for root in member.roots] == [
        (ODA[0], ODA[1]),
        (POPULATION[0], POPULATION[1]),
    ]
    assert DatasetRef.from_json(quotient.ref.to_json()) == quotient.ref

    path = f"/datasets/derived/{spec_id}/{content_version}/file"
    params = {"format": "parquet", "bundle": "false", "layout": "frame"}
    body = client.request("GET", path, params=params).content
    assert "sha256:" + hashlib.sha256(body).hexdigest() == member.digest

    lines = repr(quotient).splitlines()
    assert lines[0] == "<Dataset Computed by DFO: quotient_of."
    assert "  Derived: quotient_of by destination, from 2 readings" in lines
    assert "  Missing data: 3 series left out · data.left_out" in lines
    assert any(
        line.startswith(f"  Version: {content_version} (exact)") for line in lines
    )
    assert '  Rows: 6, time_period as text, such as "2022" or "2021/2022"' in lines


def test_03_a_two_step_recipe_gives_the_same_rows(
    client: Client, oda: Dataset, population: Dataset, quotient: Dataset
) -> None:
    chain = (
        dfo.analysis.recipe(oda)
        .filter(keep={"destination": "country/KEN"})
        .quotient_of(population, on=PAIRING)
    )
    data = client.fetch(chain)
    assert (
        repr(data).splitlines()[0]
        == "<Dataset Computed by DFO: filter, then quotient_of."
    )
    assert _derived(data) != _derived(quotient)
    assert _rows(data) == _rows(quotient)
    assert data.ref.same_data(quotient.ref)


def test_04_latest_answers_the_same_frame(client: Client, quotient: Dataset) -> None:
    again = client.fetch(quotient.ref, latest=True)
    assert _derived(again) == _derived(quotient)
    assert _rows(again) == _rows(quotient)


def test_05_save_and_load_round_trip(quotient: Dataset, tmp_path: Path) -> None:
    path = tmp_path / "quotient.parquet"
    quotient.save(path)
    loaded = dfo.load(path)
    assert loaded.ref == quotient.ref
    assert _rows(loaded) == _rows(quotient)
    assert loaded.left_out == quotient.left_out


def test_06_cards_draw_the_derived_frame(
    client: Client, quotient: Dataset, cards: tuple[Card, Card]
) -> None:
    line, stat = cards
    assert (line.kind, line.title, line.revision) == ("line", "Aid per person", 1)
    assert stat.kind == "stat"
    assert line.ref == stat.ref == quotient.ref
    spec_id, content_version = _derived(quotient)
    manifest = client.request(
        "GET", f"/datasets/derived/{spec_id}/{content_version}"
    ).json()
    roots = sorted(root["spec_id"] for root in manifest["roots"])
    assert roots == sorted([ODA[0], POPULATION[0]])
    for card in cards:
        payload = _payload(client, card.id)
        described = payload["description"]["sources"]
        # The description names the root readings the card draws, one source each.
        assert sorted(source["ref"] for source in described) == roots
        assert all(source["label"] for source in described)
        provenance = payload["provenance"]
        assert provenance["inputs"] == [
            {"spec_id": spec_id, "content_version": content_version}
        ]


def test_07_share_fetch_replace_snapshot_history(
    client: Client, quotient: Dataset, cards: tuple[Card, Card], share: Share
) -> None:
    site = share.url.removesuffix(f"/s/{share.id}")
    assert share.embed_url == f"{site}/embed/{share.id}"
    assert share.data_urls == tuple(
        f"{site}/api/v1/presentation/shares/{share.id}/slots/{slot}/data"
        for slot in (1, 2)
    )
    assert (share.latest, share.revision) == (True, 1)
    assert share.write_token is not None
    assert share.write_token.startswith("shw_")

    today = datetime.now(UTC).date()
    shown = client.fetch(share, slot=1)
    assert _rows(shown) == _rows(quotient)
    assert shown.ref.same_data(quotient.ref)
    day = f"{today.day} {today:%B %Y}"
    assert f'  Shown by: share {share.id}, slot 1 "Aid per person", on {day}' in (
        repr(shown).splitlines()
    )

    line, stat = cards
    replaced = client.share([stat, line], latest=True, replace=share)
    assert (replaced.id, replaced.revision, replaced.url) == (share.id, 2, share.url)
    with pytest.raises(PermissionDeniedError) as caught:
        client.share(line, latest=True, replace=share.url, write_token=WRONG_TOKEN)
    assert caught.value.code == "write_token_invalid"

    fixed = client.snapshot(share)
    assert (fixed.id, fixed.latest, fixed.url) == (share.id, False, share.url)

    served = client.history(share)
    assert {entry.slot for entry in served} >= {1}
    assert all(entry.fetchable for entry in served)
    assert {(entry.spec_id, entry.content_version) for entry in served} == {
        _derived(quotient)
    }
    then = client.fetch(share, slot=1, as_of=today)
    assert _rows(then) == _rows(quotient)


def test_08_a_retried_create_answers_the_first_share(
    client: Client, shim: Shim, cards: tuple[Card, Card]
) -> None:
    line, _ = cards
    before = len(shim.sent)
    shim.lose_next_share_reply = True
    share = client.share(line, latest=True)
    creates = [
        body
        for method, path, body in shim.sent[before:]
        if method == "POST" and path.endswith(SHARES)
    ]
    assert len(creates) == 2
    assert creates[0] == creates[1]
    assert shim.lost_reply is not None
    assert share.id == shim.lost_reply["id"]
    assert share.write_token == creates[0]["write_token"]
    client.unshare(share)


def test_09_unshare_then_fetch_is_not_found(client: Client, share: Share) -> None:
    client.unshare(share)
    with pytest.raises(NotFoundError) as caught:
        client.fetch(share, slot=1)
    assert caught.value.code == "not_found"


def test_10_pin_refuses_a_derived_frame_and_pins_a_version(
    client: Client, shim: Shim, oda: Dataset, quotient: Dataset
) -> None:
    before = len(shim.sent)
    with pytest.raises(InvalidRequestError) as caught:
        client.pin(quotient)
    assert caught.value.code == "invalid_argument"
    assert len(shim.sent) == before

    pinned = client.pin(oda)
    assert pinned.pinned
    assert pinned.ref == oda.ref


def test_11_card_variables_are_a_set(client: Client, population: Dataset) -> None:
    """Two creates of one table intent whose variables come in either order draw
    the same table. Each SDK lists a frame's variables in its own read order."""
    joined = client.analysis.join(population, _seeded(client, GNI), on="place")
    spec_id, content_version = _derived(joined)
    variables = sorted(set(joined.to_arrow().column("stat_var").to_pylist()))
    assert len(variables) == 2
    payloads = []
    for order in (variables, variables[::-1]):
        intent = {
            "type": "table",
            "title": "Kenya",
            "frame_ref": {"spec_id": spec_id, "content_version": content_version},
            "select": {"stat_var": order},
        }
        card = client.request(
            "POST", "/presentation/components", json={"intent": intent}
        )
        payloads.append(_without_ids(card.json()["resolved_payload"]))
    first, second = payloads
    assert first == second


def test_12_crossing_writes_the_derived_ref(
    client: Client, population: Dataset, quotient: Dataset, e2e_dir: Path
) -> None:
    """Writes the quotient's ref and rows, and a table card's payload of the
    population and GNI join, for the TypeScript journey to compare with its own."""
    joined = client.analysis.join(population, _seeded(client, GNI), on="place")
    card = client.cards.table(joined, title="Kenya")
    written = {
        "ref": json.loads(quotient.ref.to_json()),
        "rows": _rows(quotient),
        "join_ref": json.loads(joined.ref.to_json()),
        "join_card": _without_ids(_payload(client, card.id)),
    }
    (e2e_dir / "derived-python.json").write_text(json.dumps(written))


def test_13_crossing_reads_the_typescript_ref(
    client: Client, quotient: Dataset, e2e_dir: Path
) -> None:
    path = e2e_dir / "derived-typescript.json"
    if not path.exists():
        pytest.skip(f"{path} is absent; the TypeScript journey writes it")
    written = json.loads(path.read_text())
    ref = DatasetRef.from_json(json.dumps(written["ref"]))
    data = client.fetch(ref)
    assert ref.same_data(quotient.ref)
    assert _rows(data) == _rows(quotient)
    assert [
        {column: row[column] for column in ROW_COLUMNS} for row in written["rows"]
    ] == _rows(quotient)
