"""The `Dataset` a fetch returns, and how fetched members become one.

A dataset holds its table and its provenance and carries no client, so its
conversions run offline. Several members stack into one long table with a leading
`part` column labelling each row's member, and the dataset holds each member's row
count, in member order, so a member's rows are known without reading the labels,
which two members may share. Every table a dataset holds presents its
columns and rows in the contract's reading order, `READING_COLUMNS` first and
`stat_var` last, after the member's file was hashed, so the digest and the ref name
the server's file. `save` writes one Parquet file whose
key-value metadata carries the provenance and the ref, which `dfo.load` reads
back. That file is the durable form. A dataset also pickles, for transfer between
processes that run the same client version, as `multiprocessing` does. Another
version may fail to load the pickle or load it wrong.

Both clients call this module. It is sync and works on local data only. It imports
pyarrow inside the functions that read or build a table, so `import dfo` stays light.
"""

from __future__ import annotations

import html
import json
import math
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import asdict, dataclass, field
from datetime import date
from itertools import accumulate
from os import PathLike
from typing import TYPE_CHECKING, Any, Never

from dfo._core.codes import CONTRACT_VIOLATION, UNEXPECTED_RESPONSE
from dfo._core.errors import ContractError, client_error, message_of
from dfo._core.parse import parse_citation, parse_notices, parse_part
from dfo._core.refs import DatasetRef, Member
from dfo._core.text import single_line
from dfo._core.types import (
    Assumption,
    Candidate,
    CandidatesPart,
    Citation,
    CitationSource,
    Departure,
    FormatError,
    Gap,
    Layout,
    Notice,
    Option,
    Part,
    Rendering,
    RequestedOperation,
    Spec,
    check_keys,
    decode,
    is_gap_kind,
    is_integer,
    object_at,
)
from dfo._datasets.build import (
    Cache,
    counted_rows,
    layout_of,
    read_held_until,
    rendering_for,
)
from dfo._generated.reading_order import READING_COLUMNS

if TYPE_CHECKING:
    import pandas
    import polars
    import pyarrow as pa

# The table's type. An alias's value is evaluated only when read, so
# `typing.get_type_hints(Dataset)` resolves `_table` without importing pyarrow.
type _ArrowTable = pa.Table

# What iterating or indexing a dataset raises, which `pd.DataFrame(data)` shows.
_NOT_A_FRAME = (
    "A Dataset is a table with its provenance. Use data.to_pandas(), "
    "data.to_polars(), or pd.DataFrame.from_arrow(data)."
)

# The column that labels each row's member in a dataset of several members.
PART_COLUMN = "part"

# The column the reading order puts after every other.
_LAST_COLUMN = "stat_var"

# The reading columns the rows do not sort by among the slots: a measure, and the
# time period, which sorts after every other key.
_NOT_SLOT_KEYS = ("value", "time_period")

# What a NaN cell or item stands as when cells are compared, so that NaN is the
# same value as NaN whatever its payload.
_NAN = object()

# The columns every artifact a dataset reads holds, in both layouts.
REQUIRED_COLUMNS = ("time_period", "value")

# The version of the provenance a saved file carries under `dfo.*` keys.
SAVED_FORMAT_VERSION = 1

_MONTHS = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)

# Rows the notebook display previews.
_PREVIEW_ROWS = 5


@dataclass(frozen=True, slots=True)
class FetchedMember:
    """One built version, downloaded and ready to become part of a dataset.

    Attributes:
        parts: The variable text of each answer part the member answers, in query
            order; empty for a spec fetched outside an answer.
        spec: The built reading, as the build response named it.
        sentence: Search's sentence for the built reading.
        content_version: The built version's id.
        manifest: The build's manifest, decoded and untouched.
        digest: The digest of the downloaded artifact, `sha256:<hex>`, one of the
            manifest's `artifacts[].artifact_digest`.
        data: The artifact's bytes, a bare Parquet file, already checked against
            `digest`. A download that misses it raises `ServerError`
            (`digest_mismatch`), and a cache entry that misses it is a miss.
            `build_dataset` decodes it.
        answer_parts: The answer parts the member answers, when it came from an
            answer; their departures and requested operations reach the dataset.
        rendering: The rendering the artifact is: the one a `DatasetRef`
            member stores, or the one a fetch built. It names the artifact's
            layout when the manifest does not list `digest`. None reads as the
            bare Parquet rendering of the dataset's layout.
    """

    parts: tuple[str, ...]
    spec: Spec
    sentence: str
    content_version: str
    manifest: Mapping[str, Any] = field(repr=False)
    digest: str
    data: bytes = field(repr=False)
    answer_parts: tuple[Part, ...] = field(default=(), repr=False)
    rendering: Rendering | None = None


