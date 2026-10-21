"""Open a saved dataset or a bundle downloaded from the website.

`open_bundle` reads a Parquet file `Dataset.save` wrote, or a website bundle as a
ZIP, an extracted folder, or a file inside one. A bundle's `datapackage.json`
types the data's CSV or XLSX columns and gives each file's hash, which is checked
before the data is read. Every file it lists lies inside the bundle: a path with a
backslash, a drive, a root or a `..` segment is refused before any file is read,
and so is a path in an extracted folder that resolves outside it through a
symlink.

Both clients call this module; it is sync and does no network I/O.
"""

import hashlib
import io
import json
import zipfile
from collections.abc import Callable, Mapping, Sequence
from os import PathLike
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, Literal

import pyarrow as pa
import pyarrow.csv as pa_csv
import pyarrow.parquet as pq

from dfo._cache import sha256_digest
from dfo._dataset import Dataset, saved_dataset
from dfo._types import (
    Citation,
    CitationSource,
    FormatError,
    Member,
    Rendering,
    Spec,
)

DESCRIPTOR = "datapackage.json"

type BundleErrorReason = Literal[
    "not_a_bundle", "no_descriptor", "no_data_resource", "missing_file", "hash_mismatch"
]

# Table Schema field types and the Arrow types their columns read as. A type not
# listed reads as a string.
_FIELD_TYPES: Mapping[str, pa.DataType] = {
    "string": pa.string(),
    "integer": pa.int64(),
    "number": pa.float64(),
    "boolean": pa.bool_(),
    "date": pa.date32(),
    "datetime": pa.timestamp("us"),
    "year": pa.int64(),
}

_ZIP_MAGIC = b"PK\x03\x04"
_PARQUET_MAGIC = b"PAR1"


class BundleError(ValueError):
    """A path holds no dataset `open_bundle` can read.

    Attributes:
        reason: `not_a_bundle` for a file that is neither a saved dataset nor part
            of a bundle, `no_descriptor` for data with no `datapackage.json`,
            `no_data_resource` for a descriptor that names no data table,
            `missing_file` for a file the descriptor lists but the bundle lacks,
            or `hash_mismatch` for a file whose bytes differ from its hash.
    """

    def __init__(self, reason: BundleErrorReason, message: str) -> None:
        super().__init__(message)
        self.reason: BundleErrorReason = reason


def open_bundle(path: str | PathLike[str], /) -> Dataset:
    """Open a dataset saved by `Dataset.save`, or a bundle downloaded from the website.

    Args:
        path: A Parquet file `save` wrote, a bundle's ZIP, the folder it extracts
            to, or its `datapackage.json` or data file.

    Raises:
        BundleError: The path holds no saved dataset or bundle, a lone CSV or
            XLSX has no descriptor beside it, or a file's bytes differ from the
            hash its descriptor gives.
        FormatError: The descriptor lists a file outside the bundle.
        ValueError: A saved file comes from a later format version.
    """
    target = Path(path)
    if target.is_dir():
        return _open_folder(target)
    with target.open("rb") as file:
        magic = file.read(4)
    if magic == _ZIP_MAGIC:
        return _open_zip(target)
    if magic == _PARQUET_MAGIC:
        return _open_saved(target)
    folder = _folder_holding(target)
    if folder is None:
        raise BundleError(
            "no_descriptor",
            f"{target} has no {DESCRIPTOR} beside it, so its columns cannot be "
            "typed: download the bundle, or fetch the dataset with dfo.fetch",
        )
    return _open_folder(folder)


def _open_saved(path: Path) -> Dataset:
    parquet = pq.ParquetFile(path)
    metadata = parquet.schema_arrow.metadata or {}
    if b"dfo.format_version" not in metadata:
        raise BundleError(
            "not_a_bundle",
            f"{path} is a Parquet file without a saved dataset's provenance: "
            "open a file Dataset.save wrote",
        )
    return saved_dataset(parquet.read(), metadata)


def _open_zip(path: Path) -> Dataset:
    data = path.read_bytes()
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = set(archive.namelist())

        def read(name: str) -> bytes | None:
            return archive.read(name) if name in names else None

        return _open_descriptor(read, str(path), digest=sha256_digest(data))


