"""The download cache: artifacts by digest, manifests by built version and rendering.

The layout follows the contract's cache-layout rule (`contract/rules/README.md`), so
clients that implement cache1 read the others' entries. An entry is written to a
temporary name in its own directory and renamed into place, so a reader never sees a
partial entry.
Entries are keyed by content, so two processes writing one artifact write the same
bytes and need no lock. Concurrent manifest updates can lose a cache candidate,
but never make an artifact name different bytes. A read re-hashes an artifact, and
a mismatch is a miss. A manifest is read back only when it passes the checks a
served manifest passes, any `held_until` it holds reads as a date, and it names
the spec and version its path does; anything else is a miss, which a fetch fills
from the server again. An entry is read only from a regular file, so a directory,
a FIFO or a device at an entry's path is a miss too. The citation text is read
back as stored. A key that is not a server id, such as a malformed digest in a
served manifest, is a miss on read and skipped on write.

An artifact stored with a fetch time has a sibling entry,
`fetched/sha256/<hex>`, holding the UTC time its bytes left the server as ISO 8601
text. The cache-layout rule leaves the time out, so another client, or an older
release, may store an artifact without one, and its fetch time reads as unknown.
Eviction counts a time's bytes with its artifact's and removes the two together,
and it removes a time whose artifact another client removed. `discard` removes
the time with its artifact.

Python clients before 0.2.0 kept the platform default root under `readerkit`, and
the cache-dir rule names that cache directory the legacy directory. With no
explicit root, a miss reads the entry at the same path in the legacy directory,
under the same checks: an artifact counts only when its bytes hash to its digest,
and a manifest only when it passes the checks above. A hit is copied to the same
path in the cache directory, by the same temporary-name rename, with no fetch
time. A manifest already in the cache directory wins, one a fetch merged
there since the miss included, and `manifest_candidates` lists the legacy
directory's manifests too. The cache never writes, evicts or counts an
entry in the legacy directory.

Concurrent fetches in one process download an artifact once: `downloading`
holds its digest while the first fetch reads the cache, downloads and stores,
and the others then read the stored file. `merging` holds a manifest's path while
a fetch reads, merges and writes it, so fetches in one process keep each other's
entries.

Both clients call this module. It works on local files only.
"""

import hashlib
import json
import logging
import os
import stat
import tempfile
from collections.abc import Mapping
from contextlib import nullcontext
from datetime import UTC, datetime
from os import PathLike
from pathlib import Path, PurePosixPath
from typing import Any

from dfo._config.paths import cache_directory, legacy_cache_directory
from dfo._core.codes import INVALID_ARGUMENT
from dfo._core.errors import ContractError, DfoTimeoutError, client_error
from dfo._core.json_text import loads
from dfo._core.types import CONTENT_VERSION, DIGEST, SPEC_ID, Rendering
from dfo._datasets.build import check_served_manifest, read_held_until
from dfo._http.hooks import Hold, KeyedLock

logger = logging.getLogger("dfo")

# A cache read opens a file in binary mode on Windows and, where the platform has
# FIFOs, without waiting for a writer.
_READ_FLAGS = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NONBLOCK", 0)

# The default bound on the artifacts the cache keeps, in bytes.
DEFAULT_MAX_BYTES = 2 * 1024**3

# The artifacts being downloaded into any cache of this process, by path.
_DOWNLOADS = KeyedLock()

# The manifests being merged in any cache of this process, by path.
_MERGES = KeyedLock()


def rendering_name(rendering: Rendering, /) -> str:
    """The rendering as a manifest entry names it: `parquet`, `parquet-frame`, `csv-bundle`."""
    name = rendering.format
    if rendering.bundle:
        name += "-bundle"
    if rendering.layout == "frame":
        name += "-frame"
    return name


def file_entry(digest: str, /) -> PurePosixPath:
    """The path of an artifact inside the cache directory, `files/sha256/<hex>`.

    Raises:
        ValueError: `digest` is not `sha256:` and 64 lowercase hex characters.
    """
    if DIGEST.fullmatch(digest) is None:
        raise ValueError(f"{digest!r} is not a sha256 digest")
    return PurePosixPath("files", "sha256", digest.removeprefix("sha256:"))


def fetched_entry(digest: str, /) -> PurePosixPath:
    """The path of an artifact's fetch time inside the cache directory,
    `fetched/sha256/<hex>`.

    Raises:
        ValueError: `digest` is not `sha256:` and 64 lowercase hex characters.
    """
    return PurePosixPath("fetched", *file_entry(digest).parts[1:])


