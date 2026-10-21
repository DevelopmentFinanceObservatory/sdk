#!/usr/bin/env python3
"""Fetch `contract/` from spec-kit at the commit `contract/SOURCE` names.

The client contract is package data of `dfo_client_contract`, kept in the spec-kit
repository at `python/client-contract/src/dfo_client_contract/`, and the rules it
states are that package's `python/client-contract/README.md`. Both clients read a
copy of them from `contract/`, the README as `contract/README.md`. The repository
commits only `contract/SOURCE`, the spec-kit commit; this script fetches the rest
from the GitHub archive of that commit and records it in `contract/.synced`, so a
second run with the same SOURCE does nothing.

    scripts/sync_contract.py                            fetch spec-kit at SOURCE
    scripts/sync_contract.py --from PATH_TO_SPEC_KIT    copy a checkout, write SOURCE

The `--from` form serves a contract change that is not pushed to spec-kit yet.
Python modules and bytecode in the package are code and stay out of the copy.
Each run builds the new copy in a scratch directory beside `contract/` and swaps
it into place, so a failed run leaves the old copy as it was.
"""

import argparse
import http.client
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from collections.abc import Callable
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parent.parent
CONTRACT = ROOT / "contract"
MARKER = ".synced"
ARCHIVE = (
    "https://github.com/DevelopmentFinanceObservatory/spec-kit/archive/{rev}.tar.gz"
)
PACKAGE_DATA = PurePosixPath("python/client-contract/src/dfo_client_contract")
PACKAGE_README = PurePosixPath("python/client-contract/README.md")
OWN_FILES = frozenset({"README.md", "SOURCE", MARKER})
CODE_SUFFIXES = frozenset({".py", ".pyc", ".typed"})
IGNORED_NAMES = frozenset({".DS_Store"})
TIMEOUT_SECONDS = 60
FETCH_COMMAND = "uv run --no-project --python '>=3.12' scripts/sync_contract.py"
SHA_RE = re.compile(r"[0-9a-f]{40}")


class FetchError(Exception):
    """`contract/` could not be brought to the commit SOURCE names."""


