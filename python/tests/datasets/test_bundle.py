"""Opening website bundles: a ZIP, a folder or a file in one, typed and hash-checked."""

import hashlib
import io
import json
import shutil
import xml.etree.ElementTree as ET
import zipfile
from collections.abc import Callable
from dataclasses import FrozenInstanceError
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

import dfo
from dfo._core.errors import DfoError, InvalidRequestError
from dfo._core.refs import DatasetRef
from dfo._core.types import FormatError, Rendering
from dfo._datasets.bundle import BundleError, BundleLimits, load
from dfo._datasets.cache import sha256_digest
from dfo._datasets.dataset import in_reading_order
from tests._data import DATA

# Website bundles of one version, downloaded from dev, and that version's bare
# long Parquet file at layout 3, whose columns the bundles type like.
CSV_BUNDLE = DATA / "bundle-csv.zip"
XLSX_BUNDLE = DATA / "bundle-xlsx.zip"
PARQUET = DATA / "bundle-bare.parquet"


def bare_table() -> pa.Table:
    """The bare Parquet file's table, its columns and rows in reading order."""
    table = pq.read_table(PARQUET)
    return in_reading_order(table, member_rows=(table.num_rows,))


DATA_FILE = "data/oecd-creditor-reporting-system.csv"
XLSX_DATA_FILE = "data/oecd-creditor-reporting-system.xlsx"
SPEC_ID = "spec_cb5baa4161de718f18583060674dbca6"
CONTENT_VERSION = "cv_bf242138f8d0a892c97da9373d1626f4"
with zipfile.ZipFile(CSV_BUNDLE) as _bundle:
    DATA_BYTES = _bundle.read(DATA_FILE)
DATA_HEX = hashlib.sha256(DATA_BYTES).hexdigest()


def extracted(bundle: Path, folder: Path) -> Path:
    with zipfile.ZipFile(bundle) as archive:
        archive.extractall(folder)
    return folder


def zipped_from(folder: Path, zipped: Path) -> Path:
    with zipfile.ZipFile(zipped, "w") as archive:
        for file in sorted(folder.rglob("*")):
            if file.is_file():
                archive.write(file, file.relative_to(folder).as_posix())
    return zipped


def edited(tmp_path: Path, edit: Callable[[bytes], bytes]) -> tuple[Path, Path]:
    """The CSV bundle with its descriptor's bytes edited, as a folder and a ZIP."""
    folder = extracted(CSV_BUNDLE, tmp_path / "bundle")
    descriptor = folder / "datapackage.json"
    descriptor.write_bytes(edit(descriptor.read_bytes()))
    return folder, zipped_from(folder, tmp_path / "edited.zip")


def package_edit(change: Callable[[dict[str, Any]], None]) -> Callable[[bytes], bytes]:
    """A descriptor edit that changes the decoded package in place."""

    def edit(raw: bytes) -> bytes:
        package = json.loads(raw)
        change(package)
        return json.dumps(package).encode()

    return edit


def small_bundle(tmp_path: Path, data: bytes, fmt: str, fields: list[Any]) -> Path:
    """A ZIP bundle of one data file, its descriptor typing `fields`."""
    path = f"data.{fmt}"
    package = {
        "name": "small",
        "resources": [
            {
                "name": "small",
                "path": path,
                "format": fmt,
                "hash": sha256_digest(data),
                "schema": {"fields": fields},
            }
        ],
    }
    zipped = tmp_path / "small.zip"
    with zipfile.ZipFile(zipped, "w") as archive:
        archive.writestr("datapackage.json", json.dumps(package))
        archive.writestr(path, data)
    return zipped


def xlsx(rows: list[list[Any]]) -> bytes:
    openpyxl = pytest.importorskip("openpyxl")
    workbook = openpyxl.Workbook()
    for row in rows:
        workbook.active.append(row)
    output = io.BytesIO()
    workbook.save(output)
    return output.getvalue()


