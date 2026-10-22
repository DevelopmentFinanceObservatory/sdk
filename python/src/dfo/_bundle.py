"""Open a saved dataset or a bundle downloaded from the website.

`open_bundle` reads a Parquet file `Dataset.save` wrote, or a website bundle as a
ZIP, an extracted folder, or a file inside one. A bundle's `datapackage.json`
types the data's CSV or XLSX columns and gives each file's hash, which is checked
before the data is read. `BundleLimits` bounds its descriptor, entry count,
resource count, archive, resource and aggregate bytes. Every file it lists must
lie inside the bundle. A path with a backslash, a drive, a root or a `..` segment
is refused before any file is read, and so is a path in an extracted folder that
resolves outside it through a symlink.

Both clients call this module. It is sync and works on local files only.
"""

import hashlib
import io
import json
import zipfile
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from os import PathLike
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import IO, Any, Literal

import pyarrow as pa
import pyarrow.csv as pa_csv
import pyarrow.parquet as pq

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
    "not_a_bundle",
    "no_descriptor",
    "no_data_resource",
    "missing_file",
    "hash_mismatch",
    "resource_limit",
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
_CHUNK_SIZE = 64 * 1024


@dataclass(frozen=True, slots=True, kw_only=True)
class BundleLimits:
    """The resource limits `open_bundle` applies to website bundles.

    Attributes:
        max_descriptor_bytes: The largest `datapackage.json` the reader accepts.
        max_zip_entries: The most ZIP entries the reader accepts.
        max_resources: The most descriptor resources the reader accepts.
        max_archive_bytes: The largest ZIP file whose digest the reader computes.
        max_resource_bytes: The largest actual byte count of one resource.
        max_total_bytes: The largest actual byte count across the descriptor and
            all resources the reader verifies.
        max_xlsx_entries: The most entries in an XLSX resource's inner ZIP.
        max_xlsx_expanded_bytes: The largest cumulative declared expanded size
            of entries in an XLSX resource's inner ZIP.
        max_xlsx_rows: The most data rows read from an XLSX worksheet.
        max_xlsx_cells: The most header and data cells read from an XLSX worksheet.

    The defaults allow a 512 MiB bundle with at most 128 resources and 256 ZIP
    entries. They also allow an XLSX with 128 inner ZIP entries, 32 MiB of
    declared expanded content, 100,000 data rows, and 1,000,000 visited cells.
    XLSX metadata, row, and cell limits reduce workbook work but do not hard-bound
    an XLSX parser's memory or CPU use.
    """

    max_descriptor_bytes: int = 1 * 1024**2
    max_zip_entries: int = 256
    max_resources: int = 128
    max_archive_bytes: int = 512 * 1024**2
    max_resource_bytes: int = 256 * 1024**2
    max_total_bytes: int = 512 * 1024**2
    max_xlsx_entries: int = 128
    max_xlsx_expanded_bytes: int = 32 * 1024**2
    max_xlsx_rows: int = 100_000
    max_xlsx_cells: int = 1_000_000

    def __post_init__(self) -> None:
        for name, value in (
            ("max_descriptor_bytes", self.max_descriptor_bytes),
            ("max_zip_entries", self.max_zip_entries),
            ("max_resources", self.max_resources),
            ("max_archive_bytes", self.max_archive_bytes),
            ("max_resource_bytes", self.max_resource_bytes),
            ("max_total_bytes", self.max_total_bytes),
            ("max_xlsx_entries", self.max_xlsx_entries),
            ("max_xlsx_expanded_bytes", self.max_xlsx_expanded_bytes),
            ("max_xlsx_rows", self.max_xlsx_rows),
            ("max_xlsx_cells", self.max_xlsx_cells),
        ):
            if not isinstance(value, int) or isinstance(value, bool) or value < 1:
                raise ValueError(f"{name} must be a positive integer")


@dataclass(slots=True)
class _ByteBudget:
    """The actual bytes read while a descriptor and its resources are verified."""

    limits: BundleLimits
    total: int = 0


DEFAULT_BUNDLE_LIMITS = BundleLimits()