def _open_folder(folder: Path) -> Dataset:
    root = folder.resolve()

    def read(name: str) -> bytes | None:
        file = folder.joinpath(*PurePosixPath(name).parts)
        return file.read_bytes() if file.is_file() else None

    def escapes(name: str) -> bool:
        return (
            not root.joinpath(*PurePosixPath(name).parts).resolve().is_relative_to(root)
        )

    return _open_descriptor(read, str(folder), digest=None, escapes=escapes)


def _folder_holding(file: Path) -> Path | None:
    """The bundle folder whose descriptor lists `file`, searching up two levels."""
    resolved = file.resolve()
    for folder in (resolved.parent, resolved.parent.parent):
        descriptor = folder / DESCRIPTOR
        if not descriptor.is_file():
            continue
        if resolved == descriptor:
            return folder
        package = json.loads(descriptor.read_bytes())
        for resource in _resources(package):
            path = resource.get("path")
            if isinstance(path, str) and (folder / path).resolve() == resolved:
                return folder
    return None


def _open_descriptor(
    read: Callable[[str], bytes | None],
    where: str,
    *,
    digest: str | None,
    escapes: Callable[[str], bool] | None = None,
) -> Dataset:
    """Read a bundle through `read`; `escapes` says whether a listed path
    resolves outside the bundle, for a folder on disk."""
    raw = read(DESCRIPTOR)
    if raw is None:
        raise BundleError("no_descriptor", f"{where} holds no {DESCRIPTOR}")
    package = json.loads(raw)
    _check_paths(package, where, escapes)
    resources = _resources(package)
    files = {
        resource["path"]: _checked(read, resource, where)
        for resource in resources
        if isinstance(resource.get("path"), str)
    }
    data = next(
        (
            resource
            for resource in resources
            if resource.get("name") == package.get("name")
            and isinstance(resource.get("path"), str)
        ),
        None,
    )
    if data is None:
        raise BundleError(
            "no_data_resource",
            f"{where}: {DESCRIPTOR} names no data table called {package.get('name')!r}",
        )
    table = _read_table(files[data["path"]], data)
    return _bundle_dataset(package, data, table, digest=digest)


def _check_paths(
    package: object, where: str, escapes: Callable[[str], bool] | None
) -> None:
    """Refuse a descriptor that lists a file outside its bundle.

    Raises:
        FormatError: A resource's `path` holds a backslash, a drive, a root or
            a `..` segment, or resolves outside the bundle.
    """
    resources = package.get("resources") if isinstance(package, Mapping) else None
    for index, resource in enumerate(resources if isinstance(resources, list) else ()):
        path = resource.get("path") if isinstance(resource, Mapping) else None
        if not isinstance(path, str):
            continue
        if not _relative(path) or (escapes is not None and escapes(path)):
            raise FormatError(
                "format_invalid",
                f"/resources/{index}/path",
                f"{where}: {DESCRIPTOR} lists {path!r}, which is outside the bundle",
            )


def _relative(path: str) -> bool:
    """Whether `path` is a plain relative path in both POSIX and Windows terms."""
    if "\\" in path:
        return False
    windows = PureWindowsPath(path)
    if windows.drive or windows.root or PurePosixPath(path).is_absolute():
        return False
    return ".." not in PurePosixPath(path).parts


def _resources(package: object) -> list[Mapping[str, Any]]:
    resources = package.get("resources") if isinstance(package, Mapping) else None
    if not isinstance(resources, list):
        return []
    return [resource for resource in resources if isinstance(resource, Mapping)]


def _checked(
    read: Callable[[str], bytes | None], resource: Mapping[str, Any], where: str
) -> bytes:
    """The resource's bytes, checked against the hash its descriptor gives."""
    path = resource["path"]
    content = read(path)
    if content is None:
        raise BundleError("missing_file", f"{where} lacks {path}, which it lists")
    expected = resource.get("hash")
    if isinstance(expected, str):
        algorithm, _, value = expected.rpartition(":")
        actual = hashlib.new(algorithm or "md5", content).hexdigest()
        if actual != value.lower():
            raise BundleError(
                "hash_mismatch",
                f"{where}: {path} does not match its hash; download the bundle again",
            )
    return content


def _read_table(content: bytes, resource: Mapping[str, Any]) -> pa.Table:
    schema = resource.get("schema")
    fields = schema.get("fields", []) if isinstance(schema, Mapping) else []
    types = {
        field["name"]: _FIELD_TYPES.get(field.get("type", "string"), pa.string())
        for field in fields
        if isinstance(field, Mapping) and isinstance(field.get("name"), str)
    }
    missing = schema.get("missingValues", [""]) if isinstance(schema, Mapping) else [""]
    if resource.get("format") == "xlsx":
        return _read_xlsx(content, resource, types, missing)
    return pa_csv.read_csv(
        io.BytesIO(content),
        convert_options=pa_csv.ConvertOptions(
            column_types=types,
            null_values=missing,
            strings_can_be_null=True,
        ),
    )


