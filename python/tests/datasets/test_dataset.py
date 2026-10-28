"""Datasets from fetched members: provenance, stacking, conversions, display and saving."""

import copy
import json
import pickle
import sys
from collections.abc import Callable
from dataclasses import replace
from datetime import date, datetime
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from dfo._core.errors import ContractError
from dfo._core.parse import parse_parts
from dfo._core.refs import (
    DatasetRef,
    DerivedMember,
    DerivedRefMember,
    Member,
    ResolvedPeriod,
)
from dfo._core.types import (
    Assumption,
    CandidatesPart,
    DefinitePart,
    Departure,
    FormatError,
    Gap,
    Layout,
    Rendering,
    RequestedOperation,
)
from dfo._datasets.bundle import load as load_saved
from dfo._datasets.cache import sha256_digest
from dfo._datasets.dataset import (
    Dataset,
    FetchedMember,
    build_dataset,
    derived_dataset,
)
from tests._data import DATA, load
from tests._datasets import PARQUET, manifest, other_member, recorded_member, scenario
from tests._fetch_support import FakeCache
from tests.rule_vectors import ids, vectors

EXPECTED = scenario()["expect"][0]["dataset"]
AID_TYPE = Assumption(
    kind="declared_default",
    binding_ref="how:dac2aAidType",
    text="official development assistance",
    refs=("DAC2aAidType206",),
)


def built(*members: FetchedMember, layout: Layout = "long") -> Dataset:
    """A complete, fresh dataset of `members`, or of the recorded member."""
    return build_dataset(
        members or [recorded_member()],
        layout=layout,
        complete=True,
        missing=(),
        stale=False,
    )


def with_retention(
    member: FetchedMember, retention: dict[str, object]
) -> FetchedMember:
    body = copy.deepcopy(dict(member.manifest))
    body["retention"] = retention
    return replace(member, manifest=body)


def _parquet(table: pa.Table) -> bytes:
    sink = pa.BufferOutputStream()
    pq.write_table(table, sink)
    return sink.getvalue().to_pybytes()


def with_table(member: FetchedMember, table: pa.Table) -> FetchedMember:
    """`member` holding `table`, its manifest listing the new artifact."""
    data = _parquet(table)
    body = copy.deepcopy(dict(member.manifest))
    body["artifacts"][0]["artifact_digest"] = sha256_digest(data)
    return replace(member, manifest=body, digest=sha256_digest(data), data=data)


def test_one_member_matches_the_recorded_expectation() -> None:
    data = built()
    assert len(data) == EXPECTED["rows"]
    assert data.to_arrow().column_names == EXPECTED["columns"]
    assert data.complete is EXPECTED["complete"]
    assert data.missing == ()
    (member,) = data.members
    (expected,) = EXPECTED["members"]
    assert member.parts == tuple(expected["parts"])
    assert member.spec.spec_id == expected["spec_id"]
    assert member.content_version == expected["content_version"]
    assert member.sentence == data.sentence == expected["sentence"]
    assert member.rendering == Rendering("parquet", False)


def test_provenance_comes_from_the_manifest() -> None:
    data = built()
    assert data.citation.text == manifest()["citation"]["text"]
    assert data.sources == ("OECD Creditor Reporting System (CRS)",)
    assert data.licence == "OECD Terms and Conditions"
    assert [notice.code for notice in data.warnings] == ["coverage_below_scope"]
    assert data.layout_version == str(manifest()["artifacts"][0]["rendering"]["layout"])
    assert data.assumptions == ()
    assert data.departures == data.requested_operations == ()


def test_the_ref_holds_the_exact_version() -> None:
    data = built()
    assert data.ref is not None
    (stored,) = DatasetRef.from_json(data.ref.to_json()).members
    assert stored.digest == manifest()["artifacts"][0]["artifact_digest"]
    assert stored.content_version == manifest()["content_version"]
    assert stored.rendering == Rendering("parquet", False)


def test_the_frame_layout_names_its_rendering() -> None:
    member = recorded_member()
    member.manifest["artifacts"][0]["rendering"] = {
        "format": "parquet",
        "bundle": False,
        "layout": "frame",
    }
    data = built(member, layout="frame")
    assert data.layout_version == "frame"
    assert data.members[0].rendering == Rendering("parquet", False, "frame")


def test_the_recorded_retention_reads_its_date() -> None:
    data = built()
    held_until = manifest()["retention"]["held_until"]
    assert data.held_until == datetime.fromisoformat(held_until).date()
    assert data.pinned is False


def test_retention_absent_reads_none_and_is_not_shown() -> None:
    body = manifest()
    del body["retention"]
    data = built(recorded_member(manifest=body))
    assert data.held_until is None
    assert data.pinned is False
    assert "held until" not in repr(data).lower()
    assert "pinned" not in repr(data).lower()