class BundleError(ValueError):
    """A path holds no dataset `open_bundle` can read.

    Attributes:
        reason: `not_a_bundle` for a file that is neither a saved dataset nor part
            of a bundle, `no_descriptor` for data with no `datapackage.json`,
            `no_data_resource` for a descriptor that names no data table,
            `missing_file` for a file the descriptor lists but the bundle lacks,
            `hash_mismatch` for a file whose bytes differ from its hash, or
            `resource_limit` when a bundle exceeds a `BundleLimits` bound.
    """

    def __init__(self, reason: BundleErrorReason, message: str) -> None:
        super().__init__(message)
        self.reason: BundleErrorReason = reason


def open_bundle(
    path: str | PathLike[str], /, *, limits: BundleLimits = DEFAULT_BUNDLE_LIMITS
) -> Dataset:
    """Open a dataset saved by `Dataset.save`, or a bundle downloaded from the website.

    Args:
        path: A Parquet file `save` wrote, a bundle's ZIP, the folder it extracts
            to, or its `datapackage.json` or data file.
        limits: Resource limits for a website bundle. The default accepts a 1 MiB
            descriptor, 256 ZIP entries, 128 resources, a 512 MiB archive, one
            256 MiB resource, and 512 MiB total bytes read. An XLSX may contain
            128 inner ZIP entries with 32 MiB declared expanded bytes, 100,000
            data rows, and 1,000,000 visited cells.

    Raises:
        BundleError: The path holds no saved dataset or bundle, a lone CSV or
            XLSX has no descriptor beside it, or a file's bytes differ from the
            hash its descriptor gives.
        FormatError: The descriptor lists a file outside the bundle.
        ValueError: A saved file comes from a later format version.
    """
    target = Path(path)
    if target.is_dir():
        return _open_folder(target, limits)
    with target.open("rb") as file:
        magic = file.read(4)
    if magic == _ZIP_MAGIC:
        return _open_zip(target, limits)
    if magic == _PARQUET_MAGIC:
        return _open_saved(target)
    folder = _folder_holding(target, limits)
    if folder is None:
        raise BundleError(
            "no_descriptor",
            f"{target} has no {DESCRIPTOR} beside it, so its columns cannot be "
            "typed: download the bundle, or fetch the dataset with dfo.fetch",
        )
    return _open_folder(folder, limits)


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


def _open_zip(path: Path, limits: BundleLimits) -> Dataset:
    digest = _digest_path(path, limits.max_archive_bytes, str(path))
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if len(entries) > limits.max_zip_entries:
            _limited(
                str(path),
                f"has {len(entries)} ZIP entries, above the limit of {limits.max_zip_entries}",
            )
        infos = {entry.filename: entry for entry in entries}

        def open_file(name: str) -> IO[bytes] | None:
            info = infos.get(name)
            return archive.open(info) if info is not None else None

        return _open_descriptor(open_file, str(path), digest=digest, limits=limits)


def _open_folder(folder: Path, limits: BundleLimits) -> Dataset:
    root = folder.resolve()

    def open_file(name: str) -> IO[bytes] | None:
        file = folder.joinpath(*PurePosixPath(name).parts)
        return file.open("rb") if file.is_file() else None

    def escapes(name: str) -> bool:
        return (
            not root.joinpath(*PurePosixPath(name).parts).resolve().is_relative_to(root)
        )

    return _open_descriptor(
        open_file, str(folder), digest=None, limits=limits, escapes=escapes
    )


def _folder_holding(file: Path, limits: BundleLimits) -> Path | None:
    """The bundle folder whose descriptor lists `file`, searching up two levels."""
    resolved = file.resolve()
    for folder in (resolved.parent, resolved.parent.parent):
        descriptor = folder / DESCRIPTOR
        if not descriptor.is_file():
            continue
        if resolved == descriptor:
            return folder
        package = _read_descriptor_path(descriptor, limits)
        _check_resource_count(package, str(folder), limits)
        for resource in _resources(package):
            path = resource.get("path")
            if isinstance(path, str) and (folder / path).resolve() == resolved:
                return folder
    return None


