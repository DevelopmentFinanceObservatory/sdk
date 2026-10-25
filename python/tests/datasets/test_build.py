"""Tests for the build request bodies, the scope mapping and operation reading."""

import pytest

from dfo._core.errors import ContractError, InvalidRequestError
from dfo._core.types import Rendering, Spec
from dfo._datasets.build import (
    Reading,
    narrowings,
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
            {"window": (1000, 2200)},
            {"window": {"kind": "range", "start_year": 1000, "end_year": 2200}},
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
        (999, 2020),
        (2020, 2201),
    ],
)
def test_a_malformed_window_is_refused(window) -> None:
    with pytest.raises(InvalidRequestError, match="window") as caught:
        scope(window=window)
    assert caught.value.code == "invalid_argument"


@pytest.mark.parametrize(
    ("window", "advice"),
    [
        (2022, "; for one year use window=(2022, 2022)."),
        ("2022", "; for one year use window=(2022, 2022)."),
        ([2022], "; for one year use window=(2022, 2022)."),
        (("2022",), "; for one year use window=(2022, 2022)."),
        ("twenty", "."),
        ((0, 3000), "window years run from 1000 to 2200, not (0, 3000)."),
        ((2021, 2019), "start_year first, not (2021, 2019)."),
    ],
)
def test_a_refused_window_names_the_window_to_pass(window, advice) -> None:
    with pytest.raises(InvalidRequestError) as caught:
        scope(window=window)
    assert caught.value.code == "invalid_argument"
    assert str(caught.value).endswith(f"{advice} [invalid_argument]")


@pytest.mark.parametrize(
    "narrowing",
    [
        {"entities": {"recipient": "country/NGA"}},
        {"entities": {"recipient": 5}},
        {"entities": {"recipient": [None]}},
        {"entities": {"recipient": [""]}},
        {"entities": {"recipient": [" \t"]}},
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


def _spec(number: int, **identity: object) -> Spec:
    spec_id = f"spec_{number:032x}"
    return Spec(spec_id, {"spec_id": spec_id, "identity": identity})


FLOW = _spec(1, entities={"destination": ["country/NGA"]})
PLACE = _spec(2, entities={"observationAbout": ["country/KEN"]})


@pytest.mark.parametrize(
    ("spec", "roles"),
    [
        # A flow spec takes both flow axes, the one it leaves open as None.
        (FLOW, {"destination": ("country/NGA",), "origin": None}),
        (
            _spec(3, entities={"origin": ["country/DEU"]}, open_roles=["destination"]),
            {"origin": ("country/DEU",), "destination": None},
        ),
        (PLACE, {"observationAbout": ("country/KEN",)}),
        (_spec(4, entities={}), {}),
        (Spec("spec_" + "5" * 32, {"spec_id": "spec_" + "5" * 32}), {}),
    ],
    ids=["flow", "flow-open-role", "place", "no-role", "no-identity"],
)
def test_a_spec_lists_the_role_keys_entities_takes(spec, roles) -> None:
    assert spec.roles == roles


def test_one_narrowing_rebinds_each_reading_on_its_own_binding() -> None:
    other = _spec(6, entities={"destination": ["country/KEN"], "origin": ["DAC"]})
    scopes = narrowings(
        [Reading(("ODA",), FLOW), Reading(("aid",), other)],
        window="latest",
        entities={"origin": ["country/FRA"]},
    )
    assert scopes == [
        {
            "window": {"kind": "latest"},
            "entities": {"destination": ["country/NGA"], "origin": ["country/FRA"]},
        },
        {
            "window": {"kind": "latest"},
            "entities": {"destination": ["country/KEN"], "origin": ["country/FRA"]},
        },
    ]


@pytest.mark.parametrize(
    ("readings", "message"),
    [
        (
            [Reading((), FLOW)],
            'entities names "financingRecipient", a role the spec does not '
            "declare; its roles are destination, origin. [invalid_argument]",
        ),
        (
            [Reading(("ODA",), FLOW), Reading(("GDP",), PLACE)],
            'entities names "financingRecipient", a role "ODA" and "GDP" do not '
            'declare. Each part\'s roles:\n  "ODA": destination, origin\n  '
            '"GDP": observationAbout\n[invalid_argument]',
        ),
    ],
    ids=["spec", "answer"],
)
def test_a_role_a_reading_does_not_declare_is_refused_naming_its_roles(
    readings, message
) -> None:
    with pytest.raises(InvalidRequestError) as caught:
        narrowings(readings, entities={"financingRecipient": ["country/KEN"]})
    assert caught.value.code == "invalid_argument"
    assert str(caught.value) == message


def test_a_role_one_part_lacks_names_that_part() -> None:
    with pytest.raises(InvalidRequestError) as caught:
        narrowings(
            [Reading(("ODA",), FLOW), Reading(("GDP",), PLACE)],
            entities={"origin": ["country/DEU"]},
        )
    assert str(caught.value).startswith(
        'entities names "origin", a role "GDP" does not declare.'
    )


def test_each_layout_builds_bare_parquet() -> None:
    assert rendering_for("long", party_totals=True) == Rendering("parquet", False)
    assert rendering_for("frame", party_totals=True) == Rendering(
        "parquet", False, "frame"
    )
    assert rendering_for("long", party_totals=False) == Rendering(
        "parquet", False, without_party_totals=True
    )
    for layout, party_totals in (("wide", True), ("long", 1)):
        with pytest.raises(InvalidRequestError) as caught:
            rendering_for(layout, party_totals=party_totals)  # ty: ignore[invalid-argument-type]
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
