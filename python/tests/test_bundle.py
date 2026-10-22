"""Opening website bundles: a ZIP, a folder or a file in one, typed and hash-checked."""

import io
import json
import shutil
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import FrozenInstanceError
from pathlib import Path

import pyarrow.parquet as pq
import pytest

import dfo
from dfo._bundle import BundleError, BundleLimits, open_bundle
from dfo._cache import sha256_digest
from dfo._types import DatasetRef, FormatError, Rendering

from ._data import DATA
from ._datasets import PARQUET

# Website bundles of the version the recorded fetch built, downloaded from dev.
CSV_BUNDLE = DATA / "bundle-csv.zip"
XLSX_BUNDLE = DATA / "bundle-xlsx.zip"
DATA_FILE = "data/oecd-creditor-reporting-system.csv"
XLSX_DATA_FILE = "data/oecd-creditor-reporting-system.xlsx"
SPEC_ID = "spec_cb5baa4161de718f18583060674dbca6"
CONTENT_VERSION = "cv_bf242138f8d0a892c97da9373d1626f4"


def extracted(bundle: Path, folder: Path) -> Path:
    with zipfile.ZipFile(bundle) as archive:
        archive.extractall(folder)
    return folder


@pytest.mark.parametrize("bundle", [CSV_BUNDLE, XLSX_BUNDLE], ids=["csv", "xlsx"])
def test_a_bundle_types_its_columns_like_the_bare_parquet(bundle: Path) -> None:
    if bundle is XLSX_BUNDLE:
        pytest.importorskip("openpyxl")
    table = open_bundle(bundle).to_arrow()
    assert table.equals(pq.read_table(PARQUET))


def test_a_zip_bundle_names_its_exact_version() -> None:
    data = open_bundle(CSV_BUNDLE)
    (member,) = data.members
    assert member.spec.spec_id == SPEC_ID
    assert member.content_version == CONTENT_VERSION
    assert member.digest == sha256_digest(CSV_BUNDLE.read_bytes())
    assert member.rendering == Rendering("csv", True)
    assert data.ref is not None
    assert DatasetRef.from_json(data.ref.to_json()) == data.ref


def test_a_bundle_carries_its_sources_and_licence() -> None:
    data = open_bundle(CSV_BUNDLE)
    assert data.sentence == "OECD Creditor Reporting System (CRS), 2020\u20132023"
    assert data.sources == ("OECD Creditor Reporting System (CRS)",)
    assert data.licence == "OECD Terms and Conditions"
    assert data.citation.sources[0].ref == "provenance/OECDCreditorReportingSystem"
    assert data.layout_version == "bundle"


@pytest.mark.parametrize("entry", [".", "datapackage.json", DATA_FILE])
def test_a_folder_or_a_file_in_it_opens(tmp_path: Path, entry: str) -> None:
    folder = extracted(CSV_BUNDLE, tmp_path / "bundle")
    data = open_bundle(folder / entry)
    assert data.to_arrow().equals(pq.read_table(PARQUET))
    assert data.members == ()
    with pytest.raises(ValueError, match="names no version"):
        _ = data.ref


def test_a_lone_csv_is_refused(tmp_path: Path) -> None:
    lone = tmp_path / "data.csv"
    with zipfile.ZipFile(CSV_BUNDLE) as archive:
        lone.write_bytes(archive.read(DATA_FILE))
    with pytest.raises(BundleError, match="download the bundle") as caught:
        open_bundle(lone)
    assert caught.value.reason == "no_descriptor"


def test_a_changed_file_is_refused(tmp_path: Path) -> None:
    folder = extracted(CSV_BUNDLE, tmp_path / "bundle")
    data_file = folder / DATA_FILE
    data_file.write_text(data_file.read_text().replace("41880.0", "41881.0"))
    with pytest.raises(BundleError) as caught:
        open_bundle(folder)
    assert caught.value.reason == "hash_mismatch"


def test_a_missing_file_is_refused(tmp_path: Path) -> None:
    folder = extracted(CSV_BUNDLE, tmp_path / "bundle")
    (folder / "data" / "codes.csv").unlink()
    with pytest.raises(BundleError) as caught:
        open_bundle(folder)
    assert caught.value.reason == "missing_file"