def _open_descriptor(
    open_file: Callable[[str], IO[bytes] | None],
    where: str,
    *,
    digest: str | None,
    limits: BundleLimits,
    escapes: Callable[[str], bool] | None = None,
) -> Dataset:
    """Read a bundle through `open_file`. `escapes` says whether a listed path
    resolves outside the bundle, for a folder on disk."""
    budget = _ByteBudget(limits)
    package = _read_descriptor(open_file, where, budget)
    if not isinstance(package, Mapping):
        raise BundleError(
            "not_a_bundle", f"{where}: {DESCRIPTOR} must be a JSON object"
        )
    _check_resource_count(package, where, limits)
    _check_paths(package, where, escapes)
    resources = _resources(package)
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
    for resource in resources:
        if resource is not data and isinstance(resource.get("path"), str):
            _checked(open_file, resource, where, budget, keep=False)
    content = _checked(open_file, data, where, budget, keep=True)
    assert content is not None
    table = _read_table(content, data, limits)
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


def _check_resource_count(package: object, where: str, limits: BundleLimits) -> None:
    resources = package.get("resources") if isinstance(package, Mapping) else None
    count = len(resources) if isinstance(resources, list) else 0
    if count > limits.max_resources:
        _limited(
            where,
            f"lists {count} resources, above the limit of {limits.max_resources}",
        )


def _limited(where: str, detail: str) -> None:
    raise BundleError("resource_limit", f"{where} {detail}")


def _digest_path(path: Path, limit: int, where: str) -> str:
    """Hash a ZIP from disk without retaining its compressed bytes."""
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as file:
        while chunk := file.read(min(_CHUNK_SIZE, limit - size + 1)):
            size += len(chunk)
            if size > limit:
                _limited(where, f"is larger than the archive limit of {limit} bytes")
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def _read_descriptor_path(path: Path, limits: BundleLimits) -> object:
    """Read one candidate folder descriptor under its descriptor limit."""
    with path.open("rb") as file:
        raw = _read_limited(
            file,
            str(path),
            _ByteBudget(limits),
            limit=limits.max_descriptor_bytes,
            keep=True,
            digest=None,
        )
    assert raw is not None
    return json.loads(raw)


def _read_descriptor(
    open_file: Callable[[str], IO[bytes] | None], where: str, budget: _ByteBudget
) -> object:
    """Read and decode a bundle descriptor under its byte budget."""
    file = open_file(DESCRIPTOR)
    if file is None:
        raise BundleError("no_descriptor", f"{where} holds no {DESCRIPTOR}")
    with file:
        raw = _read_limited(
            file,
            DESCRIPTOR,
            budget,
            limit=budget.limits.max_descriptor_bytes,
            keep=True,
            digest=None,
        )
    assert raw is not None
    return json.loads(raw)


def _checked(
    open_file: Callable[[str], IO[bytes] | None],
    resource: Mapping[str, Any],
    where: str,
    budget: _ByteBudget,
    *,
    keep: bool,
) -> bytes | None:
    """Stream and hash one resource, retaining bytes only when `keep` is true."""
    path = resource["path"]
    file = open_file(path)
    if file is None:
        raise BundleError("missing_file", f"{where} lacks {path}, which it lists")
    expected = resource.get("hash")
    algorithm, _, value = (
        expected.rpartition(":") if isinstance(expected, str) else ("", "", "")
    )
    digest = hashlib.new(algorithm or "md5") if isinstance(expected, str) else None
    with file:
        content = _read_limited(
            file,
            path,
            budget,
            limit=budget.limits.max_resource_bytes,
            keep=keep,
            digest=digest,
        )
    if isinstance(expected, str):
        assert digest is not None
        if digest.hexdigest() != value.lower():
            raise BundleError(
                "hash_mismatch",
                f"{where}: {path} does not match its hash; download the bundle again",
            )
    return content


def _read_limited(
    file: IO[bytes],
    path: str,
    budget: _ByteBudget,
    *,
    limit: int,
    keep: bool,
    digest: Any | None,
) -> bytes | None:
    """Read one file in chunks, enforcing actual per-file and total bytes."""
    content = bytearray() if keep else None
    size = 0
    while True:
        resource_left = limit - size
        total_left = budget.limits.max_total_bytes - budget.total
        if resource_left < 0:
            _limited(path, f"is larger than the resource limit of {limit} bytes")
        if total_left < 0:
            _limited(
                path,
                f"exceeds the total bundle limit of {budget.limits.max_total_bytes} bytes",
            )
        read_size = min(_CHUNK_SIZE, resource_left, total_left)
        chunk = file.read(read_size + 1)
        if not chunk:
            break
        if len(chunk) > resource_left:
            _limited(path, f"is larger than the resource limit of {limit} bytes")
        if len(chunk) > total_left:
            _limited(
                path,
                f"exceeds the total bundle limit of {budget.limits.max_total_bytes} bytes",
            )
        size += len(chunk)
        budget.total += len(chunk)
        if digest is not None:
            digest.update(chunk)
        if content is not None:
            content.extend(chunk)
    return bytes(content) if content is not None else None


