"""The download cache: artifacts by digest, manifests by built version and rendering.

The layout follows the contract's cache-layout rule (`contract/rules/README.md`), so
clients that implement cache1 read the others' entries. An entry is written to a
temporary name in its own directory and renamed into place, so a reader never sees a
partial entry.
Entries are keyed by content, so two processes writing one artifact write the same
bytes and need no lock. Concurrent manifest updates can lose a cache candidate,
but never make an artifact name different bytes. A read re-hashes an artifact, and
a mismatch is a miss.

Both clients call this module. It is sync and works on local files only.
"""

import hashlib
import json
import logging
import os
import tempfile
from collections.abc import Mapping
from os import PathLike
from pathlib import Path, PurePosixPath
from typing import Any

from dfo._config.paths import cache_directory
from dfo._core.types import CONTENT_VERSION, DIGEST, SPEC_ID, Rendering

logger = logging.getLogger("dfo")

# The default bound on the artifacts the cache keeps, in bytes.
DEFAULT_MAX_BYTES = 2 * 1024**3


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
        self.directory = Path(cache_directory(cache_dir, env=env))
        self.enabled = enabled
        self.max_bytes = max_bytes

    def get_bytes(self, digest: str, /) -> bytes | None:
        """The artifact with `digest`, or None when it is absent or its bytes differ."""
        if not self.enabled:
            return None
        path = self.directory / file_entry(digest)
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
        if not self.enabled:
            return
        if sha256_digest(data) != digest:
            raise ValueError(f"the bytes do not hash to {digest}")
        path = self.directory / file_entry(digest)
        if _write(path, data, digest=digest):
            self._evict(keep=path)

    def get_manifest(
        self, spec_id: str, content_version: str, rendering: Rendering, /
    ) -> dict[str, Any] | None:
        """The stored manifest of a built version's rendering, or None."""
        if not self.enabled:
            return None
        return _read_json(
            self.directory / manifest_entry(spec_id, content_version, rendering)
        )

    def put_manifest(
        self,
        spec_id: str,
        content_version: str,
        rendering: Rendering,
        manifest: Mapping[str, Any],
        /,
    ) -> None:
        """Store a built version's manifest for one rendering."""
        if not self.enabled:
            return
        path = self.directory / manifest_entry(spec_id, content_version, rendering)
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

        Invalid or partial manifest files are omitted. Callers that need an
        artifact still verify its bytes before choosing a candidate.
        """
        if not self.enabled:
            return []
        if SPEC_ID.fullmatch(spec_id) is None:
            raise ValueError(f"{spec_id!r} is not a spec id")
        found: list[tuple[str, dict[str, Any]]] = []
        name = f"{rendering_name(rendering)}.json"
        for path in sorted((self.directory / "manifests" / spec_id).glob(f"*/{name}")):
            manifest = _read_json(path)
            if manifest is not None and isinstance(manifest.get("prepared_at"), str):
                found.append((manifest["prepared_at"], manifest))
        return [
            manifest
            for _, manifest in sorted(found, key=lambda item: item[0], reverse=True)
        ]

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


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_bytes())
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _touch(path: Path) -> None:
    """Mark an artifact as recently used, so eviction keeps it longest."""
    try:
        os.utime(path)
    except OSError as error:
        logger.debug("dfo cache: could not touch %s: %s", path, error)
