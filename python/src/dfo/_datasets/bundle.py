"""Open a saved dataset or a bundle downloaded from the website.

`load` reads a Parquet file `Dataset.save` wrote, or a website bundle as a
ZIP, an extracted folder, or a file inside one. A bundle's `datapackage.json`
types the data's CSV or XLSX columns and gives each file's SHA-256 hash, which is
checked before the data is read. `BundleLimits` bounds its descriptor, entry count,
resource count, archive, resource and aggregate bytes. Every file it lists must
lie inside the bundle under a plain relative path: `/`-separated names, none of
them empty, `.` or `..`, with no backslash, drive or NUL. Any other path is refused
before any file is read, and so is a path in an extracted folder that resolves
outside it through a symlink. A ZIP and the folder it extracts to therefore read
the same.

Both clients call this module. It is sync and works on local files only. It imports
pyarrow inside the functions that read a table, so `import dfo` stays light.
"""

from __future__ import annotations

import hashlib
import io
import zipfile
from collections import Counter
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass, fields
from os import PathLike
from pathlib import Path, PureWindowsPath
from typing import IO, TYPE_CHECKING, Any, Literal, override

from dfo._core.refs import Member
from dfo._core.types import (
    CONTENT_VERSION,
    DIGEST,
    Citation,
    CitationSource,
    FormatError,
    Rendering,
    Spec,
    decode,
    load_definition,
    matches,
    object_at,
)
from dfo._datasets.dataset import Dataset, saved_dataset

if TYPE_CHECKING:
    import pyarrow as pa

DESCRIPTOR = "datapackage.json"

type BundleErrorReason = Literal[
    "not_a_bundle",
    "no_descriptor",
    "no_data_resource",
    "missing_file",
    "hash_mismatch",
    "resource_limit",
]

_SHA256 = "sha256:"
_ZIP_MAGIC = b"PK\x03\x04"
_PARQUET_MAGIC = b"PAR1"
_CHUNK_SIZE = 64 * 1024


@dataclass(frozen=True, slots=True, kw_only=True)
class BundleLimits:
    """The resource limits `load` applies to website bundles.

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

    @override
    def __repr__(self) -> str:
        """The limits that differ from the defaults, as `BundleLimits(max_zip_entries=10)`."""
        changed = ", ".join(
            f"{limit.name}={getattr(self, limit.name):_}"
            for limit in fields(self)
            if getattr(self, limit.name) != limit.default
        )
        return f"BundleLimits({changed})"

    def __post_init__(self) -> None:
        for limit in fields(self):
            value = getattr(self, limit.name)
            if not isinstance(value, int) or isinstance(value, bool) or value < 1:
                raise ValueError(f"{limit.name} must be a positive integer")


@dataclass(slots=True)
class _ByteBudget:
    """The actual bytes read while a descriptor and its resources are verified."""

    limits: BundleLimits
    total: int = 0


DEFAULT_BUNDLE_LIMITS = BundleLimits()


class BundleError(ValueError):
    """A path holds no dataset `dfo.load` can read.

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


