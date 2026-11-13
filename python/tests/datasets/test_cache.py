"""The download cache: the contract's layout, re-hashing, atomic writes, eviction,
the checks on what it reads back, and where it lives."""

import contextlib
import getpass
import json
import logging
import os
import pwd
import threading
from collections.abc import Callable
from datetime import UTC, datetime, timedelta, timezone
from functools import partial
from pathlib import Path
from typing import Any

import pytest

from dfo._core.errors import InvalidRequestError
from dfo._core.types import Rendering
from dfo._datasets import cache as _cache
from dfo._datasets.cache import Cache, file_entry, manifest_entry, sha256_digest
from dfo._datasets.fetch import store
from tests._fetch_support import CUT, CUT_DATA, DATA, LONG, manifest, with_cut
from tests.rule_vectors import ids, vectors

SPEC_ID = "spec_cb5baa4161de718f18583060674dbca6"
CV_OLD = "cv_" + "a" * 32
CV_NEW = "cv_" + "b" * 32
PARQUET = Rendering("parquet", False)


@pytest.fixture
def cache(tmp_path: Path) -> Cache:
    return Cache(tmp_path, env={})


def stored(
    content_version: str, prepared_at: str = "2026-10-01T00:00:00Z"
) -> dict[str, Any]:
    """A served manifest of `SPEC_ID` at `content_version`."""
    body = manifest(SPEC_ID, content_version)
    body["prepared_at"] = prepared_at
    return body


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


@pytest.mark.parametrize("source", ["argument", "environment"])
def test_a_relative_directory_resolves_when_the_cache_is_built(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, source: str
) -> None:
    monkeypatch.chdir(tmp_path)
    if source == "argument":
        cache = Cache("relative", env={})
    else:
        cache = Cache(env={"DFO_CACHE_DIR": "relative"})
    (tmp_path / "elsewhere").mkdir()
    monkeypatch.chdir(tmp_path / "elsewhere")
    assert cache.directory == tmp_path / "relative" / "v1" / "dfo" / "cache1"


def test_a_leading_tilde_name_is_that_users_home() -> None:
    user = getpass.getuser()
    home = Path(pwd.getpwnam(user).pw_dir)
    assert Cache(f"~{user}/dfo", env={}).directory == home / "dfo" / "v1" / "dfo" / (
        "cache1"
    )


@pytest.mark.parametrize(
    "cache_dir",
    ["", "a\0b", b"/tmp/cache", 5, "~no-such-user-dfo/cache"],
    ids=["empty", "nul", "bytes", "int", "unknown-user"],
)
def test_a_cache_dir_that_names_no_directory_is_refused_unless_disabled(
    cache_dir: Any,
) -> None:
    with pytest.raises(InvalidRequestError) as raised:
        Cache(cache_dir, env={})
    assert raised.value.code == "invalid_argument"
    disabled = Cache(cache_dir, enabled=False, env={})
    assert (disabled.enabled, disabled.directory) == (False, None)


def test_a_disabled_cache_leaves_dfo_cache_dir_unread() -> None:
    cache = Cache(enabled=False, env={"DFO_CACHE_DIR": "~no-such-user-dfo/cache"})
    assert (cache.enabled, cache.directory) == (False, None)


def test_bytes_round_trip_under_the_digest_path(cache: Cache) -> None:
    data = b"parquet bytes"
    digest = sha256_digest(data)
    assert cache.get_bytes(digest) is None
    cache.put_bytes(digest, data)
    assert cache.get_bytes(digest) == data
    assert (cache.directory / file_entry(digest)).read_bytes() == data
    assert list(cache.directory.rglob(".tmp-*")) == []


FETCHED = datetime(2026, 11, 13, 9, 14, 5, tzinfo=UTC)


def test_a_fetch_time_is_kept_beside_its_artifact_until_discarded(
    cache: Cache,
) -> None:
    data = b"parquet bytes"
    digest = sha256_digest(data)
    berlin = FETCHED.astimezone(timezone(timedelta(hours=1)))
    cache.put_bytes(digest, data, fetched_at=berlin)
    hex_name = digest.removeprefix("sha256:")
    sidecar = cache.directory / "fetched" / "sha256" / hex_name
    assert sidecar.read_text() == "2026-11-13T09:14:05Z"
    # Equal digests are equal bytes, so a store without a time keeps the first.
    cache.put_bytes(digest, data)
    assert cache.fetched_at(digest) == FETCHED
    assert cache.fetched_at(digest).tzinfo == UTC
    cache.discard(digest)
    assert (cache.get_bytes(digest), cache.fetched_at(digest)) == (None, None)
    assert not sidecar.exists()


