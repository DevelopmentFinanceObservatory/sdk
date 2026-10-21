"""Bring `contract/` to the commit `contract/SOURCE` names before any test reads it."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

import sync_contract


def pytest_configure() -> None:
    try:
        sync_contract.ensure_current()
    except sync_contract.FetchError as error:
        raise pytest.UsageError(str(error)) from error
