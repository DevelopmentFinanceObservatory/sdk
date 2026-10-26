"""Tests for the build request bodies, the scope mapping and operation reading."""

import pytest

from dfo._core.errors import ContractError, InvalidRequestError
from dfo._core.types import Rendering, Spec
from dfo._datasets.build import (
    read_operation,
    rebind,
    rendering_for,
    scope,
)
from tests._fetch_support import OP_ID, operation


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


@pytest.mark.parametrize(
    "window",
    [
        "2020",
        (2020,),
        (2020, "2023"),
        (True, 2023),
        (2023, 2020),
        (2020, 2**53),
        (-(2**53), 2020),
    ],
)
def test_a_malformed_window_is_refused(window) -> None:
    with pytest.raises(InvalidRequestError, match="window") as caught:
        scope(window=window)
    assert caught.value.code == "invalid_argument"


@pytest.mark.parametrize(
    "narrowing",
    [
        {"entities": {"recipient": "country/NGA"}},
        {"entities": {"recipient": 5}},
        {"entities": {"recipient": [None]}},
        {"entities": {"recipient": [""]}},
        {"entities": {"recipient": []}},
        {"entities": {5: ["country/NGA"]}},
        {"entities": ["recipient"]},
        {"facets": "unit"},
        {"facets": {"unit": 5}},
        {"facets": {"unit": ""}},
        {"facets": {"": "unit/USD"}},
    ],
)
def test_a_malformed_entity_or_facet_binding_is_refused(narrowing) -> None:
    with pytest.raises(InvalidRequestError) as caught:
        scope(**narrowing)
    assert caught.value.code == "invalid_argument"


def test_rebinding_a_spec_without_an_identity_is_refused() -> None:
    spec_id = "spec_" + "0" * 32
    spec = Spec(spec_id, {"spec_id": spec_id})
    with pytest.raises(InvalidRequestError) as caught:
        rebind(spec, {"origin": ["country/DEU"]})
    assert caught.value.code == "invalid_argument"


def test_each_layout_builds_bare_parquet() -> None:
    assert rendering_for("long") == Rendering("parquet", False)
    assert rendering_for("frame") == Rendering("parquet", False, "frame")
    with pytest.raises(InvalidRequestError, match="layout") as caught:
        rendering_for("wide")
    assert caught.value.code == "invalid_argument"


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
    with pytest.raises(ContractError) as caught:
        read_operation(operation("paused"))
    assert caught.value.pointer == "/operation/status"


def test_a_done_operation_without_a_manifest_raises() -> None:
    with pytest.raises(ContractError):
        read_operation(operation("done"))