@dataclass(frozen=True, slots=True, eq=False, repr=False)
class Dataset:
    """A table of data with its provenance, one exact version per member.

    Attributes:
        sentence: What the data shows, in Search's words, or the members' sentences
            in order when there are several.
        members: One member per built spec, each an exact version; readings
            that narrow to one spec share a member. Empty for a
            website bundle opened from a folder, which names no artifact.
        citation: How to cite the data, every member's sources together.
        warnings: The datasets surface's warnings about the members' data.
        departures: How the readings differ from the question.
        requested_operations: Computations the question asked for, which the
            data leaves to the caller.
        assumptions: What Search assumed to read the question, from the answer
            parts the members answer. Empty for a spec or ref fetched outside an
            answer.
        complete: Whether every part of the question has a member. A fetch of a
            `DatasetRef` is complete for the members it names, since a ref
            carries no gaps, so a dataset saved from a partial fetch loses its
            gaps on the next ref fetch: save from a fetch without `partial`.
        missing: The parts left out of a partial fetch. Their candidates belong
            to no answer; fetch one with `dfo.fetch(candidate.spec)`.
        held_until: The earliest date any member's version can still be fetched
            without being pinned. None when every member is pinned or the server
            does not say.
        pinned: Whether every member's version is kept without a time limit.
        stale: Whether the data came from the cache without asking the server for
            a newer version.
        layout_version: The column set of the table: the long layout's version,
            `frame` for the pipeline frame, or a bundle's rendition.
    """

    sentence: str
    members: tuple[Member, ...]
    citation: Citation
    warnings: tuple[Notice, ...]
    departures: tuple[Departure, ...]
    requested_operations: tuple[RequestedOperation, ...]
    complete: bool
    missing: tuple[Gap, ...]
    held_until: date | None
    pinned: bool
    stale: bool
    layout_version: str
    _table: _ArrowTable = field(repr=False)
    # Each member's row count, in member order, summing to the table's rows; empty
    # for a dataset of no members, whose table is one unit.
    _member_rows: tuple[int, ...] = field(repr=False)
    assumptions: tuple[Assumption, ...] = ()
    # The owner of the call the repr's newest-versions line names: the fetching
    # client's `client` or `dfo`, and `dfo` for a dataset `dfo.load` read.
    _caller: str = field(default="dfo", repr=False)

    def __post_init__(self) -> None:
        rows = self._member_rows
        if len(rows) != len(self.members) or (
            rows and sum(rows) != self._table.num_rows
        ):
            raise ValueError(
                f"{len(self.members)} members cannot hold the row counts {rows} "
                f"of a table of {self._table.num_rows} rows"
            )
        # Every way a dataset is made presents the same reading order.
        object.__setattr__(
            self, "_table", in_reading_order(self._table, member_rows=rows)
        )

    @property
    def ref(self) -> DatasetRef:
        """The exact versions the dataset holds, to fetch them again later.

        Raises:
            ValueError: The dataset is a website bundle opened from a folder,
                which names no version.
        """
        if (ref := self._ref()) is None:
            raise ValueError(
                "A website bundle opened from a folder names no version, so it has "
                "no ref; open the bundle's ZIP, or fetch the dataset with dfo.fetch"
            )
        return ref

    def _ref(self) -> DatasetRef | None:
        return DatasetRef.of(self.members) if self.members else None

    @property
    def sources(self) -> tuple[str, ...]:
        """The names of the sources the data comes from."""
        return tuple(source.label for source in self.citation.sources)

    @property
    def licence(self) -> str:
        """The licences the sources publish under, joined by "; ", or empty when none says."""
        return "; ".join(
            _unique(
                source.licence
                for source in self.citation.sources
                if source.licence is not None
            )
        )

    def __len__(self) -> int:
        """The number of rows in the table."""
        return self._table.num_rows

    def __iter__(self) -> Never:
        """Refuse, naming the conversions: a dataset holds no Python rows."""
        raise TypeError(_NOT_A_FRAME)

    def __getitem__(self, key: object, /) -> Never:
        """Refuse, naming the conversions: a dataset holds no Python columns."""
        raise TypeError(_NOT_A_FRAME)

    def to_arrow(self) -> pa.Table:
        """The table as a `pyarrow.Table`, with the provenance in its schema metadata."""
        return self._table.replace_schema_metadata(self._metadata())

    def __arrow_c_stream__(self, requested_schema: object | None = None) -> object:
        """A fresh Arrow C stream of the table, read by pandas, polars and DuckDB."""
        return self.to_arrow().__arrow_c_stream__(requested_schema)

    def to_pandas(self) -> pandas.DataFrame:
        """The table as a pandas DataFrame, with the provenance in `attrs`.

        `attrs` holds `sentence`, `citation`, `sources`, `licence`, `ref` as
        JSON, `complete`, and `missing`, a list of `{kind, message}` per part a
        partial fetch left out.

        A merge or a concat drops `attrs`. The provenance stays on the dataset.

        Raises:
            ImportError: pandas is not installed.
        """
        try:
            import pandas  # noqa: F401, PLC0415 - an optional extra, imported on use
        except ImportError as error:
            raise ImportError(
                "to_pandas() needs pandas: pip install 'development-finance[pandas]'"
            ) from error
        frame = self._table.to_pandas()
        frame.attrs.update(self._attrs())
        return frame

    def to_polars(self) -> polars.DataFrame:
        """The table as a polars DataFrame.

        Raises:
            ImportError: polars is not installed.
        """
        try:
            import polars  # noqa: PLC0415 - an optional extra, imported on use
        except ImportError as error:
            raise ImportError(
                "to_polars() needs polars: pip install 'development-finance[polars]'"
            ) from error
        frame = polars.from_arrow(self._table)
        assert isinstance(frame, polars.DataFrame)
        return frame

    def save(self, path: str | PathLike[str], /) -> None:
        """Write the table to one Parquet file that carries the provenance and the ref.

        `dfo.load(path)` reads it back into a dataset with the same table,
        provenance and ref.
        """
        import pyarrow.parquet as pq  # noqa: PLC0415 - pyarrow loads on first use

        pq.write_table(self.to_arrow(), path)

    def __repr__(self) -> str:
        lines = [self.sentence, *(f"  {line}" for line in self._summary())]
        return "<Dataset " + "\n".join(single_line(line) for line in lines) + ">"

    def _repr_html_(self) -> str:
        items = "".join(f"<li>{_shown_html(line)}</li>" for line in self._summary())
        return (
            '<div class="dfo-dataset">'
            f"<p><strong>{_shown_html(self.sentence)}</strong></p>"
            f"<ul>{items}</ul>{_preview_html(self._table)}</div>"
        )

    def _summary(self) -> list[str]:
        """The repr's lines after the sentence, ending with the line that keeps
        the data and the one that later fetches its newest versions."""
        lines: list[str] = []
        if self.sources:
            lines.append("Source: " + "; ".join(self.sources))
        versions = [member.content_version for member in self.members]
        retention = self._retention()
        if versions:
            label = "Version" if len(versions) == 1 else "Versions"
            held = f", {retention}" if retention else ""
            lines.append(f"{label}: {', '.join(versions)} (exact){held}")
        elif retention:
            lines.append(retention[0].upper() + retention[1:])
        lines.append(f"Rows: {len(self):,}")
        if not self.complete:
            lines.append(f"Incomplete: {len(self.missing)} part(s) left out")
        if self.stale:
            lines.append(
                "Stale: read from the cache without asking for a newer version"
            )
        keep = "Keep: data.save(path)"
        if versions:
            keep += f" · newest later: {self._caller}.fetch(data.ref, latest=True)"
        lines.append(keep)
        return lines

    def _retention(self) -> str | None:
        if self.pinned:
            return "pinned"
        if self.held_until is None:
            return None
        held = self.held_until
        return (
            f"held until {held.day} {_MONTHS[held.month - 1]} {held.year}, not pinned"
        )

    def _attrs(self) -> dict[str, Any]:
        ref = self._ref()
        return {
            "sentence": self.sentence,
            "citation": self.citation.text,
            "sources": list(self.sources),
            "licence": self.licence,
            "ref": ref.to_json() if ref is not None else None,
            "complete": self.complete,
            "missing": [
                {"kind": gap.kind, "message": gap.message} for gap in self.missing
            ],
        }

    def _metadata(self) -> dict[bytes, bytes]:
        """The provenance as the saved file's key-value metadata, under `dfo.*` keys."""
        ref = self._ref()
        metadata = {
            "dfo.format_version": str(SAVED_FORMAT_VERSION),
            "dfo.sentence": self.sentence,
            "dfo.citation": _dumps(_citation_object(self.citation)),
            "dfo.sources": _dumps(list(self.sources)),
            "dfo.licence": self.licence,
            "dfo.dataset": _dumps(
                {
                    "member_citations": [
                        _citation_object(member.citation) for member in self.members
                    ],
                    "warnings": [asdict(notice) for notice in self.warnings],
                    "departures": [asdict(item) for item in self.departures],
                    "requested_operations": [
                        asdict(item) for item in self.requested_operations
                    ],
                    "assumptions": [asdict(item) for item in self.assumptions],
                    "complete": self.complete,
                    "missing": [_gap_object(gap) for gap in self.missing],
                    "held_until": (
                        self.held_until.isoformat() if self.held_until else None
                    ),
                    "pinned": self.pinned,
                    "stale": self.stale,
                    "layout_version": self.layout_version,
                    "member_rows": list(self._member_rows),
                }
            ),
        }
        if ref is not None:
            metadata["dfo.ref"] = ref.to_json()
        return {key.encode(): value.encode() for key, value in metadata.items()}