@pytest.mark.parametrize(
    "text",
    [None, b"soon", b"2026-11-13T09:14:05", b"\xff"],
    ids=["absent", "not-a-time", "no-zone", "not-utf8"],
)
def test_an_artifact_without_a_readable_fetch_time_has_none(
    cache: Cache, text: bytes | None
) -> None:
    data = b"parquet bytes"
    digest = sha256_digest(data)
    cache.put_bytes(digest, data)
    if text is not None:
        sidecar = cache.directory / "fetched" / "sha256" / digest[len("sha256:") :]
        sidecar.parent.mkdir(parents=True)
        sidecar.write_bytes(text)
    assert cache.get_bytes(digest) == data
    assert cache.fetched_at(digest) is None


def test_a_naive_fetch_time_is_refused(cache: Cache) -> None:
    data = b"parquet bytes"
    with pytest.raises(ValueError):
        cache.put_bytes(sha256_digest(data), data, fetched_at=datetime(2026, 1, 1))
    assert cache.get_bytes(sha256_digest(data)) is None


def test_a_corrupted_artifact_is_a_miss(cache: Cache) -> None:
    data = b"parquet bytes"
    digest = sha256_digest(data)
    cache.put_bytes(digest, data)
    (cache.directory / file_entry(digest)).write_bytes(b"flipped bytes")
    assert cache.get_bytes(digest) is None


@pytest.mark.skipif(not hasattr(os, "mkfifo"), reason="the platform has no FIFO")
@pytest.mark.parametrize("entry", ["artifact", "manifest"])
def test_a_fifo_at_an_entry_path_is_a_miss_that_never_blocks(
    cache: Cache, entry: str
) -> None:
    data = b"parquet bytes"
    digest = sha256_digest(data)
    if entry == "artifact":
        cache.put_bytes(digest, data)
        path = cache.directory / file_entry(digest)
        read: Callable[[], object] = partial(cache.get_bytes, digest)
    else:
        cache.put_manifest(SPEC_ID, CV_OLD, PARQUET, stored(CV_OLD))
        path = cache.directory / manifest_entry(SPEC_ID, CV_OLD, PARQUET)
        read = partial(cache.get_manifest, SPEC_ID, CV_OLD, PARQUET)
    path.unlink()
    os.mkfifo(path)
    found: list[object] = []
    reader = threading.Thread(target=lambda: found.append(read()), daemon=True)
    reader.start()
    reader.join(2.0)
    try:
        assert not reader.is_alive(), "the read blocked on the FIFO"
    finally:
        # Opening the write end releases a reader that blocked, so none lingers.
        with contextlib.suppress(OSError):
            os.close(os.open(path, os.O_WRONLY | os.O_NONBLOCK))
    assert found == [None]


def test_put_refuses_bytes_that_do_not_hash_to_the_digest(cache: Cache) -> None:
    with pytest.raises(ValueError, match="do not hash"):
        cache.put_bytes(sha256_digest(b"one"), b"other")


@pytest.mark.parametrize("digest", ["sha256:../../etc", "md5:" + "0" * 32, "x"])
def test_a_malformed_digest_is_a_miss_and_never_names_a_path(
    cache: Cache, digest: str
) -> None:
    with pytest.raises(ValueError, match="not a sha256 digest"):
        file_entry(digest)
    assert cache.get_bytes(digest) is None
    cache.put_bytes(digest, b"bytes")
    cache.discard(digest)
    assert not cache.directory.exists()


@pytest.mark.parametrize(
    ("spec_id", "content_version"),
    [("spec_../../x", CV_OLD), (SPEC_ID, "cv_../x"), (SPEC_ID, "not a version")],
)
def test_a_malformed_id_is_a_miss_and_never_names_a_path(
    cache: Cache, spec_id: str, content_version: str
) -> None:
    with pytest.raises(ValueError, match="is not a"):
        manifest_entry(spec_id, content_version, PARQUET)
    cache.put_manifest(spec_id, content_version, PARQUET, stored(CV_OLD))
    assert cache.get_manifest(spec_id, content_version, PARQUET) is None
    assert cache.manifest_candidates(spec_id, PARQUET) == []
    assert not cache.directory.exists()