def _read_xlsx(
    content: bytes,
    resource: Mapping[str, Any],
    types: Mapping[str, pa.DataType],
    missing: Sequence[str],
) -> pa.Table:
    try:
        import openpyxl  # noqa: PLC0415 - an optional extra, imported on use
    except ImportError as error:
        raise ImportError(
            "reading an XLSX bundle needs openpyxl: "
            "pip install 'development-finance[xlsx]'"
        ) from error
    workbook = openpyxl.load_workbook(
        io.BytesIO(content), read_only=True, data_only=True
    )
    try:
        dialect = resource.get("dialect")
        sheet_name = dialect.get("sheetName") if isinstance(dialect, Mapping) else None
        sheet = workbook[sheet_name] if sheet_name else workbook.worksheets[0]
        rows = sheet.iter_rows(values_only=True)
        header = [str(name) for name in next(rows, ())]
        columns: list[list[Any]] = [[] for _ in header]
        for row in rows:
            for index, column in enumerate(columns):
                value = row[index] if index < len(row) else None
                column.append(None if value in missing else value)
    finally:
        workbook.close()
    return pa.table(
        {
            name: pa.array(
                _cells(values, types.get(name, pa.string())),
                type=types.get(name, pa.string()),
            )
            for name, values in zip(header, columns, strict=True)
        }
    )


def _cells(values: list[Any], kind: pa.DataType) -> list[Any]:
    """XLSX cells as the column's Arrow type takes them."""
    if pa.types.is_string(kind):
        return [None if value is None else str(value) for value in values]
    if pa.types.is_date32(kind):
        return [value.date() if hasattr(value, "date") else value for value in values]
    return values


def _bundle_dataset(
    package: Mapping[str, Any],
    data: Mapping[str, Any],
    table: pa.Table,
    *,
    digest: str | None,
) -> Dataset:
    title = str(package.get("title") or data.get("title") or package.get("name"))
    citation = Citation(text=title, sources=_bundle_sources(package))
    members: tuple[Member, ...] = ()
    dfo = package.get("dfo")
    definition = dfo.get("spec") if isinstance(dfo, Mapping) else None
    if digest is not None and isinstance(definition, Mapping):
        assert isinstance(dfo, Mapping)
        members = (
            Member(
                parts=(),
                spec=Spec(str(definition["spec_id"]), definition),
                content_version=str(dfo["content_version"]),
                sentence=title,
                citation=citation,
                digest=digest,
                rendering=Rendering(str(data.get("format", "csv")), True),
            ),
        )
    return Dataset(
        sentence=title,
        members=members,
        citation=citation,
        warnings=(),
        departures=(),
        requested_operations=(),
        complete=True,
        missing=(),
        held_until=None,
        pinned=False,
        stale=False,
        layout_version="bundle",
        _table=table,
    )


def _bundle_sources(package: Mapping[str, Any]) -> tuple[CitationSource, ...]:
    """The descriptor's sources, each with its licence and its graph id when known."""
    sources = [
        source for source in package.get("sources") or [] if isinstance(source, Mapping)
    ]
    licences = [
        licence
        for licence in package.get("licenses") or []
        if isinstance(licence, Mapping)
    ]
    dfo = package.get("dfo")
    links = dfo.get("links") if isinstance(dfo, Mapping) else None
    documentation = links.get("documentation") if isinstance(links, Mapping) else None
    refs = list(documentation) if isinstance(documentation, Mapping) else []
    if len(refs) != len(sources):
        refs = [str(source.get("title", "")) for source in sources]
    if len(licences) != len(sources):
        licences = [licences[0]] * len(sources) if len(licences) == 1 else []
    return tuple(
        CitationSource(
            ref=ref,
            label=str(source.get("title", "")),
            licence=_text(licences[index].get("title")) if licences else None,
            licence_url=_text(licences[index].get("path")) if licences else None,
            url=_text(source.get("path")),
        )
        for index, (source, ref) in enumerate(zip(sources, refs, strict=True))
    )


def _text(value: object) -> str | None:
    return value if isinstance(value, str) else None
