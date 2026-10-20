"""Tests for the build request bodies, the scope mapping and operation reading."""

import pytest

from dfo._build import (
    read_operation,
    rendering_for,
    scope,
)
from dfo._errors import ContractError
from dfo._types import Rendering

from ._fetch_support import OP_ID, operation


@pytest.mark.parametrize(
    ("narrowing", "expected"),
    [
        ({}, None),
        ({"window": "all"}, {"window": {"kind": "all"}}),
        ({"window": "latest"}, {"window": {"kind": "latest"}}),
        (
            {"window": (2020, 2023)},
            {"window": {"kind": "range", "start_year": 2020, "end_year": 2023}},
        ),
        (
            {"entities": {"recipient": ("country/NGA", "country/KEN")}},
            {"entities": {"recipient": ["country/NGA", "country/KEN"]}},
        ),
        (
            {"facets": {"provenance": "provenance/X", "unit": None}},
            {"facets": {"provenance": {"ref": "provenance/X"}, "unit": {"ref": None}}},
        ),
    ],
)
def test_narrowing_maps_to_the_build_scope(narrowing, expected) -> None:
    assert scope(**narrowing) == expected


@pytest.mark.parametrize("window", ["2020", (2020,), (2020, "2023"), (True, 2023)])
def test_a_malformed_window_is_refused(window) -> None:
    with pytest.raises(ValueError, match="window"):
        scope(window=window)


def test_a_role_bound_to_a_string_is_refused() -> None:
    with pytest.raises(TypeError, match=r"\['country/NGA'\]"):
        scope(entities={"recipient": "country/NGA"})


def test_each_layout_builds_bare_parquet() -> None:
    assert rendering_for("long") == Rendering("parquet", False)
    assert rendering_for("frame") == Rendering("parquet", False, "frame")
    with pytest.raises(ValueError, match="layout"):
        rendering_for("wide")


def test_an_operation_reads_its_pacing_and_progress() -> None:
    state = read_operation(
        operation("running", retry_after_ms=2500, progress={"rows_written": 3})
    )
    assert (state.operation_id, state.status, state.retry_after) == (
        OP_ID,
        "running",
        2.5,
    )
    assert state.progress is not None
    assert (state.progress.rows_written, state.progress.estimate_rows) == (3, None)
    assert read_operation(operation("pending")).retry_after is None
    assert read_operation(operation("paused")).status == "paused"


def test_a_done_operation_without_a_manifest_raises() -> None:
    with pytest.raises(ContractError):
        read_operation(operation("done"))