def in_reading_order(table: pa.Table, *, member_rows: Sequence[int]) -> pa.Table:
    """`table` with its columns and rows in the reading-order rule's order.

    `member_rows` holds each member's row count, in member order. The table is
    stacked, its first column `part`, when it counts more than one member; in a
    table of one member, or of none, `part` is an ordinary column.

    The columns are `part` first when stacked, then the first name of each
    `READING_COLUMNS` slot the table holds, in slot order, then the other columns
    whose values differ between rows, then those holding one value in every row,
    null included, each group in the table's order, and `stat_var` last. Varying is
    judged over the whole table, so a stacked one's members are judged together.

    Two cells hold the same value when they are equal: a list cell item by item
    in order, a struct cell field by field in any order, 0.0 the same as -0.0,
    and NaN the same as NaN.

    The rows of each member, its `member_rows` count of consecutive rows, sort by
    the filled slots other than `value` and `time_period`, then by the varying
    columns, then by `stat_var` when it varies, then by `time_period`: ascending,
    nulls last, ties in the table's order. A list or struct column is no sort
    key. The members keep their order. Applied to its own result, the order
    changes nothing.

    Raises:
        ContractError: A column holds a type the order cannot compare, such as
            a 16-bit float as a sort key or a map (`contract_violation`).
    """
    import pyarrow as pa  # noqa: PLC0415 - pyarrow loads on first use

    try:
        return _ordered(table, member_rows=member_rows)
    except (
        pa.ArrowNotImplementedError,
        pa.ArrowInvalid,
        pa.ArrowTypeError,
    ) as error:
        raise client_error(
            CONTRACT_VIOLATION, f"The dataset's table cannot be ordered: {error}"
        ) from error