def test_a_disabled_cache_reads_and_writes_nothing(tmp_path: Path) -> None:
    cache = Cache(enabled=False, env={"DFO_CACHE_DIR": str(tmp_path)})
    data = b"parquet bytes"
    cache.put_bytes(sha256_digest(data), data)
    cache.put_manifest(SPEC_ID, CV_OLD, PARQUET, stored(CV_OLD))
    assert cache.get_bytes(sha256_digest(data)) is None
    assert cache.get_manifest(SPEC_ID, CV_OLD, PARQUET) is None
    assert cache.manifest_candidates(SPEC_ID, PARQUET) == []
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize(
    "call",
    [
        lambda cache: cache.put_bytes(sha256_digest(DATA), DATA),
        lambda cache: cache.put_manifest(SPEC_ID, CV_OLD, PARQUET, stored(CV_OLD)),
        lambda cache: cache.manifest_candidates(SPEC_ID, PARQUET),
    ],
    ids=["put_bytes", "put_manifest", "manifest_candidates"],
)
def test_a_cache_disabled_mid_call_still_returns(
    cache: Cache, monkeypatch: pytest.MonkeyPatch, call: Callable[[Cache], object]
) -> None:
    directory = cache.directory
    reads = iter([directory])
    # The first read sees the directory; any later one sees the cache disabled.
    monkeypatch.setattr(Cache, "directory", property(lambda _: next(reads, None)))
    call(cache)


def test_manifests_key_on_version_and_rendering(cache: Cache) -> None:
    body = stored(CV_OLD)
    cache.put_manifest(SPEC_ID, CV_OLD, PARQUET, body)
    assert cache.get_manifest(SPEC_ID, CV_OLD, PARQUET) == body
    assert (
        cache.get_manifest(SPEC_ID, CV_OLD, Rendering("parquet", False, "frame"))
        is None
    )
    assert cache.get_manifest(SPEC_ID, CV_NEW, PARQUET) is None


def test_concurrent_stores_into_one_manifest_keep_both_artifacts(
    cache: Cache, monkeypatch: pytest.MonkeyPatch
) -> None:
    body = with_cut(manifest(SPEC_ID, CV_OLD))
    read = Cache.get_manifest
    other = threading.Thread(
        target=store, args=(cache, body, CUT, sha256_digest(CUT_DATA), CUT_DATA)
    )

    def read_then_let_the_cut_store_run(
        self: Cache, *ids: Any
    ) -> dict[str, Any] | None:
        stored = read(self, *ids)
        if threading.current_thread() is not other:
            other.start()
            # A held manifest keeps the cut store waiting, so this join times out.
            other.join(timeout=0.1)
        return stored

    monkeypatch.setattr(Cache, "get_manifest", read_then_let_the_cut_store_run)
    store(cache, body, LONG, sha256_digest(DATA), DATA)
    other.join()
    monkeypatch.undo()
    merged = cache.get_manifest(SPEC_ID, CV_OLD, LONG)
    assert merged is not None
    assert merged["artifacts"] == [body["artifacts"][1], body["artifacts"][2]]


def _without_definition(body: dict[str, Any]) -> None:
    del body["definition"]


def _set(*path: str | int, value: object) -> Callable[[dict[str, Any]], None]:
    def edit(body: dict[str, Any]) -> None:
        target: Any = body
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = value

    return edit


@pytest.mark.parametrize(
    "tamper",
    [
        None,
        _without_definition,
        _set("definition", "spec_id", value="spec_" + "0" * 32),
        _set("content_version", value=CV_NEW),
        _set("artifacts", value="x"),
        _set("artifacts", value=[1]),
        _set("artifacts", 1, "artifact_digest", value=5),
        _set("retention", value={"pinned": False, "held_until": "soon"}),
        _set("retention", value={"pinned": False, "held_until": 5}),
    ],
    ids=[
        "truncated",
        "no-definition",
        "other-spec",
        "other-version",
        "artifacts-not-a-list",
        "artifact-not-an-object",
        "digest-not-a-string",
        "held-until-not-a-date",
        "held-until-not-a-string",
    ],
)
def test_a_broken_or_tampered_manifest_is_a_miss(
    cache: Cache, tamper: Callable[[dict[str, Any]], None] | None
) -> None:
    body = stored(CV_OLD)
    cache.put_manifest(SPEC_ID, CV_OLD, PARQUET, body)
    path = cache.directory / manifest_entry(SPEC_ID, CV_OLD, PARQUET)
    if tamper is None:
        path.write_text("{trunc")
    else:
        tamper(body)
        path.write_text(json.dumps(body))
    assert cache.get_manifest(SPEC_ID, CV_OLD, PARQUET) is None
    assert cache.manifest_candidates(SPEC_ID, PARQUET) == []