FIELDS = [
    {"name": "country", "type": "string"},
    {"name": "year", "type": "integer"},
    {"name": "value", "type": "number"},
]


@pytest.mark.parametrize("bundle", [CSV_BUNDLE, XLSX_BUNDLE], ids=["csv", "xlsx"])
def test_a_bundle_types_its_columns_like_the_bare_parquet(bundle: Path) -> None:
    if bundle is XLSX_BUNDLE:
        pytest.importorskip("openpyxl")
    table = load(bundle).to_arrow()
    assert table.equals(bare_table())


def test_a_zip_bundle_names_its_exact_version() -> None:
    data = load(CSV_BUNDLE)
    (member,) = data.members
    assert member.spec.spec_id == SPEC_ID
    assert member.content_version == CONTENT_VERSION
    assert member.digest == sha256_digest(CSV_BUNDLE.read_bytes())
    assert member.rendering == Rendering("csv", True)
    assert data.ref is not None
    assert DatasetRef.from_json(data.ref.to_json()) == data.ref


def test_a_bundle_carries_its_sources_and_licence() -> None:
    data = load(CSV_BUNDLE)
    assert data.sentence == "OECD Creditor Reporting System (CRS), 2020\u20132023"
    assert data.sources == ("OECD Creditor Reporting System (CRS)",)
    assert data.licence == "OECD Terms and Conditions"
    assert data.citation.sources[0].ref == "provenance/OECDCreditorReportingSystem"
    assert data.layout_version == "bundle"


@pytest.mark.parametrize("entry", [".", "datapackage.json", DATA_FILE])
def test_a_folder_or_a_file_in_it_opens(tmp_path: Path, entry: str) -> None:
    folder = extracted(CSV_BUNDLE, tmp_path / "bundle")
    data = load(folder / entry)
    assert data.to_arrow().equals(bare_table())
    assert data.members == ()
    with pytest.raises(InvalidRequestError) as caught:
        _ = data.ref
    assert caught.value.code == "ref_unavailable"
    assert isinstance(caught.value, ValueError)


def test_a_lone_csv_is_refused(tmp_path: Path) -> None:
    lone = tmp_path / "data.csv"
    with zipfile.ZipFile(CSV_BUNDLE) as archive:
        lone.write_bytes(archive.read(DATA_FILE))
    with pytest.raises(DfoError, match="download the bundle") as caught:
        load(lone)
    assert isinstance(caught.value, BundleError)
    assert (caught.value.reason, caught.value.code) == (
        "no_descriptor",
        "no_descriptor",
    )


def test_a_changed_file_is_refused(tmp_path: Path) -> None:
    folder = extracted(CSV_BUNDLE, tmp_path / "bundle")
    data_file = folder / DATA_FILE
    data_file.write_text(data_file.read_text().replace("41880.0", "41881.0"))
    with pytest.raises(BundleError) as caught:
        load(folder)
    assert caught.value.reason == "hash_mismatch"


def test_a_missing_file_is_refused(tmp_path: Path) -> None:
    folder = extracted(CSV_BUNDLE, tmp_path / "bundle")
    (folder / "data" / "codes.csv").unlink()
    with pytest.raises(BundleError) as caught:
        load(folder)
    assert caught.value.reason == "missing_file"


def test_a_descriptor_without_the_data_table_is_refused(tmp_path: Path) -> None:
    for target in edited(tmp_path, package_edit(lambda p: p.update(name="renamed"))):
        with pytest.raises(BundleError) as caught:
            load(target)
        assert caught.value.reason == "no_data_resource"


