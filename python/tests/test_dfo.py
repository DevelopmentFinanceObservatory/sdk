"""Tests for the package skeleton."""

import subprocess
import sys
from importlib.metadata import version

import dfo


def test_version_matches_the_distribution() -> None:
    """`dfo.__version__` and the `development-finance` metadata agree."""
    assert dfo.__version__ == version("development-finance")


def test_import_leaves_pyarrow_unloaded() -> None:
    """`import dfo` defers pyarrow to the first call that reads or builds a table.

    A fresh interpreter runs the import, since this process has loaded pyarrow
    through other tests.
    """
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys, dfo; print('pyarrow' in sys.modules, 'dfo' in sys.modules)",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    assert result.stdout.split() == ["False", "True"]