def test_held_until_is_the_earliest_member_date() -> None:
    first = with_retention(
        recorded_member(), {"pinned": False, "held_until": "2026-12-01T10:00:00Z"}
    )
    second = with_retention(
        other_member(), {"pinned": False, "held_until": "2026-11-18T23:00:00+00:00"}
    )
    data = built(first, second)
    assert data.held_until == date(2026, 11, 18)
    assert data.pinned is False
    assert "held until 18 November 2026, not pinned" in repr(data)


def test_pinned_when_every_member_is_pinned() -> None:
    pinned = with_retention(recorded_member(), {"pinned": True})
    held = with_retention(
        other_member(), {"pinned": False, "held_until": "2026-11-18T00:00:00Z"}
    )
    both = built(pinned, with_retention(other_member(), {"pinned": True}))
    assert (both.pinned, both.held_until) == (True, None)
    assert "(exact), pinned" in repr(both)
    mixed = built(pinned, held)
    assert (mixed.pinned, mixed.held_until) == (False, date(2026, 11, 18))


def test_several_members_stack_with_a_part_column() -> None:
    first = recorded_member(parts=("ODA disbursements", "health ODA"))
    second = other_member()
    data = built(first, second)
    table = data.to_arrow()
    # The second member's `observationAbout` fills the subject slot, after the
    # recipient; the rest keep the recorded order.
    subject = EXPECTED["columns"].index("financingRecipient_label") + 1
    columns = list(EXPECTED["columns"])
    columns.insert(subject, "observationAbout")
    assert table.column_names == ["part", *columns]
    assert (
        table.column("part").to_pylist()
        == ["ODA disbursements; health ODA"] * 4 + ["GDP"] * 4
    )
    assert table.column("financingProvider").to_pylist()[4:] == [None] * 4
    assert table.column("observationAbout").to_pylist()[:4] == [None] * 4
    assert data.sentence == f"{first.sentence} {second.sentence}"
    assert data.sources == (
        "OECD Creditor Reporting System (CRS)",
        "World Development Indicators",
    )
    assert data.licence == "OECD Terms and Conditions; CC BY 4.0"
    assert [member.parts for member in data.members] == [first.parts, ("GDP",)]


def _vector_member(base: FetchedMember, served: dict[str, Any]) -> FetchedMember:
    """`base` holding a vector member's table as the server wrote it, under its part."""
    columns, rows = served["columns"], served["rows"]
    # The server writes every column of an empty file as text.
    table = pa.table(
        {
            name: pa.array([row[index] for row in rows], None if rows else pa.string())
            for index, name in enumerate(columns)
        }
    )
    member = with_table(base, table)
    member.manifest["coverage"]["rows"] = len(rows)
    return replace(member, parts=(served["part"],) if "part" in served else ())


@pytest.mark.parametrize("vector", vectors("reading-order"), ids=ids("reading-order"))
def test_the_reading_order_vectors(vector: dict[str, Any]) -> None:
    bases = [recorded_member(), other_member()]
    data = built(
        *(
            _vector_member(base, served)
            for base, served in zip(bases, vector["members"], strict=False)
        )
    )
    table = data.to_arrow()
    assert table.column_names == vector["columns"]
    assert [list(row.values()) for row in table.to_pylist()] == vector["rows"]


def _years(*years: int, part: list[str] | None = None) -> pa.Table:
    """A member's table of `years`, with a `part` data column when given."""
    columns = {
        "time_period": [str(year) for year in years],
        "value": [1.0] * len(years),
    }
    return pa.table({"part": part, **columns} if part else columns)


@pytest.mark.parametrize(
    ("tables", "rows"),
    [
        (
            [_years(2022, 2024), _years(2021, 2023)],
            [
                ["ODA", "2022", 1.0],
                ["ODA", "2024", 1.0],
                ["ODA", "2021", 1.0],
                ["ODA", "2023", 1.0],
            ],
        ),
        (
            [_years(2022, 2020, 2021, part=["b", "a", "b"])],
            [["2020", 1.0, "a"], ["2021", 1.0, "b"], ["2022", 1.0, "b"]],
        ),
    ],
    ids=["members-sharing-a-label", "one-member-with-a-part-column"],
)
def test_member_boundaries_come_from_the_members_not_the_part_label(
    tmp_path: Path, tables: list[pa.Table], rows: list[list[object]]
) -> None:
    """Members whose label is one keep their own rows apart, and a lone member's
    `part` column sorts as any varying column, before and after a save."""
    bases = [recorded_member(parts=("ODA",)), other_member(parts=("ODA",))]
    data = built(
        *(with_table(base, table) for base, table in zip(bases, tables, strict=False))
    )
    path = tmp_path / "saved.parquet"
    data.save(path)
    for shown in (data, load_saved(path)):
        assert [list(row.values()) for row in shown.to_arrow().to_pylist()] == rows