def test_manifest_candidates_put_the_newest_prepared_version_first(
    cache: Cache,
) -> None:
    old = stored(CV_OLD, "2026-10-01T00:00:00Z")
    new = stored(CV_NEW, "2026-10-20T00:00:00Z")
    cache.put_manifest(SPEC_ID, CV_NEW, PARQUET, new)
    cache.put_manifest(SPEC_ID, CV_OLD, PARQUET, old)
    assert cache.manifest_candidates(SPEC_ID, PARQUET) == [new, old]
    assert cache.manifest_candidates(SPEC_ID, Rendering("csv", True)) == []


def test_manifest_candidates_accept_versions_with_the_same_prepared_time(
    cache: Cache,
) -> None:
    timestamp = "2026-10-01T00:00:00Z"
    old = stored(CV_OLD, timestamp)
    new = stored(CV_NEW, timestamp)
    cache.put_manifest(SPEC_ID, CV_OLD, PARQUET, old)
    cache.put_manifest(SPEC_ID, CV_NEW, PARQUET, new)
    assert {
        manifest["content_version"]
        for manifest in cache.manifest_candidates(SPEC_ID, PARQUET)
    } == {CV_OLD, CV_NEW}


def test_eviction_drops_the_least_recently_used(tmp_path: Path) -> None:
    # Three 10-byte artifacts and one 20-byte fetch time overflow 45 bytes.
    cache = Cache(tmp_path, max_bytes=45, env={})
    blobs = [bytes([index]) * 10 for index in range(3)]
    digests = [sha256_digest(blob) for blob in blobs]
    cache.put_bytes(digests[0], blobs[0])
    cache.put_bytes(digests[1], blobs[1], fetched_at=FETCHED)
    first = cache.directory / file_entry(digests[0])
    second = cache.directory / file_entry(digests[1])
    os.utime(first, (1_000, 1_000))
    os.utime(second, (2_000, 2_000))
    assert cache.get_bytes(digests[0]) == blobs[0]  # a read marks it as recently used

    cache.put_bytes(digests[2], blobs[2])

    assert cache.get_bytes(digests[1]) is None
    assert cache.fetched_at(digests[1]) is None
    assert cache.get_bytes(digests[0]) == blobs[0]
    assert cache.get_bytes(digests[2]) == blobs[2]


def test_eviction_counts_each_fetch_time_with_its_artifact(tmp_path: Path) -> None:
    # Two 10-byte artifacts fit 45 bytes. With their 20-byte times they total 60.
    cache = Cache(tmp_path, max_bytes=45, env={})
    blobs = [bytes([index]) * 10 for index in range(2)]
    digests = [sha256_digest(blob) for blob in blobs]
    cache.put_bytes(digests[0], blobs[0], fetched_at=FETCHED)
    os.utime(cache.directory / file_entry(digests[0]), (1_000, 1_000))
    cache.put_bytes(digests[1], blobs[1], fetched_at=FETCHED)
    assert [cache.get_bytes(digest) for digest in digests] == [None, blobs[1]]
    assert list((cache.directory / "fetched" / "sha256").iterdir()) == [
        cache.directory / "fetched" / "sha256" / digests[1].removeprefix("sha256:")
    ]


def test_eviction_removes_a_fetch_time_without_its_artifact(cache: Cache) -> None:
    # Another client, or an older release, removed the artifact and left its time.
    orphan = cache.directory / "fetched" / "sha256" / ("0" * 64)
    orphan.parent.mkdir(parents=True)
    orphan.write_text("2026-11-13T09:14:05Z")
    data = b"parquet bytes"
    cache.put_bytes(sha256_digest(data), data, fetched_at=FETCHED)
    assert not orphan.exists()
    assert cache.fetched_at(sha256_digest(data)) == FETCHED


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
        cache.put_manifest(SPEC_ID, CV_OLD, PARQUET, stored(CV_OLD))
    assert cache.get_bytes(sha256_digest(data)) is None
    assert caplog.text.count("could not write") == 2