def _read_table(
    content: bytes, resource: Mapping[str, Any], limits: BundleLimits
) -> pa.Table:
    schema = resource.get("schema")
    fields = schema.get("fields", []) if isinstance(schema, Mapping) else []
    types = {
        field["name"]: _FIELD_TYPES.get(field.get("type", "string"), pa.string())
        for field in fields
        if isinstance(field, Mapping) and isinstance(field.get("name"), str)
    }
    missing = schema.get("missingValues", [""]) if isinstance(schema, Mapping) else [""]
    if resource.get("format") == "xlsx":
        return _read_xlsx(content, resource, types, missing, limits)
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
    limits: BundleLimits,
) -> pa.Table:
    path = str(resource.get("path", "XLSX resource"))
    _check_xlsx_archive(content, path, limits)
    try:
        import openpyxl  # noqa: PLC0415 - an optional extra, imported on use
    except ImportError as error:
        raise ImportError(
            "reading an XLSX bundle needs openpyxl: "
            "pip install 'development-finance[xlsx]'"
        ) from error
    with io.BytesIO(content) as stream:
        workbook = openpyxl.load_workbook(stream, read_only=True, data_only=True)
        try:
            dialect = resource.get("dialect")
            sheet_name = (
                dialect.get("sheetName") if isinstance(dialect, Mapping) else None
            )
            sheet = workbook[sheet_name] if sheet_name else workbook.worksheets[0]
            _check_xlsx_dimensions(sheet, path, limits)
            rows = sheet.iter_rows(values_only=True)
            raw_header = next(rows, ())
            cells = len(raw_header)
            if cells > limits.max_xlsx_cells:
                _limited(
                    path,
                    f"has more than {limits.max_xlsx_cells} header and data cells",
                )
            header = [str(name) for name in raw_header]
            columns: list[list[Any]] = [[] for _ in header]
            for data_rows, row in enumerate(rows, start=1):
                if data_rows > limits.max_xlsx_rows:
                    _limited(path, f"has more than {limits.max_xlsx_rows} data rows")
                cells += len(row)
                if cells > limits.max_xlsx_cells:
                    _limited(
                        path,
                        f"has more than {limits.max_xlsx_cells} header and data cells",
                    )
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


def _check_xlsx_archive(content: bytes, path: str, limits: BundleLimits) -> None:
    """Check public XLSX ZIP metadata before openpyxl opens its workbook."""
    with io.BytesIO(content) as stream, zipfile.ZipFile(stream) as archive:
        entries = archive.infolist()
        if len(entries) > limits.max_xlsx_entries:
            _limited(
                path,
                "has "
                f"{len(entries)} XLSX ZIP entries, above the limit of "
                f"{limits.max_xlsx_entries}",
            )
        expanded_bytes = sum(entry.file_size for entry in entries)
        if expanded_bytes > limits.max_xlsx_expanded_bytes:
            _limited(
                path,
                "has "
                f"{expanded_bytes} declared XLSX expanded bytes, above the limit of "
                f"{limits.max_xlsx_expanded_bytes}",
            )


def _check_xlsx_dimensions(sheet: Any, path: str, limits: BundleLimits) -> None:
    """Reject declared worksheet dimensions that exceed XLSX row or cell caps."""
    rows = sheet.max_row
    columns = sheet.max_column
    if (
        not isinstance(rows, int)
        or not isinstance(columns, int)
        or rows < 1
        or columns < 1
    ):
        return
    if rows - 1 > limits.max_xlsx_rows:
        _limited(path, f"has more than {limits.max_xlsx_rows} data rows")
    if rows * columns > limits.max_xlsx_cells:
        _limited(
            path,
            f"has more than {limits.max_xlsx_cells} header and data cells",
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