def _ordered(table: pa.Table, *, member_rows: Sequence[int]) -> pa.Table:
    """The body of `in_reading_order`, raising pyarrow's errors."""
    import pyarrow as pa  # noqa: PLC0415 - pyarrow loads on first use

    names = table.column_names
    lead = names[:1] if len(member_rows) > 1 else []
    held = set(names[len(lead) :])
    filled = [
        found
        for slot in READING_COLUMNS
        if (found := next((name for name in slot if name in held), None))
    ]
    placed = {*lead, *filled, _LAST_COLUMN}
    others = [name for name in names if name not in placed]
    varying = [name for name in others if _varies(table[name])]
    last = [_LAST_COLUMN] if _LAST_COLUMN in held else []
    presented = [
        *lead,
        *filled,
        *varying,
        *(name for name in others if name not in varying),
        *last,
    ]
    if presented != names:
        table = table.select(presented)

    keys = [
        name
        for name in [
            *(name for name in filled if name not in _NOT_SLOT_KEYS),
            *varying,
            *(name for name in last if _varies(table[name])),
            *(["time_period"] if "time_period" in held else []),
        ]
        if not _is_list_or_struct(table.schema.field(name).type)
    ]
    if table.num_rows < 2 or not keys:
        return table
    sorting = [(name, "ascending") for name in keys]
    # Arrow's sort is stable and puts nulls last by default.
    runs = [run.sort_by(sorting) for run in _member_runs(table, member_rows)]
    return runs[0] if len(runs) == 1 else pa.concat_tables(runs)


def _is_list_or_struct(data_type: pa.DataType) -> bool:
    """Whether a column of `data_type` holds list or struct cells."""
    import pyarrow as pa  # noqa: PLC0415 - pyarrow loads on first use

    return (
        pa.types.is_list(data_type)
        or pa.types.is_large_list(data_type)
        or pa.types.is_struct(data_type)
    )


def _varies(column: pa.ChunkedArray) -> bool:
    """Whether `column` holds more than one value, null counting as one. List and
    struct cells compare by `_cell_key`; 0.0 is -0.0 and every NaN is every other."""
    import pyarrow as pa  # noqa: PLC0415 - pyarrow loads on first use
    import pyarrow.compute as pc  # noqa: PLC0415 - pyarrow loads on first use

    if _is_list_or_struct(column.type):
        keys = (
            _cell_key(cell) for chunk in column.chunks for cell in chunk.to_pylist()
        )
        first = next(keys, None)
        return any(key != first for key in keys)
    unique = column.unique()
    if len(unique) < 2 or not pa.types.is_floating(unique.type):
        return len(unique) > 1
    # Arrow's unique tells 0.0 from -0.0, and one NaN payload from another. Over
    # the unique values, as doubles, adding 0.0 turns -0.0 into 0.0, and one NaN
    # stands for every NaN. pyarrow generates its compute functions at import, so
    # they are called by name.
    values = unique.cast(pa.float64())
    folded = pc.call_function(
        "if_else",
        [
            pc.call_function("is_nan", [values]),
            pa.scalar(math.nan),
            pc.call_function("add", [values, pa.scalar(0.0)]),
        ],
    )
    return len(folded.unique()) > 1


def _cell_key(cell: object) -> object:
    """A hashable stand-in for a list or struct cell, equal for two cells that hold
    the same value: list items in order, struct fields in any order, 0.0 as -0.0
    and NaN as NaN."""
    if isinstance(cell, float) and math.isnan(cell):
        return _NAN
    if isinstance(cell, list):
        return tuple(_cell_key(item) for item in cell)
    if isinstance(cell, dict):
        return frozenset((name, _cell_key(value)) for name, value in cell.items())
    return cell


def _member_runs(table: pa.Table, member_rows: Sequence[int]) -> list[pa.Table]:
    """`table` split into its members' rows by their counts, or whole for one member
    or none."""
    if len(member_rows) < 2:
        return [table]
    starts = [0, *accumulate(member_rows)]
    return [
        table.slice(start, count)
        for start, count in zip(starts, member_rows, strict=False)
    ]


