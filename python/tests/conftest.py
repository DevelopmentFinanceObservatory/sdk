"""Bring `contract/` to the commit `contract/SOURCE` names before any test reads it,
and keep `DFO_BASE_URL` out of every test not marked `live`."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

import sync_contract


@pytest.fixture(autouse=True)
def no_base_url_from_the_environment(
    request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Keep a `DFO_BASE_URL` set for the live tests away from every other test,
    since a client built with no base URL reads it."""
    if request.node.get_closest_marker("live") is None:
        monkeypatch.delenv("DFO_BASE_URL", raising=False)


def pytest_configure() -> None:
    try:
        sync_contract.ensure_current()
    except sync_contract.FetchError as error:
        raise pytest.UsageError(str(error)) from error
