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
from the server again. The citation text is read back as stored. A key that is not a
server id, such as a malformed digest in a served manifest, is a miss on read and
skipped on write.

Concurrent fetches in one process download an artifact once: `downloading`
holds its digest while the first fetch reads the cache, downloads and stores,
and the others then read the stored file.

Both clients call this module. It works on local files only.
"""

import hashlib
import json
import logging
import os
import tempfile
from collections.abc import Mapping
from contextlib import nullcontext
from os import PathLike
from pathlib import Path, PurePosixPath
from typing import Any

from dfo._config.paths import cache_directory
from dfo._core.codes import INVALID_ARGUMENT
from dfo._core.errors import ContractError, client_error
from dfo._core.json_text import loads
from dfo._core.types import CONTENT_VERSION, DIGEST, SPEC_ID, Rendering
from dfo._datasets.build import check_served_manifest, read_held_until
from dfo._http.hooks import Hold, KeyedLock

logger = logging.getLogger("dfo")

# The default bound on the artifacts the cache keeps, in bytes.
DEFAULT_MAX_BYTES = 2 * 1024**3

# The artifacts being downloaded into any cache of this process, by path.
_DOWNLOADS = KeyedLock()


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


def sha256_digest(data: bytes, /) -> str:
    """The digest of `data` as the server writes it, `sha256:<hex>`."""
    return "sha256:" + hashlib.sha256(data).hexdigest()


class Cache:
    """The cache one client reads and writes.

    A disabled cache misses every read and drops every write. An entry the disk
    refuses is logged to the `dfo` logger and skipped, so a write cannot fail a
    fetch.

    Attributes:
        directory: The cache directory, `<root>/v1/dfo/cache1`.
        enabled: Whether the cache reads and writes entries.
        max_bytes: The bound on the artifacts kept; the least recently used go
            first.
    """

    __slots__ = ("directory", "enabled", "max_bytes")

    def __init__(
        self,
        cache_dir: str | PathLike[str] | None = None,
        *,
        enabled: bool = True,
        max_bytes: int = DEFAULT_MAX_BYTES,
        env: Mapping[str, str] | None = None,
    ) -> None:
        env = os.environ if env is None else env
        self.directory = cache_path(cache_dir, env=env)
        self.enabled = enabled
        self.max_bytes = max_bytes

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
        if not self.enabled:
            return nullcontext()
        return _DOWNLOADS.hold((str(self.directory), digest), timeout=timeout)

    def get_bytes(self, digest: str, /) -> bytes | None:
        """The artifact with `digest`, or None when it is absent or its bytes differ."""
        if not self.enabled or (path := self._file(digest)) is None:
            return None
        try:
            data = path.read_bytes()
        except OSError:  # absent, or a cache directory the disk refuses
            return None
        if sha256_digest(data) != digest:
            return None
        _touch(path)
        return data

    def put_bytes(self, digest: str, data: bytes, /) -> None:
        """Store an artifact under its digest, then evict down to `max_bytes`.

        Raises:
            ValueError: `data` does not hash to `digest`.
        """
        if not self.enabled or (path := self._file(digest)) is None:
            return
        if sha256_digest(data) != digest:
            raise ValueError(f"the bytes do not hash to {digest}")
        if _write(path, data, digest=digest):
            self._evict(keep=path)

    def discard(self, digest: str, /) -> None:
        """Remove the artifact with `digest`, whose bytes hash right but do not read.

        A manifest that lists it stays, and its next fetch downloads the artifact
        again.
        """
        if not self.enabled or (path := self._file(digest)) is None:
            return
        try:
            path.unlink(missing_ok=True)
        except OSError as error:
            logger.warning("dfo cache: could not remove %s: %s", path, error)

    def get_manifest(
        self, spec_id: str, content_version: str, rendering: Rendering, /
    ) -> dict[str, Any] | None:
        """The stored manifest of a built version's rendering, or None.

        None also when the file does not pass `check_served_manifest`, holds a
        `held_until` that does not read as a date, or names another spec or
        version than its path.
        """
        path = self._manifest(spec_id, content_version, rendering)
        if not self.enabled or path is None:
            return None
        return _held_manifest(path, spec_id, content_version)

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
        if not self.enabled or path is None:
            return
        _write(path, json.dumps(manifest, ensure_ascii=False).encode())

    def latest_manifest(
        self, spec_id: str, rendering: Rendering, /
    ) -> dict[str, Any] | None:
        """The cached manifest of a spec's newest version in one rendering, or None.

        Newest is the latest `prepared_at`. An offline fetch of a spec with no
        version returns it, marked stale.
        """
        candidates = self.manifest_candidates(spec_id, rendering)
        return candidates[0] if candidates else None

    def manifest_candidates(
        self, spec_id: str, rendering: Rendering, /
    ) -> list[dict[str, Any]]:
        """Cached manifests of a spec in one rendering, newest first.

        Manifest files that `get_manifest` would not return, and those with no
        `prepared_at`, are omitted. Callers that need an artifact still verify its
        bytes before choosing a candidate.
        """
        if not self.enabled or SPEC_ID.fullmatch(spec_id) is None:
            return []
        found: list[tuple[str, dict[str, Any]]] = []
        name = f"{rendering_name(rendering)}.json"
        for path in sorted((self.directory / "manifests" / spec_id).glob(f"*/{name}")):
            manifest = _held_manifest(path, spec_id, path.parent.name)
            if manifest is not None and isinstance(manifest.get("prepared_at"), str):
                found.append((manifest["prepared_at"], manifest))
        return [
            manifest
            for _, manifest in sorted(found, key=lambda item: item[0], reverse=True)
        ]

    def _file(self, digest: str) -> Path | None:
        """The artifact's path, or None when `digest` is not a sha256 digest."""
        if DIGEST.fullmatch(digest) is None:
            logger.debug("dfo cache: %r is not a digest; skipped", digest)
            return None
        return self.directory / file_entry(digest)

    def _manifest(
        self, spec_id: str, content_version: str, rendering: Rendering
    ) -> Path | None:
        """The manifest's path, or None when the ids are not server ids."""
        if SPEC_ID.fullmatch(spec_id) is None or (
            CONTENT_VERSION.fullmatch(content_version) is None
        ):
            logger.debug(
                "dfo cache: %r at %r is not a spec version; skipped",
                spec_id,
                content_version,
            )
            return None
        return self.directory / manifest_entry(spec_id, content_version, rendering)

    def _evict(self, *, keep: Path) -> None:
        files = self.directory / "files"
        entries: list[tuple[float, int, Path]] = []
        for path in files.glob("sha256/*"):
            if path.name.startswith("."):
                continue
            try:
                stat = path.stat()
            except FileNotFoundError:
                continue
            entries.append((stat.st_mtime, stat.st_size, path))
        total = sum(size for _, size, _ in entries)
        for _, size, path in sorted(entries, key=lambda entry: entry[0]):
            if total <= self.max_bytes:
                break
            if path == keep:
                continue
            path.unlink(missing_ok=True)
            total -= size


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
    try:
        return sha256_digest(path.read_bytes()) == digest
    except OSError:
        return False


def _held_manifest(
    path: Path, spec_id: str, content_version: str
) -> dict[str, Any] | None:
    """The manifest at `path` when it passes `check_served_manifest`, any
    `held_until` it carries reads as a date, and it names `spec_id` at
    `content_version`, else None."""
    manifest = _read_json(path)
    if manifest is None:
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


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = loads(path.read_bytes())
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _touch(path: Path) -> None:
    """Mark an artifact as recently used, so eviction keeps it longest."""
    try:
        os.utime(path)
    except OSError as error:
        logger.debug("dfo cache: could not touch %s: %s", path, error)