def build_dataset(
    members: Sequence[FetchedMember],
    *,
    layout: Layout,
    complete: bool,
    missing: Sequence[Gap],
    stale: bool,
    cache: Cache | None = None,
    caller: str = "dfo",
) -> Dataset:
    """Make one dataset from the members a fetch built and downloaded.

    Each member's artifact must decode as Parquet, hold `time_period` and
    `value` columns of distinct names, hold rows when its manifest's coverage
    counts some, and, when it holds rows, a numeric `value`. One that does not
    leaves `cache`, so the next fetch downloads it again. An empty member adds
    no rows to a stacked table.

    Each member's layout comes from the manifest's artifact for its digest, else
    from the member's rendering. Several members stack into one long table in
    member order, each member's rows together, a `part` column first, holding
    each member's parts joined by "; " (its sentence when it answers no part),
    then the members' columns gathered in
    member order, each once. Columns one member lacks are null in its rows, and a
    column whose types differ in width widens, as an int32 with an int64 to int64
    and an integer with a double to double. The dataset presents the columns
    and rows by `in_reading_order`.

    Args:
        members: The members, in query order, each with a distinct spec id.
        layout: The layout the artifacts were rendered in.
        complete: Whether every part of the question has a member.
        missing: The parts a partial fetch left out.
        stale: Whether the members came from the cache without asking the server.
        cache: The cache the members' bytes were read from or stored in, or None.
        caller: The fetching client's hint name, `client` or `dfo`, which the
            repr's newest-versions line names.

    Raises:
        ValueError: No members, or several members in the frame layout.
        ContractError: A member's artifact is not Parquet
            (`unexpected_response`); an artifact breaks the rules above, a
            member's manifest does not list its artifact and the member names
            no rendering, or two members hold a column whose types cannot widen
            to one (`contract_violation`).
    """
    import pyarrow as pa  # noqa: PLC0415 - pyarrow loads on first use

    if not members:
        raise ValueError("a dataset needs at least one member")
    if layout == "frame" and len(members) > 1:
        raise ValueError("the frame layout holds one member")
    # A mint or resumed operation builds the plain rendering.
    plain = rendering_for(layout, party_totals=True)

    tables: list[pa.Table] = []
    built: list[Member] = []
    layouts: list[str] = []
    retentions: list[Mapping[str, Any] | None] = []
    warnings: list[Notice] = []
    for fetched in members:
        layouts.append(_layout_version(fetched, layout))
        built.append(
            Member(
                parts=fetched.parts,
                spec=fetched.spec,
                content_version=fetched.content_version,
                sentence=fetched.sentence,
                citation=parse_citation(fetched.manifest.get("citation")),
                digest=fetched.digest,
                rendering=fetched.rendering or plain,
            )
        )
        retention = fetched.manifest.get("retention")
        retentions.append(retention if isinstance(retention, Mapping) else None)
        warnings.extend(parse_notices(fetched.manifest.get("warnings")))
        tables.append(_read_artifact(fetched, cache))
    member_rows = tuple(table.num_rows for table in tables)

    if len(tables) > 1:
        tables = [
            _with_part(table, "; ".join(member.parts) or member.sentence)
            for table, member in zip(tables, built, strict=True)
        ]
        # An empty member adds no rows, and its all-text columns would not
        # widen to the others' types.
        tables = [table for table in tables if table.num_rows] or tables[:1]
        try:
            table = pa.concat_tables(tables, promote_options="permissive")
        except (pa.ArrowTypeError, pa.ArrowInvalid) as error:
            raise client_error(
                CONTRACT_VIOLATION,
                f"The members' tables cannot stack into one: {error}",
            ) from error
    else:
        table = tables[0]

    answer_parts = [part for fetched in members for part in fetched.answer_parts]
    held_until, pinned = _retention(retentions)
    return Dataset(
        sentence=" ".join(member.sentence for member in built),
        members=tuple(built),
        citation=_merge_citations(member.citation for member in built),
        warnings=tuple(_unique(warnings)),
        departures=tuple(_unique(d for part in answer_parts for d in part.departures)),
        requested_operations=tuple(
            _unique(op for part in answer_parts for op in part.operations)
        ),
        assumptions=tuple(
            _unique(item for part in answer_parts for item in part.assumptions)
        ),
        complete=complete,
        missing=tuple(missing),
        held_until=held_until,
        pinned=pinned,
        stale=stale,
        layout_version="; ".join(_unique(layouts)),
        _table=table.replace_schema_metadata(None),
        _member_rows=member_rows,
        _caller=caller,
    )


def _read_artifact(fetched: FetchedMember, cache: Cache | None) -> pa.Table:
    """A member's artifact as a table, removed from `cache` when it does not read.

    Raises:
        ContractError: The bytes are not Parquet (`unexpected_response`), or
            break a rule `_artifact_fault` checks (`contract_violation`).
    """
    import pyarrow as pa  # noqa: PLC0415 - pyarrow loads on first use
    import pyarrow.parquet as pq  # noqa: PLC0415 - pyarrow loads on first use

    name = f"The artifact {fetched.digest} of {fetched.spec.spec_id}"
    try:
        table = pq.ParquetFile(pa.BufferReader(fetched.data)).read()
    # pyarrow raises OSError, outside ArrowException, for a damaged footer or page
    except (pa.ArrowException, OSError) as error:
        if cache is not None:
            cache.discard(fetched.digest)
        raise client_error(
            UNEXPECTED_RESPONSE, f"{name} is not a Parquet file this client reads"
        ) from error
    if (fault := _artifact_fault(table, fetched.manifest)) is None:
        return table
    if cache is not None:
        cache.discard(fetched.digest)
    raise client_error(CONTRACT_VIOLATION, f"{name} {fault}")