def fetch_time_text(fetched_at: datetime, /) -> str:
    """A fetch time as the cache stores it: UTC, whole seconds, and `Z`.

    Raises:
        ValueError: `fetched_at` is a naive datetime.
    """
    if fetched_at.tzinfo is None:
        raise ValueError("fetched_at is a naive datetime; give it a time zone")
    text = fetched_at.astimezone(UTC).isoformat(timespec="seconds")
    return text.replace("+00:00", "Z")


def manifest_entry(
    spec_id: str, content_version: str, rendering: Rendering, /
) -> PurePosixPath:
    """The path of a manifest inside the cache directory.

    It is `manifests/<spec_id>/<content_version>/<rendering>.json`, named by
    `rendering_name`.

    Raises:
        ValueError: `spec_id` or `content_version` is not a server id.
    """
    if SPEC_ID.fullmatch(spec_id) is None:
        raise ValueError(f"{spec_id!r} is not a spec id")
    if CONTENT_VERSION.fullmatch(content_version) is None:
        raise ValueError(f"{content_version!r} is not a content version")
    return PurePosixPath(
        "manifests", spec_id, content_version, f"{rendering_name(rendering)}.json"
    )


def cache_path(
    cache_dir: str | PathLike[str] | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> Path:
    """The absolute cache directory, `<root>/v1/dfo/cache1`, by the cache-dir rule.

    A relative root resolves against the working directory at call time, so a later
    `chdir` does not move the cache.

    Raises:
        InvalidRequestError: `cache_dir` is not a string or `str` path, is
            empty, holds a NUL character, or starts `~name` for a user with no
            home directory (`invalid_argument`).
    """
    if cache_dir is not None:
        chosen = os.fspath(cache_dir) if isinstance(cache_dir, str | PathLike) else None
        if not isinstance(chosen, str) or not chosen or "\0" in chosen:
            raise client_error(
                INVALID_ARGUMENT,
                "cache_dir is a non-empty path without NUL characters, or None "
                f"for the default, not {cache_dir!r}",
            )
    try:
        directory = cache_directory(cache_dir, env=os.environ if env is None else env)
    except ValueError as error:
        raise client_error(INVALID_ARGUMENT, str(error)) from error
    return Path(directory).absolute()


def _legacy_path(
    cache_dir: str | PathLike[str] | None, *, env: Mapping[str, str]
) -> Path | None:
    """The absolute legacy directory, or None under an explicit root.

    Called after `cache_path` accepts `cache_dir`, so it raises nothing.
    """
    legacy = legacy_cache_directory(cache_dir, env=env)
    return None if legacy is None else Path(legacy).absolute()


def sha256_digest(data: bytes, /) -> str:
    """The digest of `data` as the server writes it, `sha256:<hex>`."""
    return "sha256:" + hashlib.sha256(data).hexdigest()


class Cache:
    """The cache one client reads and writes.

    A disabled cache misses every read and drops every write. It resolves no
    directory, so it accepts any `cache_dir` and `DFO_CACHE_DIR`. An entry the
    disk refuses is logged to the `dfo` logger and skipped, so a write cannot fail
    a fetch.

    Attributes:
        max_bytes: The bound on the artifacts kept; the least recently used go
            first.
    """

    __slots__ = ("_directory", "_legacy", "max_bytes")

    def __init__(
        self,
        cache_dir: str | PathLike[str] | None = None,
        *,
        enabled: bool = True,
        max_bytes: int = DEFAULT_MAX_BYTES,
        env: Mapping[str, str] | None = None,
    ) -> None:
        self._directory = cache_path(cache_dir, env=env) if enabled else None
        self._legacy = (
            _legacy_path(cache_dir, env=os.environ if env is None else env)
            if enabled
            else None
        )
        self.max_bytes = max_bytes

    @property
    def enabled(self) -> bool:
        """Whether the cache reads and writes entries."""
        return self._directory is not None

    @property
    def directory(self) -> Path | None:
        """The cache directory, `<root>/v1/dfo/cache1`, or None when disabled."""
        return self._directory

    @property
    def legacy_directory(self) -> Path | None:
        """The cache directory of Python clients before 0.2.0, which this cache
        reads and never writes, or None when disabled or under an explicit root."""
        return self._legacy

    def downloading(
        self, digest: str, /, *, timeout: float | None = None
    ) -> Hold | nullcontext[None]:
        """Hold `digest` while one fetch reads, downloads and stores its artifact.

        `with` holds it among threads and `async with` among one loop's tasks,
        waiting up to `timeout` seconds, or without limit for None. A disabled
        cache holds nothing, since no fetch could read what another stored.

        Raises:
            DfoTimeoutError: The wait passed `timeout` (`deadline_exceeded`).
        """
        if (directory := self.directory) is None:
            return nullcontext()
        return _DOWNLOADS.hold((str(directory), digest), timeout=timeout)

    def merging(
        self, spec_id: str, content_version: str, rendering: Rendering, /
    ) -> Hold | nullcontext[None]:
        """Hold a manifest's path, among threads, while one fetch reads, merges
        and writes it.

        Writers in separate processes are not held, so one can still drop an
        entry another wrote, which the contract's cache-layout rule allows. A
        disabled cache, or ids that name no path, hold nothing.
        """
        if (path := self._manifest(spec_id, content_version, rendering)) is None:
            return nullcontext()
        return _MERGES.hold(str(path))

    def get_bytes(self, digest: str, /) -> bytes | None:
        """The artifact with `digest`, or None when it is absent or its bytes differ."""
        if (path := self._file(digest)) is None:
            return None
        if (data := _read_regular(path)) is not None and sha256_digest(data) == digest:
            _touch(path)
            return data
        if (legacy := self._legacy_entry(path)) is None:
            return None
        if (data := _read_regular(legacy)) is None or sha256_digest(data) != digest:
            return None
        # A copied artifact has no fetch time, so a time left without its
        # artifact cannot name it. A download that stored the artifact since
        # the miss stored its time too, which stays.
        if (times := self._fetched(digest)) is not None and not path.exists():
            _remove(times)
        if _write(path, data, digest=digest):
            self._evict(keep=path)
        return data

    def put_bytes(
        self, digest: str, data: bytes, /, *, fetched_at: datetime | None = None
    ) -> None:
        """Store an artifact under its digest, then evict down to `max_bytes`.

        `fetched_at` is when the bytes left the server, an aware datetime,
        which `fetched_at` reads back. None records no time and keeps any time
        recorded before, since equal digests are equal bytes.

        Raises:
            ValueError: `data` does not hash to `digest`, or `fetched_at` is a
                naive datetime.
        """
        if (path := self._file(digest)) is None:
            return
        if sha256_digest(data) != digest:
            raise ValueError(f"the bytes do not hash to {digest}")
        text = None if fetched_at is None else fetch_time_text(fetched_at)
        if not _write(path, data, digest=digest):
            return
        if text is not None and (times := self._fetched(digest)) is not None:
            _write(times, text.encode())
        self._evict(keep=path)

    def fetched_at(self, digest: str, /) -> datetime | None:
        """When the artifact with `digest` left the server, in UTC, or None when
        the cache recorded no time or the recorded text is not an ISO 8601 time
        with a zone."""
        if (path := self._fetched(digest)) is None:
            return None
        if (data := _read_regular(path)) is None:
            return None
        try:
            fetched = datetime.fromisoformat(data.decode())
        except (UnicodeDecodeError, ValueError):
            return None
        return fetched.astimezone(UTC) if fetched.tzinfo is not None else None

    def discard(self, digest: str, /) -> None:
        """Remove the artifact with `digest`, whose bytes hash right but do not read.

        A manifest that lists it stays, and its next fetch downloads the artifact
        again.
        """
        if (path := self._file(digest)) is None:
            return
        for entry in (path, self._fetched(digest)):
            if entry is not None:
                _remove(entry)

    def get_manifest(
        self, spec_id: str, content_version: str, rendering: Rendering, /
    ) -> dict[str, Any] | None:
        """The stored manifest of a built version's rendering, or None.

        None also when the file does not pass `check_served_manifest`, holds a
        `held_until` that does not read as a date, or names another spec or
        version than its path. A miss reads the legacy directory.
        """
        path = self._manifest(spec_id, content_version, rendering)
        if path is None:
            return None
        manifest = _held_manifest(path, spec_id, content_version)
        if manifest is not None:
            return manifest
        return self._legacy_manifest(path, spec_id, content_version)

    def put_manifest(
        self,
        spec_id: str,
        content_version: str,
        rendering: Rendering,
        manifest: Mapping[str, Any],
        /,
    ) -> None:
        """Store a built version's manifest for one rendering."""
        path = self._manifest(spec_id, content_version, rendering)
        if path is None:
            return
        _write(path, json.dumps(manifest, ensure_ascii=False).encode())

    def manifest_candidates(
        self, spec_id: str, rendering: Rendering, /
    ) -> list[dict[str, Any]]:
        """Cached manifests of a spec in one rendering, newest first.

        Manifest files that `get_manifest` would not return, and those with no
        `prepared_at`, are omitted. The legacy directory's manifests are listed
        too, each copied into the cache directory, and a version the cache
        directory holds wins. Callers that need an artifact still verify its
        bytes before choosing a candidate.
        """
        directory = self.directory
        if directory is None or SPEC_ID.fullmatch(spec_id) is None:
            return []
        name = f"{rendering_name(rendering)}.json"
        held: dict[str, dict[str, Any]] = {}
        for path in sorted((directory / "manifests" / spec_id).glob(f"*/{name}")):
            manifest = _held_manifest(path, spec_id, path.parent.name)
            if manifest is not None:
                held[path.parent.name] = manifest
        if (legacy := self._legacy) is not None:
            for path in sorted((legacy / "manifests" / spec_id).glob(f"*/{name}")):
                content_version = path.parent.name
                if content_version in held:
                    continue
                target = self._manifest(spec_id, content_version, rendering)
                if target is None:
                    continue
                manifest = self._legacy_manifest(target, spec_id, content_version)
                if manifest is not None:
                    held[content_version] = manifest
        found = [
            manifest
            for manifest in held.values()
            if isinstance(manifest.get("prepared_at"), str)
        ]
        return sorted(found, key=lambda manifest: manifest["prepared_at"], reverse=True)

    def _file(self, digest: str) -> Path | None:
        """The artifact's path, or None when the cache is disabled or `digest` is
        not a sha256 digest."""
        if (directory := self.directory) is None:
            return None
        try:
            return directory / file_entry(digest)
        except ValueError:
            logger.debug("dfo cache: %r is not a digest; skipped", digest)
            return None

    def _legacy_entry(self, path: Path) -> Path | None:
        """The legacy directory's entry at the path `path` names in the cache
        directory, or None when there is no legacy directory."""
        if (legacy := self._legacy) is None or (directory := self._directory) is None:
            return None
        return legacy / path.relative_to(directory)

    def _legacy_manifest(
        self, path: Path, spec_id: str, content_version: str
    ) -> dict[str, Any] | None:
        """The legacy directory's manifest at the path `path` names, copied to
        `path`, or None when there is none or it fails `_held_manifest`'s checks."""
        if (legacy := self._legacy_entry(path)) is None:
            return None
        if (data := _read_regular(legacy)) is None:
            return None
        manifest = _checked_manifest(data, legacy, spec_id, content_version)
        if manifest is None:
            return None
        # The copy takes `merging`'s hold, and a fetch may have merged a manifest
        # into `path` since the miss, which wins. A hold taken already, by this
        # thread's own merge or another's, writes `path` after reading this
        # manifest, so the copy is left to it.
        try:
            with _MERGES.hold(str(path), timeout=0):
                current = _held_manifest(path, spec_id, content_version)
                if current is not None:
                    return current
                _write(path, data)
        except DfoTimeoutError:
            pass
        return manifest

    def _fetched(self, digest: str) -> Path | None:
        """The path of the artifact's fetch time, beside `files`, or None when
        the cache is disabled or `digest` is not a sha256 digest."""
        if self.directory is None or self._file(digest) is None:
            return None
        return self.directory / fetched_entry(digest)

    def _manifest(
        self, spec_id: str, content_version: str, rendering: Rendering
    ) -> Path | None:
        """The manifest's path, or None when the cache is disabled or the ids are
        not server ids."""
        if (directory := self.directory) is None:
            return None
        try:
            return directory / manifest_entry(spec_id, content_version, rendering)
        except ValueError:
            logger.debug(
                "dfo cache: %r at %r is not a spec version; skipped",
                spec_id,
                content_version,
            )
            return None

    def _evict(self, *, keep: Path) -> None:
        """Remove the least recently used artifacts, each with its fetch time,
        until the artifacts and their times fit `max_bytes`, keeping `keep`.
        A fetch time whose artifact is gone, such as one another client
        evicted, goes too."""
        if (directory := self.directory) is None:
            return
        times = directory / "fetched" / "sha256"
        entries: list[tuple[float, int, Path]] = []
        held: set[str] = set()
        for path in (directory / "files").glob("sha256/*"):
            if path.name.startswith("."):
                continue
            try:
                stat = path.stat()
            except FileNotFoundError:
                continue
            held.add(path.name)
            entries.append(
                (stat.st_mtime, stat.st_size + _size(times / path.name), path)
            )
        for time in times.glob("*"):
            # Checked again, since another process may have stored the artifact
            # after the listing above.
            if time.name.startswith(".") or time.name in held:
                continue
            if not (directory / "files" / "sha256" / time.name).exists():
                _remove(time)
        total = sum(size for _, size, _ in entries)
        for _, size, path in sorted(entries, key=lambda entry: entry[0]):
            if total <= self.max_bytes:
                break
            if path == keep:
                continue
            _remove(path)
            _remove(times / path.name)
            total -= size


def _size(path: Path) -> int:
    """The bytes of the file at `path`, or 0 when there is none."""
    try:
        return path.stat().st_size
    except OSError:
        return 0


def _remove(path: Path) -> None:
    """Remove the file at `path`, logging a refusal."""
    try:
        path.unlink(missing_ok=True)
    except OSError as error:
        logger.warning("dfo cache: could not remove %s: %s", path, error)


def _write(path: Path, data: bytes, *, digest: str | None = None) -> bool:
    """Write `data` to `path` through a temporary sibling; False when the disk refuses."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        handle, temporary = tempfile.mkstemp(dir=path.parent, prefix=".tmp-")
        try:
            with os.fdopen(handle, "wb") as file:
                file.write(data)
            _replace(temporary, path, digest=digest)
        finally:
            Path(temporary).unlink(missing_ok=True)
    except OSError as error:
        logger.warning("dfo cache: could not write %s: %s", path, error)
        return False
    return True


def _replace(temporary: str, path: Path, *, digest: str | None) -> None:
    try:
        os.replace(temporary, path)
    except PermissionError:
        # Windows refuses to replace a file another process holds open. An existing
        # artifact with the right hash is the entry this write would have made.
        if digest is None or not _holds(path, digest):
            raise


def _holds(path: Path, digest: str) -> bool:
    return (data := _read_regular(path)) is not None and sha256_digest(data) == digest


def _read_regular(path: Path) -> bytes | None:
    """The bytes of the regular file at `path`, or None when it is absent,
    unreadable or anything else, such as a directory or a FIFO.

    The file opens without blocking, so a FIFO cannot hold the read, and its
    kind is read from the open file, so a swap after the check cannot change it.
    """
    try:
        handle = os.open(path, _READ_FLAGS)
    except OSError:  # absent, or a cache directory the disk refuses
        return None
    # The kind is read before `fdopen`, which raises on a directory.
    try:
        regular = stat.S_ISREG(os.fstat(handle).st_mode)
    except OSError:
        regular = False
    if not regular:
        os.close(handle)
        return None
    with os.fdopen(handle, "rb") as file:
        try:
            return file.read()
        except OSError:
            return None


def _held_manifest(
    path: Path, spec_id: str, content_version: str
) -> dict[str, Any] | None:
    """The manifest at `path` when it passes `check_served_manifest`, any
    `held_until` it carries reads as a date, and it names `spec_id` at
    `content_version`, else None."""
    if (data := _read_regular(path)) is None:
        return None
    return _checked_manifest(data, path, spec_id, content_version)


def _checked_manifest(
    data: bytes, path: Path, spec_id: str, content_version: str
) -> dict[str, Any] | None:
    """The manifest `data` read from `path` holds, under `_held_manifest`'s checks."""
    try:
        manifest = loads(data)
    except ValueError:
        return None
    if not isinstance(manifest, dict):
        return None
    try:
        check_served_manifest(manifest)
    except ContractError:
        logger.debug("dfo cache: %s is not a manifest; skipped", path)
        return None
    retention = manifest.get("retention")
    held = retention.get("held_until") if isinstance(retention, Mapping) else None
    if held is not None and read_held_until(held) is None:
        logger.debug("dfo cache: %s holds an unreadable held_until; skipped", path)
        return None
    if (
        manifest["definition"]["spec_id"] != spec_id
        or manifest["content_version"] != content_version
    ):
        logger.debug("dfo cache: %s names another version; skipped", path)
        return None
    return manifest


def _touch(path: Path) -> None:
    """Mark an artifact as recently used, so eviction keeps it longest."""
    try:
        os.utime(path)
    except OSError as error:
        logger.debug("dfo cache: could not touch %s: %s", path, error)
