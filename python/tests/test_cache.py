"""The download cache: the contract's layout, re-hashing, atomic writes and eviction."""

import logging
import os
from pathlib import Path
from typing import Any

import pytest

from dfo import _cache
from dfo._cache import Cache, file_entry, manifest_entry, sha256_digest
from dfo._types import Rendering
from tests.rule_vectors import ids, vectors

SPEC_ID = "spec_cb5baa4161de718f18583060674dbca6"
CV_OLD = "cv_" + "a" * 32
CV_NEW = "cv_" + "b" * 32
PARQUET = Rendering("parquet", False)


@pytest.fixture
def cache(tmp_path: Path) -> Cache:
    return Cache(tmp_path, env={})


@pytest.mark.parametrize("vector", vectors("cache-layout"), ids=ids("cache-layout"))
def test_cache_layout(vector: dict[str, Any]) -> None:
    if vector["entry"] == "file":
        path = file_entry(vector["digest"])
    else:
        rendering = vector["rendering"]
        path = manifest_entry(
            vector["spec_id"],
            vector["content_version"],
            Rendering(
                rendering["format"], rendering["bundle"], rendering.get("layout")
            ),
        )
    assert str(path) == vector["path"]


def test_directory_is_the_contract_cache_directory(tmp_path: Path) -> None:
    assert Cache(tmp_path, env={}).directory == tmp_path / "v1" / "dfo" / "cache1"
    from_env = Cache(env={"DFO_CACHE_DIR": str(tmp_path)})
    assert from_env.directory == tmp_path / "v1" / "dfo" / "cache1"


def test_bytes_round_trip_under_the_digest_path(cache: Cache) -> None:
    data = b"parquet bytes"
    digest = sha256_digest(data)
    assert cache.get_bytes(digest) is None
    cache.put_bytes(digest, data)
    assert cache.get_bytes(digest) == data
    assert (cache.directory / file_entry(digest)).read_bytes() == data
    assert list(cache.directory.rglob(".tmp-*")) == []


def test_a_corrupted_artifact_is_a_miss(cache: Cache) -> None:
    data = b"parquet bytes"
    digest = sha256_digest(data)
    cache.put_bytes(digest, data)
    (cache.directory / file_entry(digest)).write_bytes(b"flipped bytes")
    assert cache.get_bytes(digest) is None


def test_put_refuses_bytes_that_do_not_hash_to_the_digest(cache: Cache) -> None:
    with pytest.raises(ValueError, match="do not hash"):
        cache.put_bytes(sha256_digest(b"one"), b"other")


@pytest.mark.parametrize("digest", ["sha256:../../etc", "md5:" + "0" * 32, "x"])
def test_a_malformed_digest_never_names_a_path(cache: Cache, digest: str) -> None:
    with pytest.raises(ValueError, match="not a sha256 digest"):
        cache.get_bytes(digest)


def test_a_malformed_spec_id_never_names_a_path(cache: Cache) -> None:
    with pytest.raises(ValueError, match="not a spec id"):
        cache.get_manifest("spec_../../x", CV_OLD, PARQUET)


def test_a_disabled_cache_reads_and_writes_nothing(tmp_path: Path) -> None:
    cache = Cache(tmp_path, enabled=False, env={})
    data = b"parquet bytes"
    cache.put_bytes(sha256_digest(data), data)
    cache.put_manifest(SPEC_ID, CV_OLD, PARQUET, {"content_version": CV_OLD})
    assert cache.get_bytes(sha256_digest(data)) is None
    assert cache.get_manifest(SPEC_ID, CV_OLD, PARQUET) is None
    assert cache.latest_manifest(SPEC_ID, PARQUET) is None
    assert not cache.directory.exists()


def test_manifests_key_on_version_and_rendering(cache: Cache) -> None:
    manifest = {"content_version": CV_OLD, "prepared_at": "2026-10-01T00:00:00Z"}
    cache.put_manifest(SPEC_ID, CV_OLD, PARQUET, manifest)
    assert cache.get_manifest(SPEC_ID, CV_OLD, PARQUET) == manifest
    assert (
        cache.get_manifest(SPEC_ID, CV_OLD, Rendering("parquet", False, "frame"))
        is None
    )
    assert cache.get_manifest(SPEC_ID, CV_NEW, PARQUET) is None