def _artifact_fault(table: pa.Table, manifest: Mapping[str, Any]) -> str | None:
    """What keeps a decoded artifact from being a dataset's table, or None.

    The server writes every column of an empty file as text, so the type of
    `value` is checked only when the file holds rows.
    """
    import pyarrow as pa  # noqa: PLC0415 - pyarrow loads on first use

    names = table.column_names
    if fault := _schema_fault(table.schema):
        return fault
    for column in REQUIRED_COLUMNS:
        if column not in names:
            return f"holds no {column} column"
    if table.num_rows == 0:
        if counted := counted_rows(manifest):
            return f"holds no rows, and its manifest counts {counted}"
        return None
    kind = table.schema.field("value").type
    if not (
        pa.types.is_integer(kind)
        or pa.types.is_floating(kind)
        or pa.types.is_decimal(kind)
        or pa.types.is_null(kind)
    ):
        return f"holds a value column of {kind}, not numbers"
    return None


def _schema_fault(schema: pa.Schema) -> str | None:
    """What keeps an artifact's columns from a dataset's table, or None: two
    columns of one name, or a column `_nesting_fault` refuses."""
    if len(set(schema.names)) != len(schema.names):
        return "holds two columns of one name"
    faults = ((column.name, _nesting_fault(column.type)) for column in schema)
    return next(
        (f"holds a column {name} {fault}" for name, fault in faults if fault), None
    )


def _nesting_fault(data_type: pa.DataType) -> str | None:
    """What keeps a column of `data_type` from a dataset's table, at any depth, or
    None: a nested type other than a list or a struct, such as a map, or a struct
    that names a field twice."""
    import pyarrow as pa  # noqa: PLC0415 - pyarrow loads on first use

    if pa.types.is_list(data_type) or pa.types.is_large_list(data_type):
        return _nesting_fault(data_type.value_type)
    if pa.types.is_struct(data_type):
        fields = data_type.fields
        if len({field.name for field in fields}) != len(fields):
            return "of structs that name a field twice"
        return next(
            filter(None, (_nesting_fault(field.type) for field in fields)), None
        )
    if pa.types.is_nested(data_type):
        return f"of {data_type}, which is no list or struct"
    return None


def saved_dataset(table: pa.Table, metadata: Mapping[bytes, bytes]) -> Dataset:
    """Rebuild a dataset from a file `Dataset.save` wrote.

    Raises:
        ValueError: The metadata is not a saved dataset's, or of a later format.
        FormatError: A `dfo.*` key is missing or breaks the saved format. The
            pointer starts with the key, as in `/dfo.dataset/missing`.
    """
    values = _saved_values(metadata)
    if values.get("dfo.format_version") != str(SAVED_FORMAT_VERSION):
        raise ValueError(
            "the file carries no dataset saved by this client's format version "
            f"{SAVED_FORMAT_VERSION}"
        )
    rest = decode(_saved_value(values, "dfo.dataset"), "/dfo.dataset")
    check_keys(rest, "/dfo.dataset", required=_SAVED_DATASET_KEYS)
    ref = DatasetRef.from_json(values["dfo.ref"]) if "dfo.ref" in values else None
    ref_members = ref.members if ref is not None else ()
    citations = _array(rest["member_citations"], "/dfo.dataset/member_citations")
    if len(citations) != len(ref_members):
        raise FormatError(
            "format_invalid",
            "/dfo.dataset/member_citations",
            f"holds {len(citations)} citations for the {len(ref_members)} members "
            "dfo.ref names",
        )
    members = tuple(
        Member(
            parts=stored.parts,
            spec=stored.spec,
            content_version=stored.content_version,
            sentence=stored.sentence,
            citation=_load_citation(citation, f"/dfo.dataset/member_citations/{index}"),
            digest=stored.digest,
            rendering=stored.rendering,
        )
        for index, (stored, citation) in enumerate(
            zip(ref_members, citations, strict=True)
        )
    )
    member_rows = _load_member_rows(
        rest["member_rows"], members=len(members), rows=table.num_rows
    )
    return Dataset(
        sentence=_saved_value(values, "dfo.sentence"),
        members=members,
        citation=_load_citation(
            decode(_saved_value(values, "dfo.citation"), "/dfo.citation"),
            "/dfo.citation",
        ),
        warnings=tuple(
            Notice(
                **_strings(item, pointer, ("code", "severity", "message"), ("spec_id",))
            )
            for pointer, item in _items(rest, "warnings")
        ),
        departures=tuple(
            Departure(
                **_strings(
                    item, pointer, ("code", "text"), ("asked", "shown", "binding_ref")
                )
            )
            for pointer, item in _items(rest, "departures")
        ),
        requested_operations=tuple(
            _load_operation(item, pointer)
            for pointer, item in _items(rest, "requested_operations")
        ),
        assumptions=tuple(
            _load_assumption(item, pointer)
            for pointer, item in _items(rest, "assumptions")
        ),
        complete=_flag(rest, "complete"),
        missing=tuple(
            _load_gap(item, pointer) for pointer, item in _items(rest, "missing")
        ),
        held_until=_load_held_until(rest["held_until"]),
        pinned=_flag(rest, "pinned"),
        stale=_flag(rest, "stale"),
        layout_version=_string(rest["layout_version"], "/dfo.dataset/layout_version"),
        _table=table.replace_schema_metadata(None),
        _member_rows=member_rows,
    )


