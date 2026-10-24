"""Helpers the code generators share for formatting their output and writing or checking it."""

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _ruff() -> list[str]:
    """Return the command that runs ruff, preferring the one on PATH."""
    if found := shutil.which("ruff"):
        return [found]
    return [sys.executable, "-m", "ruff"]


def _format_python(source: str, path: Path) -> str:
    """Sort imports and format `source` as ruff would for a file at `path`."""
    ruff = _ruff()
    for args in (
        ["check", "--fix-only", "--select", "I", "--exit-zero"],
        ["format"],
    ):
        source = subprocess.run(
            [*ruff, *args, "--stdin-filename", str(path), "-"],
            input=source,
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    return source


def write_or_check(path: Path, source: str, *, check: bool) -> bool:
    """Format the Python `source` as ruff would for `path` and write it there, or in
    check mode report whether the file differs.

    Returns:
        True when the file on disk differs from the formatted source (before any
        write).

    Raises:
        subprocess.CalledProcessError: ruff could not run or refused the source.
    """
    text = _format_python(source, path)
    current = path.read_text(encoding="utf-8") if path.exists() else None
    if current == text:
        return False
    if not check:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")
    return True


def relative(path: Path) -> str:
    """Name `path` relative to the repository root."""
    return path.relative_to(ROOT).as_posix()
