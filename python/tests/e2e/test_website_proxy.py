"""The share journey through the website's `/api/v1` proxy, on the dfo-apis local stack.

Marked `live` and deselected by default. `scripts/local-stack-journeys.sh proxy` in the
repository root brings the stack up and seeds it, starts a throwaway Postgres for the website
and the website's dev server in front of the stack, runs this module, and stops them all:

    DFO_APIS_DIR=/path/to/dfo-apis DFO_WEBSITE_DIR=/path/to/dfo-website \\
        scripts/local-stack-journeys.sh proxy

The client reads `DFO_WEBSITE_URL`, the site's `/api/v1`, and sends every call with
`X-Forwarded-For: 203.0.113.7`, the address the site's front end would append. The website
names that client to dfo-apis as `x-dfo-caller: ip:<digest>` beside the
`x-dfo-caller-principal` secret, and sends no address. The journey divides German ODA by
Kenya's population, draws a line card of it, shares the card live, reads the share back,
replaces it and takes it down, then checks that dfo-apis counted the share against the
website's digest of 203.0.113.7 under `DFO_CALLER_HMAC_KEY`, the key the website and the
stack share, and against no other caller.

The allowance is read from the stack's Postgres container, `dfo-local-stack-postgres-1`.
"""

import hashlib
import hmac
import os
import subprocess
from collections.abc import Iterator

import httpx2
import pytest

from dfo import Client, Dataset
from dfo._sync._datasets.fetch import Session
from dfo._sync._http.transport import Transport
from dfo.errors import NotFoundError
from dfo.types import Card, Share
from tests.e2e.test_local_stack import ODA, PAIRING, POPULATION, Shim, _rows, _seeded

pytestmark = [
    pytest.mark.live,
    pytest.mark.filterwarnings("ignore::dfo.errors.SeriesLeftOutWarning"),
]

# A documentation address (RFC 5737), so its digest can only come from this journey.
CLIENT_ADDRESS = "203.0.113.7"
STACK_POSTGRES = "dfo-local-stack-postgres-1"


def _setting(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        pytest.fail(f"{name} is unset; scripts/local-stack-journeys.sh proxy sets it")
    return value


def _share_allowance() -> dict[str, int]:
    """Today's share writes per caller key, as dfo-apis counted them."""
    query = (
        "select caller_key, count from datasets.caller_allowance"
        " where kind = 'share' and day = (now() at time zone 'utc')::date"
    )
    out = subprocess.run(
        [
            "docker",
            "exec",
            STACK_POSTGRES,
            "psql",
            "-U",
            "dfo_local_migrator",
            "-d",
            "datasets",
            "-tAF,",
            "-c",
            query,
        ],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return {
        key: int(count)
        for key, count in (line.split(",") for line in out.splitlines() if line)
    }


@pytest.fixture(scope="module")
def website_url() -> str:
    return _setting("DFO_WEBSITE_URL")


@pytest.fixture(scope="module")
def client(website_url: str) -> Iterator[Client]:
    url = httpx2.URL(website_url)
    shim = Shim(f"{url.scheme}://{url.netloc.decode()}")
    transport = Transport(
        base_url=website_url,
        api_key=False,
        headers={"X-Forwarded-For": CLIENT_ADDRESS},
        http_transport=shim,
    )
    with Client._over(Session(transport, None)) as client:
        yield client


@pytest.fixture(autouse=True)
def online(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DFO_OFFLINE", raising=False)
    monkeypatch.setenv("DFO_PROGRESS", "0")


@pytest.fixture(scope="module")
def allowance_before() -> dict[str, int]:
    return _share_allowance()


@pytest.fixture(scope="module")
def quotient(client: Client) -> Dataset:
    return client.analysis.quotient_of(
        _seeded(client, ODA), _seeded(client, POPULATION), on=PAIRING
    )


@pytest.fixture(scope="module")
def card(client: Client, quotient: Dataset) -> Card:
    return client.cards.line(quotient, title="Aid per person")


@pytest.fixture(scope="module")
def share(client: Client, card: Card, allowance_before: dict[str, int]) -> Share:
    return client.share(card, latest=True)


def test_01_analysis_and_card_through_the_proxy(quotient: Dataset, card: Card) -> None:
    (member,) = quotient.ref.members
    assert member.spec.spec_id.startswith("ops_")
    assert len(_rows(quotient)) == 6
    assert (card.kind, card.revision) == ("line", 1)
    assert card.ref == quotient.ref


def test_02_live_share_fetch_replace_unshare(
    client: Client, website_url: str, quotient: Dataset, card: Card, share: Share
) -> None:
    site = website_url.removesuffix("/api/v1")
    assert share.url == f"{site}/s/{share.id}"
    assert (share.latest, share.revision) == (True, 1)
    assert share.write_token is not None

    shown = client.fetch(share, slot=1)
    assert _rows(shown) == _rows(quotient)
    assert shown.ref.same_data(quotient.ref)

    replaced = client.share([card, card], latest=True, replace=share)
    assert (replaced.id, replaced.revision) == (share.id, 2)
    assert _rows(client.fetch(replaced, slot=2)) == _rows(quotient)

    client.unshare(share)
    with pytest.raises(NotFoundError) as caught:
        client.fetch(share, slot=1)
    assert caught.value.code == "not_found"


def test_03_dfo_apis_counted_the_website_digest(
    share: Share, allowance_before: dict[str, int]
) -> None:
    key = _setting("DFO_CALLER_HMAC_KEY")
    digest = hmac.new(key.encode(), CLIENT_ADDRESS.encode(), hashlib.sha256).hexdigest()
    caller = "ip:" + digest[:32]
    after = _share_allowance()
    spent = {
        name: count - allowance_before.get(name, 0)
        for name, count in after.items()
        if count != allowance_before.get(name, 0)
    }
    assert spent == {caller: 1}