# The keys a saved file's `dfo.dataset` object holds.
_SAVED_DATASET_KEYS = (
    "member_citations",
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
    "member_rows",
)


def _saved_values(metadata: Mapping[bytes, bytes]) -> dict[str, str]:
    """A saved file's `dfo.*` metadata, decoded as text."""
    values: dict[str, str] = {}
    for key, value in metadata.items():
        if not key.startswith(b"dfo."):
            continue
        name = key.decode(errors="replace")
        try:
            values[name] = value.decode()
        except UnicodeDecodeError as error:
            raise FormatError("format_invalid", f"/{name}", "not UTF-8") from error
    return values


def _saved_value(values: Mapping[str, str], key: str) -> str:
    if key not in values:
        raise FormatError("format_invalid", f"/{key}", "missing")
    return values[key]


def _items(obj: Mapping[str, Any], key: str) -> Iterator[tuple[str, Any]]:
    """Each item of the saved array `obj[key]`, with its pointer."""
    pointer = f"/dfo.dataset/{key}"
    for index, item in enumerate(_array(obj[key], pointer)):
        yield f"{pointer}/{index}", item


def _array(value: object, pointer: str) -> list[Any]:
    if not isinstance(value, list):
        raise FormatError("format_invalid", pointer, "not an array")
    return value


def _string(value: object, pointer: str) -> str:
    if not isinstance(value, str):
        raise FormatError("format_invalid", pointer, "not a string")
    return value


def _flag(obj: Mapping[str, Any], key: str) -> bool:
    value = obj[key]
    if not isinstance(value, bool):
        raise FormatError("format_invalid", f"/dfo.dataset/{key}", "not a boolean")
    return value


def _strings(
    value: object,
    pointer: str,
    required: Sequence[str],
    optional: Sequence[str] = (),
) -> dict[str, Any]:
    """A saved object of string members, of which the optional ones may be null."""
    obj = object_at(value, pointer)
    check_keys(obj, pointer, required=required, allowed=optional)
    for key, item in obj.items():
        if not (item is None and key in optional):
            _string(item, f"{pointer}/{key}")
    return dict(obj)


def _load_member_rows(value: object, *, members: int, rows: int) -> tuple[int, ...]:
    """A saved file's row count per member: one non-negative integer per member
    of `dfo.ref`, summing to the file's `rows` when there are members."""
    pointer = "/dfo.dataset/member_rows"
    counts = _array(value, pointer)
    if not all(is_integer(count) and count >= 0 for count in counts):
        raise FormatError("format_invalid", pointer, "not non-negative integers")
    member_rows = tuple(int(count) for count in counts)
    if len(member_rows) != members:
        raise FormatError(
            "format_invalid",
            pointer,
            f"holds {len(member_rows)} counts for the {members} members dfo.ref names",
        )
    if member_rows and sum(member_rows) != rows:
        raise FormatError(
            "format_invalid",
            pointer,
            f"counts {sum(member_rows)} rows in a file of {rows}",
        )
    return member_rows


def _load_held_until(value: object) -> date | None:
    pointer = "/dfo.dataset/held_until"
    if value is None:
        return None
    try:
        return date.fromisoformat(_string(value, pointer))
    except ValueError as error:
        raise FormatError("format_invalid", pointer, "not an ISO date") from error


def _load_operation(value: object, pointer: str) -> RequestedOperation:
    obj = dict(object_at(value, pointer))
    target_year = obj.pop("target_year", None)
    if target_year is not None and not is_integer(target_year):
        raise FormatError("format_invalid", f"{pointer}/target_year", "not an integer")
    return RequestedOperation(
        **_strings(obj, pointer, ("verb", "phrase"), ("over",)),
        target_year=None if target_year is None else int(target_year),
    )


def _load_assumption(value: object, pointer: str) -> Assumption:
    obj = dict(object_at(value, pointer))
    refs = _array(obj.pop("refs", None), f"{pointer}/refs")
    return Assumption(
        **_strings(obj, pointer, ("kind", "binding_ref", "text")),
        refs=tuple(
            _string(ref, f"{pointer}/refs/{index}") for index, ref in enumerate(refs)
        ),
    )


def _layout_version(fetched: FetchedMember, layout: Layout) -> str:
    """The layout a member's artifact holds, from its manifest or else its rendering.

    Raises:
        ContractError: The manifest lists no artifact with the member's digest
            and the member names no rendering (`contract_violation`).
    """
    artifacts = fetched.manifest.get("artifacts")
    for artifact in artifacts if isinstance(artifacts, list) else ():
        if (
            isinstance(artifact, Mapping)
            and artifact.get("artifact_digest") == fetched.digest
            and isinstance(rendering := artifact.get("rendering"), Mapping)
        ):
            return str(rendering.get("layout", layout))
    if fetched.rendering is not None:
        return layout_of(fetched.rendering)
    raise client_error(
        CONTRACT_VIOLATION, f"the manifest lists no artifact {fetched.digest}"
    )


