"""Datasets from fetched members: provenance, stacking, conversions, display and saving."""

import copy
import pickle
import sys
from datetime import date
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from dfo._bundle import open_bundle
from dfo._cache import sha256_digest
from dfo._dataset import Dataset, FetchedMember, Layout, build_dataset
from dfo._errors import ContractError
from dfo._parse import parse_parts
from dfo._types import (
    Assumption,
    DatasetRef,
    DefinitePart,
    Departure,
    Gap,
    Rendering,
    RequestedOperation,
)

from ._data import load
from ._datasets import PARQUET, manifest, other_member, recorded_member, scenario

EXPECTED = scenario()["expect"][0]["dataset"]
AID_TYPE = Assumption(
    kind="declared_default",
    binding_ref="how:dac2aAidType",
    text="official development assistance",
    refs=("DAC2aAidType206",),
)


def one(member: FetchedMember | None = None, *, layout: Layout = "long") -> Dataset:
    return build_dataset(
        [member or recorded_member()],
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
    return FetchedMember(
        parts=member.parts,
        spec=member.spec,
        sentence=member.sentence,
        content_version=member.content_version,
        manifest=body,
        digest=member.digest,
        data=member.data,
        answer_parts=member.answer_parts,
    )


def test_one_member_matches_the_recorded_expectation() -> None:
    data = one()
    assert data.rows == len(data) == EXPECTED["rows"]
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
    data = one()
    assert data.citation.text == manifest()["citation"]["text"]
    assert data.sources == ("OECD Creditor Reporting System (CRS)",)
    assert data.licence == "OECD Terms and Conditions"
    assert [notice.code for notice in data.warnings] == ["coverage_below_scope"]
    assert data.layout_version == "3"
    assert data.assumptions == ()
    assert data.departures == data.requested_operations == ()


def test_the_ref_holds_the_exact_version() -> None:
    data = one()
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
    data = one(member, layout="frame")
    assert data.layout_version == "frame"
    assert data.members[0].rendering == Rendering("parquet", False, "frame")


def test_the_recorded_retention_reads_its_date() -> None:
    data = one()
    assert data.held_until == date(2026, 11, 20)
    assert data.pinned is False


def test_retention_absent_reads_none_and_is_not_shown() -> None:
    body = manifest()
    del body["retention"]
    data = one(recorded_member(manifest=body))
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
    data = build_dataset(
        [first, second], layout="long", complete=True, missing=(), stale=False
    )
    assert data.held_until == date(2026, 11, 18)
    assert data.pinned is False
    assert "Held until 18 November 2026, not pinned" in repr(data)


def test_pinned_when_every_member_is_pinned() -> None:
    pinned = with_retention(recorded_member(), {"pinned": True})
    held = with_retention(
        other_member(), {"pinned": False, "held_until": "2026-11-18T00:00:00Z"}
    )
    both = build_dataset(
        [pinned, with_retention(other_member(), {"pinned": True})],
        layout="long",
        complete=True,
        missing=(),
        stale=False,
    )
    assert (both.pinned, both.held_until) == (True, None)
    assert "Pinned" in repr(both)
    mixed = build_dataset(
        [pinned, held], layout="long", complete=True, missing=(), stale=False
    )
    assert (mixed.pinned, mixed.held_until) == (False, date(2026, 11, 18))


def test_several_members_stack_with_a_part_column() -> None:
    first = recorded_member(parts=("ODA disbursements", "health ODA"))
    second = other_member()
    data = build_dataset(
        [first, second], layout="long", complete=True, missing=(), stale=False
    )
    table = data.to_arrow()
    assert table.column_names[0] == "part"
    assert table.column_names[1:-1] == EXPECTED["columns"]
    assert table.column_names[-1] == "observationAbout"
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


def test_a_member_with_no_part_is_labelled_by_its_sentence() -> None:
    data = build_dataset(
        [recorded_member(), other_member()],
        layout="long",
        complete=True,
        missing=(),
        stale=False,
    )
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
    data = one(recorded_member(answer_parts=(asked,)))
    assert data.departures == (departure,)
    assert data.requested_operations == (operation,)
    assert data.assumptions == (AID_TYPE,)


def test_a_manifest_without_the_artifact_is_refused() -> None:
    member = recorded_member()
    member.manifest["artifacts"] = member.manifest["artifacts"][1:]
    with pytest.raises(ContractError, match="lists no artifact"):
        one(member)


def test_the_frame_layout_refuses_several_members() -> None:
    with pytest.raises(ValueError, match="one member"):
        build_dataset(
            [recorded_member(), other_member()],
            layout="frame",
            complete=True,
            missing=(),
            stale=False,
        )
    with pytest.raises(ValueError, match="at least one"):
        build_dataset([], layout="long", complete=True, missing=(), stale=False)


def test_to_arrow_carries_the_provenance() -> None:
    data = one()
    metadata = data.to_arrow().schema.metadata
    assert metadata[b"dfo.sentence"].decode() == data.sentence
    assert data.ref is not None
    assert metadata[b"dfo.ref"].decode() == data.ref.to_json()
    assert metadata[b"dfo.licence"] == b"OECD Terms and Conditions"
    assert b"ARROW:schema" not in metadata
    assert b"pandas" not in metadata


def test_pandas_gets_the_provenance_in_attrs() -> None:
    pytest.importorskip("pandas")
    frame = one().to_pandas()
    assert len(frame) == 4
    assert frame.attrs["sentence"] == EXPECTED["members"][0]["sentence"]
    assert frame.attrs["sources"] == ["OECD Creditor Reporting System (CRS)"]


def test_polars_gets_the_table() -> None:
    polars = pytest.importorskip("polars")
    frame = one().to_polars()
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
        getattr(one(), method)()


def test_the_arrow_stream_is_fresh_per_call() -> None:
    data = one()
    assert hasattr(pa.Table, "__arrow_c_stream__")
    first = pa.RecordBatchReader.from_stream(data).read_all()
    second = pa.RecordBatchReader.from_stream(data).read_all()
    assert first.equals(second)
    assert first.num_rows == 4


def test_pandas_reads_the_arrow_stream() -> None:
    pandas = pytest.importorskip("pandas")
    if not hasattr(pandas.DataFrame, "from_arrow"):
        pytest.skip("this pandas has no DataFrame.from_arrow")
    frame = pandas.DataFrame.from_arrow(one())
    assert list(frame.columns) == EXPECTED["columns"]
    assert len(frame) == 4


def test_polars_reads_the_arrow_stream() -> None:
    polars = pytest.importorskip("polars")
    frame = polars.DataFrame(one())
    assert frame.columns == EXPECTED["columns"]
    assert frame.height == 4


def test_duckdb_reads_the_arrow_stream() -> None:
    duckdb = pytest.importorskip("duckdb")
    data = one()  # noqa: F841 - DuckDB finds it by name
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


def test_save_then_open_bundle_returns_an_equal_dataset(tmp_path: Path) -> None:
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
    data = build_dataset(
        [first, other_member()],
        layout="long",
        complete=False,
        missing=_gaps(),
        stale=False,
    )
    path = tmp_path / "saved.parquet"
    data.save(path)

    stored = pq.read_metadata(path).metadata
    assert stored[b"dfo.sentence"].decode() == data.sentence
    assert data.ref is not None
    assert stored[b"dfo.ref"].decode() == data.ref.to_json()
    _assert_same(open_bundle(path), data)


def test_repr_leads_with_the_sentence() -> None:
    text = repr(one())
    assert text.startswith("<Dataset " + EXPECTED["members"][0]["sentence"])
    assert "Source: OECD Creditor Reporting System (CRS)" in text
    assert "Version: cv_bf242138f8d0a892c97da9373d1626f4" in text
    assert "Rows: 4" in text


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
    sink = pa.BufferOutputStream()
    pq.write_table(table, sink)
    data_bytes = sink.getvalue().to_pybytes()
    digest = sha256_digest(data_bytes)
    member.manifest["artifacts"][0]["artifact_digest"] = digest
    member = FetchedMember(
        parts=member.parts,
        spec=member.spec,
        sentence=member.sentence,
        content_version=member.content_version,
        manifest=member.manifest,
        digest=digest,
        data=data_bytes,
    )
    markup = one(member)._repr_html_()
    assert "<script>" not in markup
    assert "&lt;script&gt;alert(&#x27;x&#x27;)&lt;/script&gt;" in markup
    assert "Aid &lt;script&gt;" in markup
    assert "&amp; more" in markup
    assert "Source &lt;script&gt;" in markup


def _gaps() -> tuple[Gap, ...]:
    parts = parse_parts(load("search-4.json"))
    return (
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
        "rows",
        "sources",
        "licence",
        "ref",
    ):
        assert getattr(loaded, name) == getattr(data, name), name
    assert [gap.part.raw for gap in loaded.missing] == [
        gap.part.raw for gap in data.missing
    ]
    assert [member.spec.definition for member in loaded.members] == [
        member.spec.definition for member in data.members
    ]
