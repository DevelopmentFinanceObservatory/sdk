"""Opening website bundles: a ZIP, a folder or a file in one, typed and hash-checked."""

import json
import shutil
import zipfile
from pathlib import Path

import pyarrow.parquet as pq
import pytest

from dfo._bundle import BundleError, open_bundle
from dfo._cache import sha256_digest
from dfo._types import DatasetRef, Rendering

from ._data import DATA
from ._datasets import PARQUET

# Website bundles of the version the recorded fetch built, downloaded from dev.
CSV_BUNDLE = DATA / "bundle-csv.zip"
XLSX_BUNDLE = DATA / "bundle-xlsx.zip"
DATA_FILE = "data/oecd-creditor-reporting-system.csv"
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
    assert data.ref is None


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