@pytest.mark.parametrize(
    "escape",
    [
        "../secret.csv",
        "data/../../secret.csv",
        "abs",
        "..\\secret.csv",
        "\\secret.csv",
        f"data/../{DATA_FILE}",
        f"./{DATA_FILE}",
        f"{DATA_FILE}/",
        DATA_FILE.replace("/", "//"),
        f"{DATA_FILE}\x00.png",
        "",
    ],
    ids=[
        "parent",
        "climb",
        "absolute",
        "backslash-parent",
        "backslash-root",
        "dotdot",
        "dot",
        "trailing-slash",
        "empty-name",
        "nul",
        "empty",
    ],
)
def test_a_descriptor_path_outside_the_bundle_is_refused_before_any_read(
    tmp_path: Path, escape: str
) -> None:
    folder = extracted(CSV_BUNDLE, tmp_path / "bundle")
    secret = tmp_path / "secret.csv"
    secret.write_bytes((folder / DATA_FILE).read_bytes())
    descriptor = folder / "datapackage.json"
    package = json.loads(descriptor.read_text())
    index = next(
        i for i, r in enumerate(package["resources"]) if r.get("path") == DATA_FILE
    )
    package["resources"][index]["path"] = str(secret) if escape == "abs" else escape
    descriptor.write_text(json.dumps(package))
    zipped = zipped_from(folder, tmp_path / "escaping.zip")
    for target in (folder, zipped):
        with pytest.raises(FormatError) as caught:
            load(target)
        assert (caught.value.reason, caught.value.pointer) == (
            "format_invalid",
            f"/resources/{index}/path",
        )


@pytest.mark.parametrize(
    ("linked", "pointer"), [(DATA_FILE, "/resources/0/path"), ("datapackage.json", "")]
)
def test_a_symlink_out_of_an_extracted_folder_is_refused(
    tmp_path: Path, linked: str, pointer: str
) -> None:
    folder = extracted(CSV_BUNDLE, tmp_path / "bundle")
    secret = tmp_path / "secret"
    secret.write_bytes((folder / linked).read_bytes())
    (folder / linked).unlink()
    (folder / linked).symlink_to(secret)
    with pytest.raises(FormatError) as caught:
        load(folder)
    assert (caught.value.reason, caught.value.pointer) == ("format_invalid", pointer)


@pytest.mark.parametrize(
    "value",
    [
        None,
        5,
        False,
        "md5:" + hashlib.md5(DATA_BYTES).hexdigest(),
        DATA_HEX,
        "foo:abc",
        "shake_128:abc",
        "SHA256:" + DATA_HEX,
        "sha256:" + DATA_HEX.upper(),
    ],
    ids=[
        "absent",
        "number",
        "false",
        "md5",
        "bare-hex",
        "unknown-algorithm",
        "shake",
        "upper-algorithm",
        "upper-hex",
    ],
)
def test_a_file_without_a_sha256_hash_is_refused(tmp_path: Path, value: object) -> None:
    def change(package: dict[str, Any]) -> None:
        resource = package["resources"][0]
        if value is None:
            del resource["hash"]
        else:
            resource["hash"] = value

    for target in edited(tmp_path, package_edit(change)):
        with pytest.raises(FormatError) as caught:
            load(target)
        assert (caught.value.reason, caught.value.pointer) == (
            "format_invalid",
            "/resources/0/hash",
        )


def _drop_spec_id(package: dict[str, Any]) -> None:
    del package["dfo"]["spec"]["spec_id"]