def load(
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
        FormatError: The descriptor is not a JSON object, lists a file outside
            the bundle or without a SHA-256 hash, or breaks the descriptor
            format; the data does not fit the columns its descriptor types; or
            a saved dataset's provenance is damaged.
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
    import pyarrow.parquet as pq  # noqa: PLC0415 - pyarrow loads on first use

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
    digest = _digest_path(path, limits.max_archive_bytes)
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
        file = folder.joinpath(*name.split("/"))
        return file.open("rb") if file.is_file() else None

    def escapes(name: str) -> bool:
        return not root.joinpath(*name.split("/")).resolve().is_relative_to(root)

    if escapes(DESCRIPTOR):
        raise FormatError(
            "format_invalid", "", f"{folder}: {DESCRIPTOR} links outside the bundle"
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
        for resource in _resources(package, str(folder), limits):
            path = resource.get("path") if isinstance(resource, Mapping) else None
            if (
                isinstance(path, str)
                and _plain(path)
                and folder.joinpath(*path.split("/")).resolve() == resolved
            ):
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
    files = _files(_resources(package, where, limits), where, escapes)
    spec = _bundle_spec(package)
    data = next(
        (
            (index, resource)
            for index, resource in files
            if resource.get("name") == package.get("name")
        ),
        None,
    )
    if data is None:
        raise BundleError(
            "no_data_resource",
            f"{where}: {DESCRIPTOR} names no data table called {package.get('name')!r}",
        )
    data_index, data_resource = data
    for _, resource in files:
        if resource is not data_resource:
            _checked(open_file, resource, where, budget, keep=False)
    content = _checked(open_file, data_resource, where, budget, keep=True)
    assert content is not None
    table = _read_table(content, data_resource, f"/resources/{data_index}", limits)
    return _bundle_dataset(package, data_resource, table, spec=spec, digest=digest)


def _files(
    resources: Sequence[Any], where: str, escapes: Callable[[str], bool] | None
) -> list[tuple[int, Mapping[str, Any]]]:
    """The resources that name a file, with their index, each checked before any read.

    Raises:
        FormatError: A resource's `path` is not a plain relative path, resolves
            outside the bundle, or comes without a SHA-256 `hash`.
    """
    files: list[tuple[int, Mapping[str, Any]]] = []
    for index, resource in enumerate(resources):
        path = resource.get("path") if isinstance(resource, Mapping) else None
        if not isinstance(path, str):
            continue
        if not _plain(path) or (escapes is not None and escapes(path)):
            raise FormatError(
                "format_invalid",
                f"/resources/{index}/path",
                f"{where}: {DESCRIPTOR} lists {path!r}, which is not a plain path "
                "inside the bundle",
            )
        if not matches(DIGEST, resource.get("hash")):
            raise FormatError(
                "format_invalid",
                f"/resources/{index}/hash",
                f"{where}: {DESCRIPTOR} gives {path} no {_SHA256}<hex> hash",
            )
        files.append((index, resource))
    return files


def _plain(path: str) -> bool:
    """Whether `path` is a plain relative path, which a ZIP and a folder read alike.

    Its `/`-separated names are none of them empty, `.` or `..`, and it holds no
    backslash, Windows drive or NUL.
    """
    if "\\" in path or "\0" in path or PureWindowsPath(path).drive:
        return False
    return all(name not in {"", ".", ".."} for name in path.split("/"))


def _resources(
    package: Mapping[str, Any], where: str, limits: BundleLimits
) -> list[Any]:
    """The descriptor's `resources` array, empty when it holds none.

    Raises:
        BundleError: It lists more resources than `limits` allows (`resource_limit`).
    """
    resources = package.get("resources")
    listed = resources if isinstance(resources, list) else []
    if len(listed) > limits.max_resources:
        _limited(
            where,
            f"lists {len(listed)} resources, above the limit of {limits.max_resources}",
        )
    return listed


def _limited(where: str, detail: str) -> None:
    raise BundleError("resource_limit", f"{where} {detail}")


def _digest_path(path: Path, limit: int) -> str:
    """Hash a ZIP from disk without retaining its compressed bytes."""
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as file:
        while chunk := file.read(min(_CHUNK_SIZE, limit - size + 1)):
            size += len(chunk)
            if size > limit:
                _limited(
                    str(path), f"is larger than the archive limit of {limit} bytes"
                )
            digest.update(chunk)
    return _SHA256 + digest.hexdigest()


def _read_descriptor_path(path: Path, limits: BundleLimits) -> Mapping[str, Any]:
    """Read one candidate folder descriptor under its descriptor limit."""
    with path.open("rb") as file:
        return _decoded(file, str(path), _ByteBudget(limits))


def _read_descriptor(
    open_file: Callable[[str], IO[bytes] | None], where: str, budget: _ByteBudget
) -> Mapping[str, Any]:
    """Read and decode a bundle descriptor under its byte budget."""
    file = open_file(DESCRIPTOR)
    if file is None:
        raise BundleError("no_descriptor", f"{where} holds no {DESCRIPTOR}")
    with file:
        return _decoded(file, DESCRIPTOR, budget)


def _decoded(file: IO[bytes], name: str, budget: _ByteBudget) -> Mapping[str, Any]:
    """A descriptor's JSON object, read under the descriptor limit."""
    limit = budget.limits.max_descriptor_bytes
    return decode(b"".join(_chunks(file, name, budget, limit=limit)))


def _checked(
    open_file: Callable[[str], IO[bytes] | None],
    resource: Mapping[str, Any],
    where: str,
    budget: _ByteBudget,
    *,
    keep: bool,
) -> bytes | None:
    """Stream and hash one resource `_files` checked, retaining bytes only when
    `keep` is true."""
    path = resource["path"]
    file = open_file(path)
    if file is None:
        raise BundleError("missing_file", f"{where} lacks {path}, which it lists")
    digest = hashlib.sha256()
    content = bytearray()
    with file:
        for chunk in _chunks(
            file, path, budget, limit=budget.limits.max_resource_bytes
        ):
            digest.update(chunk)
            if keep:
                content.extend(chunk)
    if _SHA256 + digest.hexdigest() != resource["hash"]:
        raise BundleError(
            "hash_mismatch",
            f"{where}: {path} does not match its hash; download the bundle again",
        )
    return bytes(content) if keep else None


def _chunks(
    file: IO[bytes], path: str, budget: _ByteBudget, *, limit: int
) -> Iterator[bytes]:
    """Read one file in chunks, enforcing actual per-file and total bytes.

    Each read asks for one byte more than the limits leave, so a file over a
    limit is refused at its first excess byte.
    """
    size = 0
    while True:
        resource_left = limit - size
        total_left = budget.limits.max_total_bytes - budget.total
        chunk = file.read(min(_CHUNK_SIZE, resource_left, total_left) + 1)
        if not chunk:
            return
        if len(chunk) > resource_left:
            _limited(path, f"is larger than the resource limit of {limit} bytes")
        if len(chunk) > total_left:
            _limited(
                path,
                f"exceeds the total bundle limit of {budget.limits.max_total_bytes} bytes",
            )
        size += len(chunk)
        budget.total += len(chunk)
        yield chunk


def _field_types() -> Mapping[str, pa.DataType]:
    """Table Schema field types and the Arrow types their columns read as.

    A type not listed reads as a string.
    """
    import pyarrow as pa  # noqa: PLC0415 - pyarrow loads on first use

    return {
        "string": pa.string(),
        "integer": pa.int64(),
        "number": pa.float64(),
        "boolean": pa.bool_(),
        "date": pa.date32(),
        "datetime": pa.timestamp("us"),
        "year": pa.int64(),
    }


def _read_table(
    content: bytes, resource: Mapping[str, Any], pointer: str, limits: BundleLimits
) -> pa.Table:
    """The data resource at `pointer` in the descriptor, typed by its schema.

    Raises:
        FormatError: A field's type is not a string, the missing values are not
            strings, or the data does not fit its columns: a column without a
            name, two columns of one name, an XLSX formula, or a value its
            column's type cannot hold exactly.
    """
    import pyarrow as pa  # noqa: PLC0415 - pyarrow loads on first use
    import pyarrow.csv as pa_csv  # noqa: PLC0415 - pyarrow loads on first use

    path = str(resource["path"])
    types, missing = _schema(resource, pointer)
    if resource.get("format") == "xlsx":
        table = _read_xlsx(
            content,
            resource,
            pointer=pointer,
            types=types,
            missing=missing,
            limits=limits,
        )
    else:
        try:
            table = pa_csv.read_csv(
                io.BytesIO(content),
                convert_options=pa_csv.ConvertOptions(
                    column_types=types,
                    null_values=missing,
                    strings_can_be_null=True,
                ),
            )
        except pa.ArrowInvalid as error:
            raise FormatError("format_invalid", pointer, f"{path}: {error}") from error
    repeated = {
        name for name, count in Counter(table.column_names).items() if count > 1
    }
    if repeated:
        raise FormatError(
            "format_invalid",
            pointer,
            f"{path} holds more than one column named {', '.join(sorted(repeated))}",
        )
    return table


def _schema(
    resource: Mapping[str, Any], pointer: str
) -> tuple[dict[str, pa.DataType], list[str]]:
    """The Arrow type of each column the resource's schema names, and the cell
    texts that read as null."""
    import pyarrow as pa  # noqa: PLC0415 - pyarrow loads on first use

    schema = resource.get("schema")
    if not isinstance(schema, Mapping):
        return {}, [""]
    fields = schema.get("fields", [])
    field_types = _field_types()
    types: dict[str, pa.DataType] = {}
    for index, field in enumerate(fields if isinstance(fields, list) else ()):
        if not isinstance(field, Mapping) or not isinstance(field.get("name"), str):
            continue
        kind = field.get("type", "string")
        if not isinstance(kind, str):
            raise FormatError(
                "format_invalid",
                f"{pointer}/schema/fields/{index}/type",
                "not a string",
            )
        types[field["name"]] = field_types.get(kind, pa.string())
    missing = schema.get("missingValues", [""])
    if not isinstance(missing, list) or not all(
        isinstance(value, str) for value in missing
    ):
        raise FormatError(
            "format_invalid",
            f"{pointer}/schema/missingValues",
            "not an array of strings",
        )
    return types, missing


def _read_xlsx(
    content: bytes,
    resource: Mapping[str, Any],
    *,
    pointer: str,
    types: Mapping[str, pa.DataType],
    missing: Sequence[str],
    limits: BundleLimits,
) -> pa.Table:
    import pyarrow as pa  # noqa: PLC0415 - pyarrow loads on first use

    path = str(resource["path"])
    _check_xlsx_archive(content, path, limits)
    try:
        import openpyxl  # noqa: PLC0415 - an optional extra, imported on use
    except ImportError as error:
        raise ImportError(
            "reading an XLSX bundle needs openpyxl: "
            "pip install 'development-finance[xlsx]'"
        ) from error
    with io.BytesIO(content) as stream:
        # Formulas stay unevaluated, so a formula cell reads as one and is refused,
        # whether or not the workbook caches its result.
        workbook = openpyxl.load_workbook(stream, read_only=True, data_only=False)
        try:
            dialect = resource.get("dialect")
            sheet_name = (
                dialect.get("sheetName") if isinstance(dialect, Mapping) else None
            )
            sheet = workbook[sheet_name] if sheet_name else workbook.worksheets[0]
            _check_xlsx_dimensions(sheet, path, limits)
            rows = sheet.iter_rows()
            raw_header = next(rows, ())
            cells = len(raw_header)
            if cells > limits.max_xlsx_cells:
                _limited(
                    path,
                    f"has more than {limits.max_xlsx_cells} header and data cells",
                )
            header: list[str] = []
            for number, cell in enumerate(raw_header, start=1):
                name = _value(cell, path, pointer)
                if name is None:
                    raise FormatError(
                        "format_invalid",
                        pointer,
                        f"{path}: column {number} has no name",
                    )
                header.append(str(name))
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
                    value = (
                        _value(row[index], path, pointer) if index < len(row) else None
                    )
                    column.append(None if value in missing else value)
        finally:
            workbook.close()
    return pa.Table.from_arrays(
        [
            _column(values, types.get(name, pa.string()), name, path, pointer)
            for name, values in zip(header, columns, strict=True)
        ],
        names=header,
    )


def _value(cell: Any, path: str, pointer: str) -> Any:
    """An XLSX cell's value. A formula is refused, since its result is not data."""
    if cell.data_type == "f":
        raise FormatError(
            "format_invalid",
            pointer,
            f"{path}: cell {cell.coordinate} holds a formula, not a value",
        )
    return cell.value


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


def _column(
    values: list[Any], kind: pa.DataType, name: str, path: str, pointer: str
) -> pa.Array:
    """XLSX cells as one column of the Arrow type its schema gives.

    Raises:
        FormatError: A cell does not convert to the type exactly, such as
            `2015.9` in an integer column.
    """
    import pyarrow as pa  # noqa: PLC0415 - pyarrow loads on first use

    if pa.types.is_integer(kind):
        for value in values:
            if isinstance(value, float) and not value.is_integer():
                raise FormatError(
                    "format_invalid",
                    pointer,
                    f"{path}: column {name!r} holds {value}, which is not an integer",
                )
    try:
        return pa.array(_cells(values, kind), type=kind)
    except (pa.ArrowException, OverflowError) as error:
        raise FormatError(
            "format_invalid", pointer, f"{path}: column {name!r}: {error}"
        ) from error


def _cells(values: list[Any], kind: pa.DataType) -> list[Any]:
    """XLSX cells as the column's Arrow type takes them."""
    import pyarrow as pa  # noqa: PLC0415 - pyarrow loads on first use

    if pa.types.is_string(kind):
        return [None if value is None else str(value) for value in values]
    if pa.types.is_date32(kind):
        return [value.date() if hasattr(value, "date") else value for value in values]
    return values


def _bundle_spec(package: Mapping[str, Any]) -> tuple[Spec, str] | None:
    """The spec and content version a website bundle's `dfo` member names.

    Raises:
        FormatError: `dfo` is not an object, or its `spec` or `content_version`
            breaks the format.
    """
    if "dfo" not in package:
        return None
    dfo = object_at(package["dfo"], "/dfo")
    if "spec" not in dfo:
        return None
    spec = load_definition(dfo["spec"], "/dfo/spec")
    content_version = dfo.get("content_version")
    if not isinstance(content_version, str) or not matches(
        CONTENT_VERSION, content_version
    ):
        raise FormatError(
            "format_invalid", "/dfo/content_version", "not a content version"
        )
    return spec, content_version


def _bundle_dataset(
    package: Mapping[str, Any],
    data: Mapping[str, Any],
    table: pa.Table,
    *,
    spec: tuple[Spec, str] | None,
    digest: str | None,
) -> Dataset:
    title = str(package.get("title") or data.get("title") or package.get("name"))
    citation = Citation(text=title, sources=_bundle_sources(package))
    members: tuple[Member, ...] = ()
    if digest is not None and spec is not None:
        definition, content_version = spec
        members = (
            Member(
                parts=(),
                spec=definition,
                content_version=content_version,
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