def git(checkout: Path, *args: str) -> str:
    """Run git in `checkout` and return its stripped stdout."""
    result = subprocess.run(
        ["git", "-C", str(checkout), *args],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def is_contract_file(path: PurePosixPath) -> bool:
    """Whether a package file is contract data and belongs in the copy."""
    return (
        path.name not in IGNORED_NAMES
        and path.suffix not in CODE_SUFFIXES
        and "__pycache__" not in path.parts
        and path.as_posix() not in OWN_FILES
    )


def destination(path: PurePosixPath) -> PurePosixPath | None:
    """Where a spec-kit file lands in the copy, or None when it stays out."""
    if path == PACKAGE_README:
        return PurePosixPath("README.md")
    if not path.is_relative_to(PACKAGE_DATA):
        return None
    relative = path.relative_to(PACKAGE_DATA)
    return relative if is_contract_file(relative) else None


def recorded(name: str) -> str | None:
    """The commit a file in `contract/` records, or None when it is missing."""
    path = CONTRACT / name
    return path.read_text().strip() if path.is_file() else None


def source_rev() -> str:
    """The spec-kit commit `contract/SOURCE` names.

    Raises:
        FetchError: SOURCE is missing, or does not hold a full commit SHA.
    """
    if not (rev := recorded("SOURCE")):
        raise FetchError(f"{CONTRACT / 'SOURCE'} is missing or empty")
    if not SHA_RE.fullmatch(rev):
        raise FetchError(f"{CONTRACT / 'SOURCE'} must hold a full commit SHA: {rev!r}")
    return rev


def is_current(rev: str) -> bool:
    """Whether `contract/` holds the copy of the commit `rev`."""
    return recorded(MARKER) == rev


def install(rev: str, fill: Callable[[Path], int]) -> int:
    """Build a copy with `fill`, record `rev` in it, and swap it in for `contract/`.

    Returns:
        The number of files `fill` wrote.
    """
    with tempfile.TemporaryDirectory(dir=CONTRACT.parent, prefix=".contract-") as tmp:
        staged = Path(tmp) / "contract"
        staged.mkdir()
        count = fill(staged)
        (staged / "SOURCE").write_text(f"{rev}\n")
        (staged / MARKER).write_text(f"{rev}\n")
        previous = Path(tmp) / "previous"
        replacing = CONTRACT.exists()
        if replacing:
            CONTRACT.rename(previous)
        try:
            staged.rename(CONTRACT)
        except OSError:
            if replacing:
                previous.rename(CONTRACT)
            raise
    return count


def extract(archive: tarfile.TarFile, target: Path) -> int:
    """Extract the contract files of a spec-kit archive into `target`."""
    count = 0
    for member in archive:
        # The archive holds one top-level directory, `spec-kit-<rev>/`.
        _, _, inner = member.name.partition("/")
        landing = destination(PurePosixPath(inner))
        if landing is None or not member.isfile():
            continue
        renamed = member.replace(name=landing.as_posix(), deep=False)
        archive.extract(renamed, target, filter="data")
        count += 1
    return count


def fetch(rev: str) -> int:
    """Replace `contract/` with the contract files of spec-kit at `rev`.

    Returns:
        The number of files fetched, the README included.

    Raises:
        FetchError: the download or the extraction failed, or found no files.
    """
    url = ARCHIVE.format(rev=rev)

    def fill(target: Path) -> int:
        try:
            with (
                urllib.request.urlopen(url, timeout=TIMEOUT_SECONDS) as response,
                tarfile.open(fileobj=response, mode="r|gz") as archive,
            ):
                count = extract(archive, target)
        except (OSError, http.client.HTTPException, tarfile.TarError) as error:
            raise FetchError(
                f"could not fetch the client contract from {url}: {error}"
            ) from error
        if not (target / "README.md").is_file() or count < 2:
            raise FetchError(f"{url} holds no {PACKAGE_README} or no {PACKAGE_DATA}")
        return count

    return install(rev, fill)


def ensure_current() -> int | None:
    """Fetch `contract/` unless it already holds the commit SOURCE names.

    Returns:
        The number of files fetched, or None when the copy is current.

    Raises:
        FetchError: SOURCE or the fetch failed; the message names the command to
            rerun.
    """
    try:
        rev = source_rev()
        if is_current(rev):
            return None
        print(f"fetching contract/ from spec-kit at {rev}", file=sys.stderr)
        return fetch(rev)
    except FetchError as error:
        raise FetchError(
            f"{error}; run `{FETCH_COMMAND}` from the repository root to retry"
        ) from error


def require_current() -> None:
    """Make `contract/` current for a script, exiting with the error when it fails."""
    try:
        ensure_current()
    except FetchError as error:
        sys.exit(str(error))


def copy_checkout(spec_kit: Path, rev: str) -> int:
    """Replace `contract/` with the contract files of a spec-kit checkout.

    Returns:
        The number of files copied, the README included.
    """

    def fill(target: Path) -> int:
        shutil.copyfile(spec_kit / PACKAGE_README, target / "README.md")
        count = 1
        for path in sorted((spec_kit / PACKAGE_DATA).rglob("*")):
            landing = destination(PurePosixPath(path.relative_to(spec_kit).as_posix()))
            if landing is None or not path.is_file():
                continue
            (target / landing).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target / landing)
            count += 1
        return count

    return install(rev, fill)


def main(argv: list[str] | None = None) -> int:
    """Fetch or copy `contract/` and return the exit status."""
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument(
        "--from",
        dest="checkout",
        type=Path,
        metavar="PATH_TO_SPEC_KIT",
        help="copy from a spec-kit checkout and write its HEAD to SOURCE",
    )
    parser.add_argument(
        "--allow-dirty",
        action="store_true",
        help="with --from, copy a checkout with uncommitted changes to the package",
    )
    args = parser.parse_args(argv)

    if args.checkout is None:
        if args.allow_dirty:
            parser.error("--allow-dirty applies to --from only")
        try:
            count = ensure_current()
        except FetchError as error:
            print(error, file=sys.stderr)
            return 1
        rev = source_rev()
        if count is None:
            print(f"contract/ is current at {rev}")
        else:
            print(f"fetched {count} files at {rev}")
        return 0

    spec_kit = args.checkout
    if not (spec_kit / PACKAGE_DATA).is_dir():
        parser.error(f"{spec_kit / PACKAGE_DATA} is not a directory")
    if not (spec_kit / PACKAGE_README).is_file():
        parser.error(f"{spec_kit / PACKAGE_README} is not a file")
    dirty = git(
        spec_kit, "status", "--porcelain", "--", str(PACKAGE_DATA), str(PACKAGE_README)
    )
    if dirty and not args.allow_dirty:
        parser.error(
            f"{PACKAGE_DATA} or {PACKAGE_README} has uncommitted changes, so "
            "SOURCE would name a revision that does not hold them; commit first or "
            "pass --allow-dirty"
        )
    rev = git(spec_kit, "rev-parse", "HEAD")
    count = copy_checkout(spec_kit, rev)
    print(f"copied {count} files at {rev}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