def test_a_table_the_reading_order_cannot_compare_is_refused() -> None:
    table = pq.read_table(PARQUET).replace_schema_metadata(None)
    table = table.append_column(
        "nested", pa.array([[index] for index in range(table.num_rows)])
    )
    with pytest.raises(ContractError) as caught:
        built(with_table(recorded_member(), table))
    assert caught.value.code == "contract_violation"


def test_the_preview_and_the_digest_keep_their_order() -> None:
    """The notebook preview leads with the reading columns, and the member's
    digest is the server file's, hashed before the columns moved."""
    member = recorded_member()
    data = built(member)
    markup = data._repr_html_()
    headers = markup.split("<thead>")[1].split("</thead>")[0]
    assert (
        headers
        == "<tr>"
        + "".join(f"<th>{name}</th>" for name in EXPECTED["columns"])
        + "</tr>"
    )
    server_order = pq.read_table(pa.BufferReader(member.data)).column_names
    assert server_order != EXPECTED["columns"]
    assert data.members[0].digest == sha256_digest(PARQUET.read_bytes())


def with_column(
    member: FetchedMember, values: pa.Array, name: str = "extra"
) -> FetchedMember:
    """`member` with a `name` column holding `values` in every row."""
    table = pq.read_table(pa.BufferReader(member.data))
    return with_table(
        member, table.append_column(name, pa.repeat(values[0], table.num_rows))
    )


@pytest.mark.parametrize(
    ("first", "second", "widened"),
    [
        (pa.array([1], pa.int32()), pa.array([2], pa.int64()), pa.int64()),
        (pa.array([1], pa.int64()), pa.array([2.5]), pa.float64()),
        (pa.array([1], pa.int32()), pa.array(["two"]), None),
    ],
    ids=["int32-int64", "int64-double", "int32-string"],
)
def test_stacking_widens_a_column_or_raises_a_contract_error(
    first: pa.Array, second: pa.Array, widened: pa.DataType | None
) -> None:
    members = [
        with_column(recorded_member(), first),
        with_column(other_member(), second),
    ]
    if widened is None:
        with pytest.raises(ContractError) as caught:
            built(*members)
        assert caught.value.code == "contract_violation"
        return
    data = built(*members)
    assert data.to_arrow().schema.field("extra").type == widened


def _recorded_table() -> pa.Table:
    return pq.read_table(PARQUET)


def _with_value(values: list[object]) -> bytes:
    table = _recorded_table()
    index = table.column_names.index("value")
    return _parquet(table.set_column(index, "value", pa.array(values)))


def _empty_as_served() -> bytes:
    """The recorded table with no rows and every column text, as the server
    writes an empty build."""
    table = _recorded_table().slice(0, 0)
    return _parquet(
        table.cast(pa.schema([(name, pa.string()) for name in table.column_names]))
    )


_GARBLED = "unexpected_response"
_MALFORMED = "contract_violation"


@pytest.mark.parametrize(
    ("data", "code"),
    [
        pytest.param(b"PAR1 not a parquet file PAR1", _GARBLED, id="garbage"),
        pytest.param(b"", _GARBLED, id="empty-file"),
        pytest.param(PARQUET.read_bytes()[:-100], _GARBLED, id="truncated"),
        pytest.param(
            PARQUET.read_bytes()[:4] + b"\xff" * 200 + PARQUET.read_bytes()[204:],
            _GARBLED,
            id="damaged-pages",
        ),
        pytest.param(
            _parquet(pa.table({"time_period": [2020], "a": [1]})),
            _MALFORMED,
            id="no-value-column",
        ),
        pytest.param(
            _parquet(pa.table({"value": [1.0]})), _MALFORMED, id="no-time-period"
        ),
        pytest.param(
            _parquet(
                pa.Table.from_arrays(
                    [pa.array([2020]), pa.array([1.0]), pa.array([2.0])],
                    names=["time_period", "value", "value"],
                )
            ),
            _MALFORMED,
            id="two-value-columns",
        ),
        pytest.param(_with_value(["x", "y", "z", "w"]), _MALFORMED, id="value-as-text"),
        pytest.param(_empty_as_served(), _MALFORMED, id="no-rows-counted-4"),
    ],
)
def test_an_artifact_that_is_not_a_dataset_raises_and_leaves_the_cache(
    data: bytes, code: str
) -> None:
    member = recorded_member(
        data=data, digest=sha256_digest(data), rendering=Rendering("parquet", False)
    )
    cache = FakeCache(files={member.digest: data})
    with pytest.raises(ContractError) as caught:
        build_dataset(
            [member],
            layout="long",
            complete=True,
            missing=(),
            stale=False,
            cache=cache,
        )
    assert caught.value.code == code
    assert member.digest in str(caught.value)
    assert cache.files == {}


