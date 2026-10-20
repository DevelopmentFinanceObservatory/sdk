#!/usr/bin/env python3
"""Sync `contract/` from a spec-kit checkout, or check that it is in sync.

The client contract is package data of `dfo_client_contract`, kept in the spec-kit
repository at `python/client-contract/src/dfo_client_contract/`. Both clients read
a copy of it from `contract/`, and `contract/SOURCE` records the spec-kit commit
the copy came from.

    scripts/sync_contract.py PATH_TO_SPEC_KIT           copy and write SOURCE
    scripts/sync_contract.py PATH_TO_SPEC_KIT --check   exit 1 on any difference

Python modules and bytecode in the package are code, not contract, and stay out of
the copy. `contract/README.md` belongs to this repository and is left alone.
"""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONTRACT = ROOT / "contract"
PACKAGE_DATA = Path("python/client-contract/src/dfo_client_contract")
OWN_FILES = frozenset({"README.md", "SOURCE"})
CODE_SUFFIXES = frozenset({".py", ".pyc", ".typed"})
IGNORED_NAMES = frozenset({".DS_Store"})


def git(checkout: Path, *args: str) -> str:
    """Run git in `checkout` and return its stripped stdout."""
    result = subprocess.run(
        ["git", "-C", str(checkout), *args],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def is_contract_file(path: Path) -> bool:
    """Whether a package file is contract data rather than code."""
    return (
        path.name not in IGNORED_NAMES
        and path.suffix not in CODE_SUFFIXES
        and "__pycache__" not in path.parts
    )


def list_files(root: Path, *, own: frozenset[str] = frozenset()) -> set[Path]:
    """Relative paths of the contract files under `root`."""
    return {
        path.relative_to(root)
        for path in root.rglob("*")
        if path.is_file()
        and is_contract_file(path.relative_to(root))
        and path.relative_to(root).as_posix() not in own
    }


def differences(source_dir: Path, source_rev: str) -> list[str]:
    """Describe every way `contract/` differs from the checkout."""
    wanted = list_files(source_dir, own=OWN_FILES)
    present = list_files(CONTRACT, own=OWN_FILES)
    problems = [f"missing: {path}" for path in sorted(wanted - present)]
    problems += [f"extra: {path}" for path in sorted(present - wanted)]
    problems += [
        f"differs: {path}"
        for path in sorted(wanted & present)
        if (source_dir / path).read_bytes() != (CONTRACT / path).read_bytes()
    ]
    source_file = CONTRACT / "SOURCE"
    recorded = source_file.read_text().strip() if source_file.exists() else None
    if recorded != source_rev:
        problems.append(f"SOURCE is {recorded}, the checkout is at {source_rev}")
    return problems


def sync(source_dir: Path, source_rev: str) -> None:
    """Make `contract/` match the checkout and record its revision."""
    wanted = list_files(source_dir, own=OWN_FILES)
    for path in list_files(CONTRACT, own=OWN_FILES) - wanted:
        (CONTRACT / path).unlink()
    for path in wanted:
        target = CONTRACT / path
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source_dir / path, target)
    for directory in sorted(CONTRACT.rglob("*"), reverse=True):
        if directory.is_dir() and not any(directory.iterdir()):
            directory.rmdir()
    (CONTRACT / "SOURCE").write_text(f"{source_rev}\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("spec_kit", type=Path, help="path to a spec-kit checkout")
    parser.add_argument(
        "--check",
        action="store_true",
        help="exit 1 on any difference instead of writing",
    )
    parser.add_argument(
        "--allow-dirty",
        action="store_true",
        help="sync from a checkout with uncommitted changes to the package data",
    )
    args = parser.parse_args()

    source_dir = args.spec_kit / PACKAGE_DATA
    if not source_dir.is_dir():
        parser.error(f"{source_dir} is not a directory")
    source_rev = git(args.spec_kit, "rev-parse", "HEAD")

    if args.check:
        problems = differences(source_dir, source_rev)
        for problem in problems:
            print(problem, file=sys.stderr)
        return 1 if problems else 0

    dirty = git(args.spec_kit, "status", "--porcelain", "--", str(PACKAGE_DATA))
    if dirty and not args.allow_dirty:
        parser.error(
            f"{PACKAGE_DATA} has uncommitted changes, so SOURCE would name a "
            "revision that does not hold them; commit first or pass --allow-dirty"
        )
    sync(source_dir, source_rev)
    print(f"synced {len(list_files(source_dir, own=OWN_FILES))} files at {source_rev}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
