"""Replay the contract's credentials-path and cache-dir vectors."""

import json
import ntpath
import posixpath
from pathlib import Path, PurePosixPath
from typing import Any

import pytest

from dfo._config import paths
from dfo._config.paths import (
    cache_directory,
    cache_root,
    credentials_path,
    legacy_cache_directory,
)
from dfo._core.types import Rendering
from dfo._datasets.cache import Cache, file_entry, manifest_entry
from tests._fetch_support import manifest
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
def test_cache_dir(
    vector: dict[str, Any], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    context = {
        "env": vector["env"],
        "platform": vector["platform"],
        "home": vector["home"],
    }
    cache_dir = vector.get("cache_dir")
    assert cache_root(cache_dir, **context) == vector["root"]
    assert cache_directory(cache_dir, **context) == vector["directory"]
    assert legacy_cache_directory(cache_dir, **context) == vector["legacy_directory"]
    if reads := vector.get("legacy_reads"):
        _replay_legacy_reads(vector, reads, tmp_path, monkeypatch)


def _replay_legacy_reads(
    vector: dict[str, Any],
    reads: list[dict[str, str]],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Read each entry from the vector's legacy directory through a cache whose
    home is under `tmp_path`, and check it lands at the vector's `to` path.

    A manifest is read and copied. An artifact's bytes are not in the contract,
    so its paths are checked against the cache's own, and the copy of an
    artifact is tested in `tests/datasets/test_cache.py`.
    """
    path = ntpath if vector["platform"] == "windows" else posixpath
    if path is not posixpath:
        pytest.skip("the replay runs a POSIX vector's reads on this disk")
    home = tmp_path / "home"
    monkeypatch.setattr(paths, "current_platform", lambda: vector["platform"])
    monkeypatch.setattr(Path, "home", classmethod(lambda _: home))

    def here(vector_path: str) -> Path:
        return home / PurePosixPath(vector_path).relative_to(vector["home"])

    cache = Cache(env=vector["env"])
    assert cache.directory == here(vector["directory"])
    assert cache.legacy_directory == here(vector["legacy_directory"])
    for read in reads:
        entry = PurePosixPath(read["from"]).relative_to(vector["legacy_directory"])
        assert entry == PurePosixPath(read["to"]).relative_to(vector["directory"])
        if entry.parts[0] == "files":
            digest = "sha256:" + entry.name
            assert cache.legacy_directory / file_entry(digest) == here(read["from"])
            assert cache.directory / file_entry(digest) == here(read["to"])
            continue
        _, spec_id, content_version, name = entry.parts
        rendering = Rendering(name.removesuffix(".json"), False)
        assert manifest_entry(spec_id, content_version, rendering) == entry
        legacy = here(read["from"])
        legacy.parent.mkdir(parents=True)
        legacy.write_text(json.dumps(manifest(spec_id, content_version)))
        assert cache.get_manifest(spec_id, content_version, rendering) is not None
        assert here(read["to"]).read_bytes() == legacy.read_bytes()