def test_an_empty_artifact_whose_manifest_counts_no_rows_is_empty_and_stacks() -> None:
    data = _empty_as_served()
    body = manifest()
    body["coverage"]["rows"] = 0
    empty = recorded_member(
        data=data,
        digest=sha256_digest(data),
        rendering=Rendering("parquet", False),
        manifest=body,
    )
    assert len(built(empty)) == 0
    beside = other_member()
    stacked = built(empty, beside)
    assert len(stacked) == pq.read_table(pa.BufferReader(beside.data)).num_rows
    assert len(stacked.members) == 2


def test_a_member_file_with_a_part_column_raises_only_when_members_stack() -> None:
    held = with_column(recorded_member(), pa.array(["theirs"]), name="part")
    alone = built(held)
    assert alone.to_arrow().column("part")[0].as_py() == "theirs"
    with pytest.raises(ContractError) as caught:
        built(held, other_member())
    assert caught.value.code == "contract_violation"


def test_a_member_with_no_part_is_labelled_by_its_sentence() -> None:
    data = built(recorded_member(), other_member())
    assert data.to_arrow().column("part")[0].as_py() == recorded_member().sentence


def test_departures_operations_and_assumptions_come_from_the_answer_parts() -> None:
    (part,) = parse_parts(load("search-1.json"))
    assert isinstance(part, DefinitePart)
    departure = Departure(code="closest_match", text="The closest reading.")
    operation = RequestedOperation(verb="rank", phrase="top 5 donors")
    asked = DefinitePart(
        status=part.status,
        spec=part.spec,
        departures=(departure,),
        operations=(operation, operation),
        assumptions=(AID_TYPE, AID_TYPE),
    )
    data = built(recorded_member(answer_parts=(asked,)))
    assert data.departures == (departure,)
    assert data.requested_operations == (operation,)
    assert data.assumptions == (AID_TYPE,)


def test_a_manifest_without_the_artifact_is_refused() -> None:
    member = recorded_member()
    member.manifest["artifacts"] = member.manifest["artifacts"][1:]
    with pytest.raises(ContractError) as caught:
        built(member)
    assert caught.value.code == "contract_violation"


@pytest.mark.parametrize(
    "rendering",
    [
        Rendering("parquet", False),
        Rendering("parquet", False, without_party_totals=True),
    ],
)
def test_a_ref_member_the_manifest_does_not_list_takes_the_refs_rendering(
    rendering: Rendering,
) -> None:
    member = recorded_member(rendering=rendering)
    member.manifest["artifacts"] = member.manifest["artifacts"][1:]
    data = built(member)
    assert data.layout_version == "long"
    assert data.members[0].rendering == rendering


def test_the_frame_layout_refuses_several_members() -> None:
    with pytest.raises(ValueError, match="one member"):
        built(recorded_member(), other_member(), layout="frame")
    with pytest.raises(ValueError, match="at least one"):
        build_dataset([], layout="long", complete=True, missing=(), stale=False)


def test_to_arrow_carries_the_provenance() -> None:
    data = built()
    metadata = data.to_arrow().schema.metadata
    assert metadata[b"dfo.sentence"].decode() == data.sentence
    assert data.ref is not None
    assert metadata[b"dfo.ref"].decode() == data.ref.to_json()
    assert metadata[b"dfo.licence"] == b"OECD Terms and Conditions"
    assert b"ARROW:schema" not in metadata
    assert b"pandas" not in metadata


def test_pandas_gets_the_provenance_in_attrs() -> None:
    pytest.importorskip("pandas")
    frame = built().to_pandas()
    assert len(frame) == 4
    assert frame.attrs["sentence"] == EXPECTED["members"][0]["sentence"]
    assert frame.attrs["sources"] == ["OECD Creditor Reporting System (CRS)"]
    assert (frame.attrs["complete"], frame.attrs["missing"]) == (True, [])


def test_pandas_attrs_carry_the_parts_a_partial_fetch_left_out() -> None:
    pytest.importorskip("pandas")
    gaps = _gaps()
    data = build_dataset(
        [recorded_member()],
        layout="long",
        complete=False,
        missing=gaps,
        stale=False,
    )
    attrs = data.to_pandas().attrs
    assert attrs["complete"] is False
    assert attrs["missing"] == [
        {"kind": gap.kind, "message": gap.message} for gap in gaps
    ]


def test_polars_gets_the_table() -> None:
    polars = pytest.importorskip("polars")
    frame = built().to_polars()
    assert isinstance(frame, polars.DataFrame)
    assert frame.columns == EXPECTED["columns"]