def test_a_descriptor_without_the_data_table_is_refused(tmp_path: Path) -> None:
    folder = extracted(CSV_BUNDLE, tmp_path / "bundle")
    descriptor = folder / "datapackage.json"
    package = json.loads(descriptor.read_text())
    package["name"] = "renamed"
    descriptor.write_text(json.dumps(package))
    with pytest.raises(BundleError) as caught:
        open_bundle(folder)
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
    ],
    ids=["parent", "climb", "absolute", "backslash-parent", "backslash-root", "dotdot"],
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
    zipped = tmp_path / "escaping.zip"
    with zipfile.ZipFile(zipped, "w") as archive:
        for file in folder.rglob("*"):
            if file.is_file():
                archive.write(file, file.relative_to(folder).as_posix())
    for target in (folder, zipped):
        with pytest.raises(FormatError) as caught:
            open_bundle(target)
        assert (caught.value.reason, caught.value.pointer) == (
            "format_invalid",
            f"/resources/{index}/path",
        )


def test_a_symlink_out_of_an_extracted_folder_is_refused(tmp_path: Path) -> None:
    folder = extracted(CSV_BUNDLE, tmp_path / "bundle")
    secret = tmp_path / "secret.csv"
    secret.write_bytes((folder / DATA_FILE).read_bytes())
    (folder / DATA_FILE).unlink()
    (folder / DATA_FILE).symlink_to(secret)
    with pytest.raises(FormatError) as caught:
        open_bundle(folder)
    assert caught.value.reason == "format_invalid"


def test_a_folder_without_a_descriptor_is_refused(tmp_path: Path) -> None:
    folder = extracted(CSV_BUNDLE, tmp_path / "bundle")
    (folder / "datapackage.json").unlink()
    with pytest.raises(BundleError) as caught:
        open_bundle(folder)
    assert caught.value.reason == "no_descriptor"


def test_a_bare_server_parquet_is_refused(tmp_path: Path) -> None:
    bare = tmp_path / "bare.parquet"
    shutil.copy(PARQUET, bare)
    with pytest.raises(BundleError) as caught:
        open_bundle(bare)
    assert caught.value.reason == "not_a_bundle"


def test_bundle_limits_are_public_immutable_and_keyword_only() -> None:
    limits = dfo.BundleLimits()
    assert limits == BundleLimits()
    with pytest.raises(FrozenInstanceError):
        limits.max_resources = 1
    with pytest.raises(TypeError):
        BundleLimits(1)


@pytest.mark.parametrize("source", ["zip", "folder"])
def test_a_bundle_enforces_actual_resource_bytes(tmp_path: Path, source: str) -> None:
    target = CSV_BUNDLE if source == "zip" else extracted(CSV_BUNDLE, tmp_path / source)
    with pytest.raises(BundleError) as caught:
        open_bundle(target, limits=BundleLimits(max_resource_bytes=1))
    assert caught.value.reason == "resource_limit"


@pytest.mark.parametrize("source", ["zip", "folder"])
def test_a_bundle_enforces_actual_descriptor_bytes(tmp_path: Path, source: str) -> None:
    target = CSV_BUNDLE if source == "zip" else extracted(CSV_BUNDLE, tmp_path / source)
    with pytest.raises(BundleError) as caught:
        open_bundle(target, limits=BundleLimits(max_descriptor_bytes=1))
    assert caught.value.reason == "resource_limit"


def test_a_bundle_enforces_actual_aggregate_bytes() -> None:
    limits = BundleLimits(
        max_descriptor_bytes=20 * 1024,
        max_resource_bytes=20 * 1024,
        max_total_bytes=15 * 1024,
    )
    with pytest.raises(BundleError) as caught:
        open_bundle(CSV_BUNDLE, limits=limits)
    assert caught.value.reason == "resource_limit"


def test_a_zip_bundle_limits_its_entry_count_before_reading_resources() -> None:
    with pytest.raises(BundleError) as caught:
        open_bundle(CSV_BUNDLE, limits=BundleLimits(max_zip_entries=1))
    assert caught.value.reason == "resource_limit"


def test_finding_a_bundle_folder_limits_its_descriptor_resources(
    tmp_path: Path,
) -> None:
    folder = extracted(CSV_BUNDLE, tmp_path / "bundle")
    with pytest.raises(BundleError) as caught:
        open_bundle(folder / DATA_FILE, limits=BundleLimits(max_resources=1))
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
        open_bundle(XLSX_BUNDLE, limits=BundleLimits(**{limit_name: limit - 1}))
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

    assert open_bundle(folder).to_arrow().equals(pq.read_table(PARQUET))
    with pytest.raises(BundleError) as caught:
        open_bundle(folder, limits=BundleLimits(max_xlsx_rows=1))
    assert caught.value.reason == "resource_limit"
