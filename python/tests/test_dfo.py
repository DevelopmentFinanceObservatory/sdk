"""Tests for the package skeleton."""

from importlib.metadata import version

import dfo


def test_version_matches_the_distribution() -> None:
    """`dfo.__version__` and the `development-finance` metadata agree."""
    assert dfo.__version__ == version("development-finance")