def test_a_broken_manifest_is_a_miss(cache: Cache) -> None:
    cache.put_manifest(SPEC_ID, CV_OLD, PARQUET, {"content_version": CV_OLD})
    (cache.directory / manifest_entry(SPEC_ID, CV_OLD, PARQUET)).write_text("{trunc")
    assert cache.get_manifest(SPEC_ID, CV_OLD, PARQUET) is None


def test_latest_manifest_is_the_newest_prepared_version(cache: Cache) -> None:
    old = {"content_version": CV_OLD, "prepared_at": "2026-10-01T00:00:00Z"}
    new = {"content_version": CV_NEW, "prepared_at": "2026-10-20T00:00:00Z"}
    cache.put_manifest(SPEC_ID, CV_NEW, PARQUET, new)
    cache.put_manifest(SPEC_ID, CV_OLD, PARQUET, old)
    assert cache.latest_manifest(SPEC_ID, PARQUET) == new
    assert cache.latest_manifest(SPEC_ID, Rendering("csv", True)) is None


def test_eviction_drops_the_least_recently_used(tmp_path: Path) -> None:
    cache = Cache(tmp_path, max_bytes=25, env={})
    blobs = [bytes([index]) * 10 for index in range(3)]
    digests = [sha256_digest(blob) for blob in blobs]
    cache.put_bytes(digests[0], blobs[0])
    cache.put_bytes(digests[1], blobs[1])
    first = cache.directory / file_entry(digests[0])
    second = cache.directory / file_entry(digests[1])
    os.utime(first, (1_000, 1_000))
    os.utime(second, (2_000, 2_000))
    assert cache.get_bytes(digests[0]) == blobs[0]  # a read marks it as recently used

    cache.put_bytes(digests[2], blobs[2])

    assert cache.get_bytes(digests[1]) is None
    assert cache.get_bytes(digests[0]) == blobs[0]
    assert cache.get_bytes(digests[2]) == blobs[2]


def test_an_entry_larger_than_the_cap_is_kept(tmp_path: Path) -> None:
    cache = Cache(tmp_path, max_bytes=5, env={})
    data = b"x" * 10
    cache.put_bytes(sha256_digest(data), data)
    assert cache.get_bytes(sha256_digest(data)) == data


def _refuse_replace(*_: object) -> None:
    raise PermissionError("the file is open in another process")


def test_a_refused_replace_over_the_same_artifact_is_a_hit(
    cache: Cache, monkeypatch: pytest.MonkeyPatch
) -> None:
    data = b"parquet bytes"
    digest = sha256_digest(data)
    cache.put_bytes(digest, data)
    monkeypatch.setattr(_cache.os, "replace", _refuse_replace)
    cache.put_bytes(digest, data)
    assert cache.get_bytes(digest) == data
    assert list(cache.directory.rglob(".tmp-*")) == []


def test_a_refused_replace_over_other_bytes_is_logged_and_skipped(
    cache: Cache, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    data = b"parquet bytes"
    digest = sha256_digest(data)
    path = cache.directory / file_entry(digest)
    path.parent.mkdir(parents=True)
    path.write_bytes(b"a partial write")
    monkeypatch.setattr(_cache.os, "replace", _refuse_replace)
    with caplog.at_level(logging.WARNING, logger="dfo"):
        cache.put_bytes(digest, data)
    assert "could not write" in caplog.text
    assert cache.get_bytes(digest) is None


def test_an_unwritable_cache_never_fails_the_caller(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    blocker = tmp_path / "blocker"
    blocker.write_text("a file where the cache directory would go")
    cache = Cache(blocker, env={})
    data = b"parquet bytes"
    with caplog.at_level(logging.WARNING, logger="dfo"):
        cache.put_bytes(sha256_digest(data), data)
        cache.put_manifest(SPEC_ID, CV_OLD, PARQUET, {})
    assert cache.get_bytes(sha256_digest(data)) is None
    assert caplog.text.count("could not write") == 2
