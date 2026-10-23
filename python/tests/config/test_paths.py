"""Replay the contract's credentials-path and cache-dir vectors."""

from typing import Any

import pytest

from dfo._config.paths import cache_directory, cache_root, credentials_path
from tests.rule_vectors import ids, vectors


@pytest.mark.parametrize(
    "vector", vectors("credentials-path"), ids=ids("credentials-path")
)
def test_credentials_path(vector: dict[str, Any]) -> None:
    path = credentials_path(
        env=vector["env"], platform=vector["platform"], home=vector["home"]
    )
    assert path == vector["path"]


@pytest.mark.parametrize("vector", vectors("cache-dir"), ids=ids("cache-dir"))
def test_cache_dir(vector: dict[str, Any]) -> None:
    context = {
        "env": vector["env"],
        "platform": vector["platform"],
        "home": vector["home"],
    }
    assert cache_root(vector.get("cache_dir"), **context) == vector["root"]
    assert cache_directory(vector.get("cache_dir"), **context) == vector["directory"]