def _with_part(table: pa.Table, label: str) -> pa.Table:
    """`table` with the `part` column first, holding `label` on every row.

    Raises:
        ContractError: The member's file already holds a `part` column
            (`contract_violation`), so the stacked table could not tell them apart.
    """
    if PART_COLUMN in table.column_names:
        raise client_error(
            CONTRACT_VIOLATION,
            f"A member's file already holds a {PART_COLUMN!r} column, so the "
            "members cannot stack into one table",
        )
    import pyarrow as pa  # noqa: PLC0415 - pyarrow loads on first use

    column = pa.repeat(pa.scalar(label, pa.string()), table.num_rows)
    return table.add_column(0, PART_COLUMN, column)


def _retention(
    retentions: Sequence[Mapping[str, Any] | None],
) -> tuple[date | None, bool]:
    """The earliest `held_until` across members, and whether every member is pinned."""
    if all(
        retention is not None and retention.get("pinned") is True
        for retention in retentions
    ):
        return None, True
    dates = [
        held
        for retention in retentions
        if retention is not None
        and retention.get("pinned") is not True
        and (held := read_held_until(retention.get("held_until"))) is not None
    ]
    return (min(dates) if dates else None), False


def _merge_citations(citations: Iterable[Citation]) -> Citation:
    texts: list[str] = []
    sources: dict[str, CitationSource] = {}
    for citation in citations:
        texts.append(citation.text)
        for source in citation.sources:
            sources.setdefault(source.ref, source)
    return Citation(
        text="; ".join(_unique(text for text in texts if text)),
        sources=tuple(sources.values()),
    )


def _unique[T](items: Iterable[T]) -> list[T]:
    return list(dict.fromkeys(items))


def _dumps(value: object) -> str:
    return json.dumps(value, ensure_ascii=False)


def _citation_object(citation: Citation) -> dict[str, Any]:
    return {
        "text": citation.text,
        "sources": [asdict(source) for source in citation.sources],
    }


def _load_citation(value: object, pointer: str) -> Citation:
    obj = object_at(value, pointer)
    check_keys(obj, pointer, required=("text", "sources"))
    sources = _array(obj["sources"], f"{pointer}/sources")
    return Citation(
        text=_string(obj["text"], f"{pointer}/text"),
        sources=tuple(
            CitationSource(
                **_strings(
                    source,
                    f"{pointer}/sources/{index}",
                    ("ref", "label"),
                    ("licence", "licence_url", "url"),
                )
            )
            for index, source in enumerate(sources)
        ),
    )


def _gap_object(gap: Gap) -> dict[str, Any]:
    return {
        "part_index": gap.part_index,
        "part": dict(gap.part.raw) or {"status": gap.part.status},
        "kind": gap.kind,
        "message": gap.message,
        "options": [
            {
                "label": option.label,
                "mentions": list(option.mentions),
                "data_query": option.data_query,
            }
            for option in gap.options
            if isinstance(option, Option)
        ],
    }


def _load_gap(value: object, pointer: str) -> Gap:
    """A saved gap. A candidates part's options are its candidates, as in an answer."""
    obj = object_at(value, pointer)
    check_keys(
        obj, pointer, required=("part_index", "part", "kind", "message", "options")
    )
    part_index = obj["part_index"]
    if not is_integer(part_index):
        raise FormatError("format_invalid", f"{pointer}/part_index", "not an integer")
    kind = obj["kind"]
    if not is_gap_kind(kind):
        raise FormatError("format_invalid", f"{pointer}/kind", "not a gap kind")
    try:
        part = parse_part(obj["part"], f"{pointer}/part")
    except ContractError as error:
        raise FormatError(
            "format_invalid", f"{pointer}/part", message_of(error)
        ) from error
    options: tuple[Candidate | Option, ...] = (
        part.candidates
        if isinstance(part, CandidatesPart)
        else tuple(
            _load_option(option, f"{pointer}/options/{index}")
            for index, option in enumerate(_array(obj["options"], f"{pointer}/options"))
        )
    )
    return Gap(
        part_index=int(part_index),
        part=part,
        kind=kind,
        message=_string(obj["message"], f"{pointer}/message"),
        options=options,
    )


def _load_option(value: object, pointer: str) -> Option:
    obj = object_at(value, pointer)
    check_keys(obj, pointer, required=("label", "mentions", "data_query"))
    mentions = _array(obj["mentions"], f"{pointer}/mentions")
    return Option(
        label=_string(obj["label"], f"{pointer}/label"),
        mentions=tuple(
            _string(mention, f"{pointer}/mentions/{index}")
            for index, mention in enumerate(mentions)
        ),
        data_query=object_at(obj["data_query"], f"{pointer}/data_query"),
    )


def _shown_html(text: str) -> str:
    """`text` escaped for HTML, on one line without control characters."""
    return html.escape(single_line(text))


def _preview_html(table: pa.Table) -> str:
    preview = table.slice(0, _PREVIEW_ROWS).to_pylist()
    head = "".join(f"<th>{_shown_html(name)}</th>" for name in table.column_names)
    body = "".join(
        "<tr>"
        + "".join(
            f"<td>{_shown_html('' if value is None else str(value))}</td>"
            for value in row.values()
        )
        + "</tr>"
        for row in preview
    )
    more = (
        f"<p>{table.num_rows - _PREVIEW_ROWS:,} more rows</p>"
        if table.num_rows > _PREVIEW_ROWS
        else ""
    )
    return f"<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>{more}"