@pytest.mark.parametrize(
    ("method", "extra"), [("to_pandas", "pandas"), ("to_polars", "polars")]
)
def test_a_missing_extra_names_itself(
    method: str, extra: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setitem(sys.modules, extra, None)
    with pytest.raises(ImportError, match=rf"development-finance\[{extra}\]"):
        getattr(built(), method)()


def test_the_arrow_stream_is_fresh_per_call() -> None:
    data = built()
    assert hasattr(pa.Table, "__arrow_c_stream__")
    first = pa.RecordBatchReader.from_stream(data).read_all()
    second = pa.RecordBatchReader.from_stream(data).read_all()
    assert first.equals(second)
    assert first.num_rows == 4


def test_pandas_reads_the_arrow_stream() -> None:
    pandas = pytest.importorskip("pandas")
    if not hasattr(pandas.DataFrame, "from_arrow"):
        pytest.skip("this pandas has no DataFrame.from_arrow")
    frame = pandas.DataFrame.from_arrow(built())
    assert list(frame.columns) == EXPECTED["columns"]
    assert len(frame) == 4


@pytest.mark.parametrize(
    "read",
    [
        list,
        lambda data: data["value"],
        lambda data: pytest.importorskip("pandas").DataFrame(data),
    ],
    ids=["iter", "index", "pandas-constructor"],
)
def test_reading_a_dataset_as_rows_or_columns_names_the_conversions(
    read: Callable[[Dataset], object],
) -> None:
    with pytest.raises(TypeError, match=r"data\.to_pandas\(\)"):
        read(built())


def test_polars_reads_the_arrow_stream() -> None:
    polars = pytest.importorskip("polars")
    frame = polars.DataFrame(built())
    assert frame.columns == EXPECTED["columns"]
    assert frame.height == 4


def test_duckdb_reads_the_arrow_stream() -> None:
    duckdb = pytest.importorskip("duckdb")
    data = built()  # noqa: F841 - DuckDB finds it by name
    assert duckdb.sql("select count(*) from data").fetchone() == (4,)


def test_a_dataset_pickles() -> None:
    data = build_dataset(
        [recorded_member(parts=("ODA",)), other_member()],
        layout="long",
        complete=False,
        missing=_gaps(),
        stale=True,
    )
    loaded = pickle.loads(pickle.dumps(data))
    _assert_same(loaded, data)


def test_save_then_load_returns_an_equal_dataset(tmp_path: Path) -> None:
    data = _saved()
    path = tmp_path / "saved.parquet"
    data.save(path)

    stored = pq.read_metadata(path).metadata
    assert stored[b"dfo.sentence"].decode() == data.sentence
    assert data.ref is not None
    assert stored[b"dfo.ref"].decode() == data.ref.to_json()
    assert b"dfo.left_out" not in stored
    _assert_same(load_saved(path), data)


def _derived(name: str = "chain") -> Dataset:
    """The derived dataset of a recorded analysis: aid per person, then its
    growth, which dropped three series over its two steps."""
    member = _derived_member(name)
    data = (DATA / f"analysis-{name}-frame.parquet").read_bytes()
    return derived_dataset(member, load(f"analysis-{name}-manifest.json"), data)


def _derived_member(name: str = "chain") -> DerivedRefMember:
    ready = load(f"analysis-{name}-ready.json")
    (member,) = DatasetRef.from_json(json.dumps(ready["ref"])).members
    assert isinstance(member, DerivedRefMember)
    return member


def test_a_derived_dataset_reads_the_left_out_series_the_manifest_serves() -> None:
    data = _derived()
    served = load("analysis-chain-manifest.json")["left_out"]
    assert [
        (s.step.verb, s.step.node, s.side, s.reason, s.rows, dict(s.coordinates))
        for s in data.left_out
    ] == [
        (
            row["step"]["verb"],
            row["step"]["node"],
            row["side"],
            row["reason"],
            row["rows"],
            row["coordinates"],
        )
        for row in served
    ]
    assert data.ref == DatasetRef((_derived_member(),))
    assert (data.held_until, data.pinned, data.layout_version) == (
        date(2026, 11, 27),
        False,
        "frame",
    )


def test_a_derived_dataset_prints_its_steps_period_and_left_out_series() -> None:
    chain, ranked = _derived(), _derived("rank")
    assert repr(chain).splitlines()[1:] == [
        "  Derived: quotient_of by financingRecipient, then growth by "
        "financingRecipient, from 2 readings",
        "  Missing data: 3 series left out · data.left_out",
        "  Version: ocv_422e3d46d9e05f9ea8027c97c0c2f58b (exact), held until 27 "
        "November 2026, not pinned",
        # A frame holds time_period as text, which a filter on 2022 would miss.
        '  Rows: 1, time_period as text, such as "2022" or "2021/2022"',
        "  Keep: data.save(path) · newest later: dfo.fetch(data.ref, latest=True)>",
    ]
    assert repr(ranked).splitlines()[1:3] == [
        "  Derived: rank by financingRecipient, limit 2, from 1 reading",
        "  Period: 2022, the newest year at least half the series hold",
    ]


@pytest.mark.parametrize(
    ("periods", "line"),
    [
        ([(0, "2024")], "Period: 2024, the newest year at least half the series hold"),
        (
            [(-4, "2020"), (0, "2024")],
            "Period: 2020 to 2024, counted back from 2024, the newest year at least "
            "half the series hold",
        ),
        (
            [(-1, "2023")],
            "Period: 2023, counted back from 2024, the newest year at least half the "
            "series hold",
        ),
    ],
    ids=["latest", "window", "before-latest"],
)
def test_the_period_line_counts_back_from_the_newest_year(
    periods: list[tuple[int, str]], line: str
) -> None:
    resolved = tuple(
        ResolvedPeriod("latest", offset, "half1", period) for offset, period in periods
    )
    data = _derived("rank")
    (member,) = data.members
    assert isinstance(member, DerivedMember)
    changed = replace(data, members=(replace(member, resolved_periods=resolved),))
    assert f"  {line}" in repr(changed).splitlines()


def test_a_derived_dataset_pickles() -> None:
    data = _derived()
    loaded = pickle.loads(pickle.dumps(data))
    _assert_same(loaded, data)
    assert repr(loaded) == repr(data)


def test_an_incomplete_left_out_list_prints_at_least() -> None:
    data = replace(_derived(), _left_out_complete=False)
    assert (
        "  Missing data: at least 3 series left out · data.left_out"
        in repr(data).splitlines()
    )


@pytest.mark.parametrize("complete", [True, False])
def test_a_derived_dataset_saves_its_ref_left_out_series_and_steps(
    tmp_path: Path, *, complete: bool
) -> None:
    data = replace(_derived(), _left_out_complete=complete)
    path = tmp_path / "derived.parquet"
    data.save(path)
    stored = pq.read_metadata(path).metadata
    assert json.loads(stored[b"dfo.ref"])["format_version"] == 2
    assert json.loads(stored[b"dfo.left_out"]) == {
        "series": load("analysis-chain-manifest.json")["left_out"],
        "complete": complete,
    }
    loaded = load_saved(path)
    _assert_same(loaded, data)
    assert repr(loaded) == repr(data)


@pytest.mark.parametrize(
    ("key", "value", "pointer"),
    [
        (b"dfo.left_out", b"{garbage", "/dfo.left_out"),
        (b"dfo.left_out", b"[]", "/dfo.left_out"),
        (b"dfo.left_out", b'{"series": []}', "/dfo.left_out/complete"),
        (
            b"dfo.left_out",
            b'{"series": [{"coordinates": {"origin": 1}}], "complete": true}',
            "/dfo.left_out/series/0/step",
        ),
        (
            b"dfo.left_out",
            b'{"series": [{"coordinates": {"origin": 1}, "step": {"verb": "s", '
            b'"node": 0}, "side": "data", "reason": "r", "rows": 1}], '
            b'"complete": true}',
            "/dfo.left_out/series/0/coordinates/origin",
        ),
        (
            b"dfo.left_out",
            b'{"series": [{"coordinates": {}, "step": {"verb": "s", "node": -1}, '
            b'"side": "data", "reason": "r", "rows": 1}], "complete": true}',
            "/dfo.left_out/series/0/step/node",
        ),
        (
            b"dfo.left_out",
            b'{"series": [{"coordinates": {}, "step": {"verb": "s", "node": 0}, '
            b'"side": "data", "reason": "r", "rows": -1}], "complete": true}',
            "/dfo.left_out/series/0/rows",
        ),
        (b"dfo.steps", b'[{"verb": "rank", "by": []}]', "/dfo.steps/0/limit"),
    ],
    ids=[
        "not-json",
        "not-an-object",
        "complete-missing",
        "step-missing",
        "value-not-text",
        "node-negative",
        "rows-negative",
        "step-limit-missing",
    ],
)
def test_a_damaged_derived_key_raises_format_error(
    tmp_path: Path, key: bytes, value: bytes, pointer: str
) -> None:
    path = tmp_path / "derived.parquet"
    _derived().save(path)
    table = pq.read_table(path)
    metadata = {**table.schema.metadata, key: value}
    pq.write_table(table.replace_schema_metadata(metadata), path)
    with pytest.raises(FormatError) as caught:
        load_saved(path)
    assert (caught.value.reason, caught.value.pointer) == ("format_invalid", pointer)


@pytest.mark.parametrize(
    ("change", "pointer"),
    [
        ({"content_version": "ocv_" + "0" * 32}, None),
        ({"left_out": {}}, "/left_out"),
        ({"left_out": [{"step": {}}]}, "/left_out/0/coordinates"),
        ({"left_out_complete": None}, "/left_out_complete"),
    ],
    ids=["another-frame", "left-out-not-a-list", "series-damaged", "complete-null"],
)
def test_a_derived_manifest_the_client_cannot_read_raises_contract_error(
    change: dict[str, Any], pointer: str | None
) -> None:
    manifest_body = {**load("analysis-chain-manifest.json"), **change}
    data = (DATA / "analysis-chain-frame.parquet").read_bytes()
    with pytest.raises(ContractError) as caught:
        derived_dataset(_derived_member(), manifest_body, data)
    assert caught.value.code == "contract_violation"
    assert getattr(caught.value, "pointer", None) == pointer


def test_a_manifest_without_left_out_reads_as_none_left_out() -> None:
    manifest_body = {
        **load("analysis-chain-manifest.json"),
        "left_out": None,
        "left_out_complete": None,
        "recipe": None,
    }
    data = (DATA / "analysis-chain-frame.parquet").read_bytes()
    dataset = derived_dataset(_derived_member(), manifest_body, data)
    assert dataset.left_out == ()
    assert "  Derived: from 2 readings" in repr(dataset).splitlines()


def _saved() -> Dataset:
    """A dataset of two members and two gaps, with every provenance member filled."""
    (part,) = parse_parts(load("search-1.json"))
    assert isinstance(part, DefinitePart)
    asked = DefinitePart(
        status=part.status,
        spec=part.spec,
        departures=(Departure(code="closest_match", text="The closest reading."),),
        operations=(RequestedOperation(verb="rank", phrase="top 5", over="origin"),),
        assumptions=(AID_TYPE,),
    )
    first = with_retention(
        recorded_member(parts=("ODA",), answer_parts=(asked,)),
        {"pinned": False, "held_until": "2026-11-18T00:00:00Z"},
    )
    return build_dataset(
        [first, other_member()],
        layout="long",
        complete=False,
        missing=_gaps(),
        stale=False,
    )


def _dataset_edit(
    change: Callable[[dict[str, Any]], None],
) -> Callable[[dict[bytes, bytes]], None]:
    """A metadata edit that changes the decoded `dfo.dataset` object in place."""

    def edit(metadata: dict[bytes, bytes]) -> None:
        rest = json.loads(metadata[b"dfo.dataset"])
        change(rest)
        metadata[b"dfo.dataset"] = json.dumps(rest).encode()

    return edit


@pytest.mark.parametrize(
    ("edit", "pointer"),
    [
        (lambda m: m.pop(b"dfo.citation"), "/dfo.citation"),
        (lambda m: m.update({b"dfo.citation": b"null"}), "/dfo.citation"),
        (lambda m: m.update({b"dfo.dataset": b"{garbage"}), "/dfo.dataset"),
        (lambda m: m.pop(b"dfo.sentence"), "/dfo.sentence"),
        (lambda m: m.update({b"dfo.sentence": b"\xff"}), "/dfo.sentence"),
        (lambda m: m.pop(b"dfo.ref"), "/dfo.dataset/member_citations"),
        (_dataset_edit(lambda d: d.pop("stale")), "/dfo.dataset/stale"),
        (_dataset_edit(lambda d: d.update(complete="no")), "/dfo.dataset/complete"),
        (
            _dataset_edit(lambda d: d.update(held_until="soon")),
            "/dfo.dataset/held_until",
        ),
        (
            _dataset_edit(lambda d: d["missing"][0].update(kind="bogus")),
            "/dfo.dataset/missing/0/kind",
        ),
        (
            _dataset_edit(lambda d: d["missing"][1].update(part=[])),
            "/dfo.dataset/missing/1/part",
        ),
        (
            _dataset_edit(
                lambda d: d["member_citations"][0]["sources"][0].update(label=5)
            ),
            "/dfo.dataset/member_citations/0/sources/0/label",
        ),
        (
            _dataset_edit(lambda d: d["departures"][0].pop("code")),
            "/dfo.dataset/departures/0/code",
        ),
        (
            _dataset_edit(lambda d: d["requested_operations"][0].update(over=1)),
            "/dfo.dataset/requested_operations/0/over",
        ),
        (
            _dataset_edit(lambda d: d["assumptions"][0].update(refs="x")),
            "/dfo.dataset/assumptions/0/refs",
        ),
        (_dataset_edit(lambda d: d.pop("member_rows")), "/dfo.dataset/member_rows"),
        (
            _dataset_edit(lambda d: d.update(member_rows=[4, 3])),
            "/dfo.dataset/member_rows",
        ),
        (
            _dataset_edit(lambda d: d.update(member_rows=[8])),
            "/dfo.dataset/member_rows",
        ),
        (
            _dataset_edit(lambda d: d.update(member_rows=[9, -1])),
            "/dfo.dataset/member_rows",
        ),
    ],
    ids=[
        "citation-removed",
        "citation-null",
        "dataset-not-json",
        "sentence-removed",
        "sentence-not-utf8",
        "ref-removed",
        "flag-removed",
        "flag-not-boolean",
        "held-until-not-a-date",
        "gap-kind-unknown",
        "gap-part-not-object",
        "source-label-not-text",
        "departure-without-code",
        "operation-over-not-text",
        "assumption-refs-not-array",
        "member-rows-removed",
        "member-rows-not-summing-to-the-rows",
        "member-rows-not-one-per-member",
        "member-rows-negative",
    ],
)
def test_a_damaged_saved_file_raises_format_error(
    tmp_path: Path, edit: Callable[[dict[bytes, bytes]], None], pointer: str
) -> None:
    path = tmp_path / "saved.parquet"
    _saved().save(path)
    table = pq.read_table(path)
    metadata = dict(table.schema.metadata)
    edit(metadata)
    pq.write_table(table.replace_schema_metadata(metadata), path)
    with pytest.raises(FormatError) as caught:
        load_saved(path)
    assert (caught.value.reason, caught.value.pointer) == ("format_invalid", pointer)


def test_repr_leads_with_the_sentence() -> None:
    text = repr(built())
    assert text.startswith("<Dataset " + EXPECTED["members"][0]["sentence"])
    assert "Source: OECD Creditor Reporting System (CRS)" in text
    assert "Version: cv_bf242138f8d0a892c97da9373d1626f4" in text
    # The long layout holds time_period as integers, which the Rows line names.
    assert "  Rows: 4, time_period as integer years\n" in text
    assert "(exact)" in text
    assert text.splitlines()[-1].startswith("  Keep: data.save(")


@pytest.mark.parametrize(
    ("caller", "loaded", "names"),
    [("client", False, "client"), ("dfo", False, "dfo"), ("client", True, "dfo")],
    ids=["client", "default-client", "loaded"],
)
def test_the_repr_names_the_newest_fetch_on_the_client_that_fetched_it(
    tmp_path: Path, caller: str, *, loaded: bool, names: str
) -> None:
    data = build_dataset(
        [recorded_member()],
        layout="long",
        complete=True,
        missing=(),
        stale=False,
        caller=caller,
    )
    if loaded:
        data.save(tmp_path / "saved.parquet")
        data = load_saved(tmp_path / "saved.parquet")
    keep = repr(data).splitlines()[-1]
    assert keep.endswith(f"newest later: {names}.fetch(data.ref, latest=True)>")


def test_the_html_display_escapes_every_server_string() -> None:
    hostile = "<script>alert('x')</script>"
    member = recorded_member(sentence=f"Aid {hostile} & more")
    member.manifest["citation"]["sources"][0]["label"] = f"Source {hostile}"
    table = pq.read_table(PARQUET)
    table = table.set_column(
        table.column_names.index("financingProvider_label"),
        "financingProvider_label",
        pa.array([hostile] * table.num_rows),
    )
    markup = built(with_table(member, table))._repr_html_()
    assert "<script>" not in markup
    assert "&lt;script&gt;alert(&#x27;x&#x27;)&lt;/script&gt;" in markup
    assert "Aid &lt;script&gt;" in markup
    assert "&amp; more" in markup
    assert "Source &lt;script&gt;" in markup


def _gaps() -> tuple[Gap, ...]:
    parts = parse_parts(load("search-4.json"))
    (candidates,) = parse_parts(load("search-2.json"))
    assert isinstance(candidates, CandidatesPart)
    return (
        Gap(
            part_index=0,
            part=candidates,
            kind="choice",
            message="3 readings",
            options=candidates.candidates,
        ),
        Gap(
            part_index=1,
            part=parts[1],
            kind="no_data",
            message="No data for this part.",
        ),
    )


def _assert_same(loaded: Dataset, data: Dataset) -> None:
    assert loaded.to_arrow().equals(data.to_arrow(), check_metadata=True)
    for name in (
        "sentence",
        "members",
        "citation",
        "warnings",
        "departures",
        "requested_operations",
        "assumptions",
        "complete",
        "missing",
        "held_until",
        "pinned",
        "stale",
        "layout_version",
        "sources",
        "licence",
        "ref",
        "left_out",
    ):
        assert getattr(loaded, name) == getattr(data, name), name
    assert len(loaded) == len(data)
    assert [gap.part.raw for gap in loaded.missing] == [
        gap.part.raw for gap in data.missing
    ]
    assert [
        member.spec.definition
        for member in loaded.members
        if isinstance(member, Member)
    ] == [
        member.spec.definition for member in data.members if isinstance(member, Member)
    ]
