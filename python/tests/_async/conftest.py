"""Run the async tests on asyncio; `scripts/gen_sync.py` derives the sync ones."""

import pytest


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"