@pytest.mark.parametrize(
    ("edit", "pointer"),
    [
        (lambda raw: raw[: len(raw) // 2], ""),
        (lambda raw: b"\xff\xfe\x00", ""),
        (lambda raw: b"[]", ""),
        (lambda raw: raw.replace(b'"bytes": 2824', b'"bytes": NaN'), ""),
        (package_edit(_drop_spec_id), "/dfo/spec/spec_id"),
        (package_edit(lambda p: p["dfo"].update(spec=[])), "/dfo/spec"),
        (
            package_edit(lambda p: p["dfo"].update(content_version="cv_x")),
            "/dfo/content_version",
        ),
        (package_edit(lambda p: p.update(dfo="x")), "/dfo"),
        (
            package_edit(
                lambda p: p["resources"][0]["schema"]["fields"][0].update(
                    type=["string"]
                )
            ),
            "/resources/0/schema/fields/0/type",
        ),
        (
            package_edit(
                lambda p: p["resources"][0]["schema"].update(missingValues=[None])
            ),
            "/resources/0/schema/missingValues",
        ),
    ],
    ids=[
        "not-json",
        "not-utf8",
        "not-object",
        "nan",
        "spec-without-id",
        "spec-not-object",
        "content-version",
        "dfo-not-object",
        "field-type-list",
        "missing-values",
    ],
)
def test_a_damaged_descriptor_raises_format_error(
    tmp_path: Path, edit: Callable[[bytes], bytes], pointer: str
) -> None:
    for target in edited(tmp_path, edit):
        with pytest.raises(FormatError) as caught:
            load(target)
        assert (caught.value.reason, caught.value.pointer) == (
            "format_invalid",
            pointer,
        )


@pytest.mark.parametrize(
    ("fmt", "rows"),
    [
        ("csv", [["country", "value", "value"], ["KEN", 1, 2]]),
        ("csv", [["country", "year", "value"], ["KEN", "twenty", 1]]),
        ("csv", [["country", "year", "value"], ["KEN", 2015]]),
        ("csv", []),
        ("xlsx", [["country", "value", "value"], ["KEN", 1, 2]]),
        ("xlsx", [["country", None, "value"], ["KEN", 2015, 1.5]]),
        ("xlsx", [["country", "year", "value"], ["KEN", 2015.9, 1.5]]),
        ("xlsx", [["country", "year", "value"], ["KEN", True, 1.5]]),
        ("xlsx", [["country", "year", "value"], ["KEN", 2015, "=1+1"]]),
        ("xlsx", [["country", "year", "value"], ["KEN", 2**70, 1.5]]),
    ],
    ids=[
        "csv-repeated-name",
        "csv-text-in-integer",
        "csv-ragged",
        "csv-empty",
        "xlsx-repeated-name",
        "xlsx-unnamed-column",
        "xlsx-fraction-in-integer",
        "xlsx-boolean-in-integer",
        "xlsx-formula",
        "xlsx-integer-overflow",
    ],
)
def test_data_that_does_not_fit_its_columns_raises_format_error(
    tmp_path: Path, fmt: str, rows: list[list[Any]]
) -> None:
    data = (
        xlsx(rows)
        if fmt == "xlsx"
        else "".join(",".join(map(str, row)) + "\n" for row in rows).encode()
    )
    with pytest.raises(FormatError) as caught:
        load(small_bundle(tmp_path, data, fmt, FIELDS))
    assert (caught.value.reason, caught.value.pointer) == (
        "format_invalid",
        "/resources/0",
    )


@pytest.mark.parametrize("fmt", ["csv", "xlsx"])
def test_a_small_bundle_reads_its_typed_values(tmp_path: Path, fmt: str) -> None:
    rows: list[list[Any]] = [["country", "year", "value"], ["KEN", 2015.0, 1.5]]
    data = xlsx(rows) if fmt == "xlsx" else b"country,year,value\nKEN,2015,1.5\n"
    table = load(small_bundle(tmp_path, data, fmt, FIELDS)).to_arrow()
    assert table.to_pydict() == {"country": ["KEN"], "year": [2015], "value": [1.5]}


def test_a_folder_without_a_descriptor_is_refused(tmp_path: Path) -> None:
    folder = extracted(CSV_BUNDLE, tmp_path / "bundle")
    (folder / "datapackage.json").unlink()
    with pytest.raises(BundleError) as caught:
        load(folder)
    assert caught.value.reason == "no_descriptor"


def test_a_bare_server_parquet_is_refused(tmp_path: Path) -> None:
    bare = tmp_path / "bare.parquet"
    shutil.copy(PARQUET, bare)
    with pytest.raises(BundleError) as caught:
        load(bare)
    assert caught.value.reason == "not_a_bundle"


def _halved(source: Path) -> bytes:
    data = source.read_bytes()
    return data[: len(data) // 2]


@pytest.mark.parametrize(
    ("source", "suffix", "as_bytes"),
    [
        (PARQUET, ".parquet", False),
        (PARQUET, ".parquet", True),
        (CSV_BUNDLE, ".zip", False),
    ],
    ids=["parquet", "parquet-bytes", "zip"],
)
def test_a_damaged_file_is_refused(
    tmp_path: Path, source: Path, suffix: str, as_bytes: bool
) -> None:
    damaged = tmp_path / f"damaged{suffix}"
    damaged.write_bytes(_halved(source))
    with pytest.raises(BundleError) as caught:
        load(damaged.read_bytes() if as_bytes else damaged)
    assert caught.value.reason == "not_a_bundle"
    assert caught.value.__cause__ is not None


def _damaged_page() -> bytes:
    """A saved-dataset Parquet file whose footer is intact and first page is not."""
    table = pa.table({"x": list(range(1000))}).replace_schema_metadata(
        {b"dfo.format_version": b"1"}
    )
    sink = pa.BufferOutputStream()
    pq.write_table(table, sink)
    data = bytearray(sink.getvalue().to_pybytes())
    data[4:24] = b"\xff" * 20
    return bytes(data)


@pytest.mark.parametrize("as_bytes", [False, True], ids=["path", "bytes"])
def test_a_damaged_page_is_refused(tmp_path: Path, as_bytes: bool) -> None:
    damaged = tmp_path / "damaged.parquet"
    damaged.write_bytes(_damaged_page())
    with pytest.raises(BundleError) as caught:
        load(damaged.read_bytes() if as_bytes else damaged)
    assert caught.value.reason == "not_a_bundle"
    assert isinstance(caught.value.__cause__, OSError)


def test_a_missing_parquet_path_raises_file_not_found(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        load(tmp_path / "missing.parquet")


def test_a_damaged_xlsx_in_a_bundle_raises_format_error(tmp_path: Path) -> None:
    damaged = xlsx([["country"], ["KEN"]])[:200]
    with pytest.raises(FormatError) as caught:
        load(small_bundle(tmp_path, damaged, "xlsx", FIELDS))
    assert (caught.value.reason, caught.value.pointer) == (
        "format_invalid",
        "/resources/0",
    )
    assert isinstance(caught.value.__cause__, zipfile.BadZipFile)


def test_bundle_limits_are_public_immutable_and_keyword_only() -> None:
    limits = dfo.types.BundleLimits()
    assert limits == BundleLimits()
    with pytest.raises(FrozenInstanceError):
        limits.max_resources = 1
    with pytest.raises(TypeError):
        BundleLimits(1)


@pytest.mark.parametrize("value", [0, True, 1.0])
def test_a_bundle_limit_is_a_positive_integer(value: object) -> None:
    with pytest.raises(InvalidRequestError, match="max_xlsx_cells") as caught:
        BundleLimits(max_xlsx_cells=value)  # ty: ignore[invalid-argument-type]
    assert caught.value.code == "invalid_argument"


@pytest.mark.parametrize("limit", ["max_resource_bytes", "max_descriptor_bytes"])
@pytest.mark.parametrize("source", ["zip", "folder"])
def test_a_bundle_enforces_actual_file_bytes(
    tmp_path: Path, source: str, limit: str
) -> None:
    target = CSV_BUNDLE if source == "zip" else extracted(CSV_BUNDLE, tmp_path / source)
    with pytest.raises(BundleError) as caught:
        load(target, limits=BundleLimits(**{limit: 1}))
    assert caught.value.reason == "resource_limit"


def test_a_bundle_enforces_actual_aggregate_bytes() -> None:
    limits = BundleLimits(
        max_descriptor_bytes=20 * 1024,
        max_resource_bytes=20 * 1024,
        max_total_bytes=15 * 1024,
    )
    with pytest.raises(BundleError) as caught:
        load(CSV_BUNDLE, limits=limits)
    assert caught.value.reason == "resource_limit"


def test_a_zip_bundle_limits_its_entry_count_before_reading_resources() -> None:
    with pytest.raises(BundleError) as caught:
        load(CSV_BUNDLE, limits=BundleLimits(max_zip_entries=1))
    assert caught.value.reason == "resource_limit"


def test_finding_a_bundle_folder_limits_its_descriptor_resources(
    tmp_path: Path,
) -> None:
    folder = extracted(CSV_BUNDLE, tmp_path / "bundle")
    with pytest.raises(BundleError) as caught:
        load(folder / DATA_FILE, limits=BundleLimits(max_resources=1))
    assert caught.value.reason == "resource_limit"


def _xlsx_fixture_limits() -> dict[str, int]:
    openpyxl = pytest.importorskip("openpyxl")
    with zipfile.ZipFile(XLSX_BUNDLE) as bundle:
        content = bundle.read(XLSX_DATA_FILE)
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        entries = archive.infolist()
        entry_count = len(entries)
        expanded_bytes = sum(entry.file_size for entry in entries)
    with io.BytesIO(content) as stream:
        workbook = openpyxl.load_workbook(stream, read_only=True, data_only=True)
        try:
            sheet = workbook.active
            data_rows = sheet.max_row - 1
            cells = sheet.max_row * sheet.max_column
        finally:
            workbook.close()
    return {
        "max_xlsx_entries": entry_count,
        "max_xlsx_expanded_bytes": expanded_bytes,
        "max_xlsx_rows": data_rows,
        "max_xlsx_cells": cells,
    }


@pytest.mark.parametrize(
    "limit_name",
    [
        "max_xlsx_entries",
        "max_xlsx_expanded_bytes",
        "max_xlsx_rows",
        "max_xlsx_cells",
    ],
)
def test_an_xlsx_bundle_enforces_its_inner_resource_limits(limit_name: str) -> None:
    fixture_limits = _xlsx_fixture_limits()
    limit = fixture_limits[limit_name]
    assert limit > 1
    with pytest.raises(BundleError) as caught:
        load(XLSX_BUNDLE, limits=BundleLimits(**{limit_name: limit - 1}))
    assert caught.value.reason == "resource_limit"


def test_an_xlsx_without_declared_dimensions_streams_with_limits(
    tmp_path: Path,
) -> None:
    pytest.importorskip("openpyxl")
    folder = extracted(XLSX_BUNDLE, tmp_path / "bundle")
    path = folder / XLSX_DATA_FILE
    output = io.BytesIO()
    namespace = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    with (
        zipfile.ZipFile(path) as original,
        zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as rewritten,
    ):
        for entry in original.infolist():
            content = original.read(entry)
            if entry.filename.startswith("xl/worksheets/"):
                worksheet = ET.fromstring(content)
                dimension = worksheet.find(namespace + "dimension")
                if dimension is not None:
                    worksheet.remove(dimension)
                content = ET.tostring(worksheet)
            rewritten.writestr(entry, content)
    path.write_bytes(output.getvalue())
    descriptor = folder / "datapackage.json"
    package = json.loads(descriptor.read_text())
    resource = next(r for r in package["resources"] if r.get("path") == XLSX_DATA_FILE)
    resource["hash"] = sha256_digest(path.read_bytes())
    descriptor.write_text(json.dumps(package))

    assert load(folder).to_arrow().equals(bare_table())
    with pytest.raises(BundleError) as caught:
        load(folder, limits=BundleLimits(max_xlsx_rows=1))
    assert caught.value.reason == "resource_limit"
