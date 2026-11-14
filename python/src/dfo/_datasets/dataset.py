"""The `Dataset` a fetch returns, and how fetched members become one.

A dataset holds its table and its provenance and carries no client, so its
conversions run offline. Several members stack into one long table with a leading
`part` column labelling each row's member, and the dataset holds each member's row
count, in member order, so a member's rows are known without reading the labels,
which two members may share. Every table a dataset holds presents its
columns and rows in the contract's reading order, `READING_COLUMNS` first and
`stat_var` last, after the member's file was hashed, so the digest and the ref name
the server's file. `save` writes one Parquet file, the bytes `to_bytes` returns,
whose key-value metadata carries the provenance and the ref, which `dfo.load` reads
back, and, for a dataset DFO computed, the series its recipe left out. That file is
the durable form. A dataset also pickles, for transfer between
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
from contextlib import suppress
from dataclasses import asdict, dataclass, field, replace
from datetime import UTC, date, datetime
from itertools import accumulate
from os import PathLike
from typing import TYPE_CHECKING, Any, Never, override

from dfo._core.codes import (
    CONTRACT_VIOLATION,
    REF_UNAVAILABLE,
    UNEXPECTED_RESPONSE,
)
from dfo._core.errors import ContractError, client_error, message_of
from dfo._core.parse import parse_citation, parse_notices, parse_part
from dfo._core.refs import (
    DatasetRef,
    DerivedMember,
    DerivedRefMember,
    Member,
    RefMember,
    ResolvedPeriod,
    derived_member,
)
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
    decode_value,
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

# The pyarrow major versions from which Arrow itself stacks struct columns whose
# fields differ by name, order or type, and finds the unique 16-bit floats.
# Below them the cells go through Python.
_NATIVE_STRUCT_PROMOTION = 21
_NATIVE_HALF_FLOAT_UNIQUE = 26

# The columns every artifact a dataset reads holds, in both layouts.
REQUIRED_COLUMNS = ("time_period", "value")

# The version of the provenance a saved file carries under `dfo.*` keys. A
# dataset of dataset versions saves format 1. A derived dataset saves format 2,
# whose `dfo.ref` is a format 2 ref and which adds `dfo.left_out` and
# `dfo.steps`, so a client that reads format 1 alone refuses it as a later format.
SAVED_FORMAT_VERSION = 1
SAVED_DERIVED_FORMAT_VERSION = 2

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


def day_text(day: date) -> str:
    """A day as a Dataset's repr prints it, such as `27 November 2026`."""
    return f"{day.day} {_MONTHS[day.month - 1]} {day.year}"


def fetch_time() -> datetime:
    """The current UTC time to the second, as a dataset's `fetched_at` holds it."""
    return datetime.now(UTC).replace(microsecond=0)


def _time_text(moment: datetime) -> str:
    """A UTC time as the repr prints it, such as `27 November 2026 09:14 UTC`."""
    moment = moment.astimezone(UTC)
    return f"{day_text(moment.date())} {moment:%H:%M} UTC"


def _iso_time(moment: datetime) -> str:
    """A UTC time as a saved file's `dfo.fetched_at` holds it, such as
    `2026-11-27T09:14:05Z`."""
    return f"{moment.astimezone(UTC):%Y-%m-%dT%H:%M:%SZ}"


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
        fetched_at: When `data` left the server, in UTC to the second; None
            when the cache recorded no time for it.
        from_cache: Whether `data` was read from the cache.
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
    fetched_at: datetime | None = None
    from_cache: bool = False


@dataclass(frozen=True, slots=True)
class LeftOutStep:
    """The step of a recipe that dropped a series.

    Attributes:
        verb: The step's operation, such as `growth`.
        node: The step's place in the recipe: 0 is the step that made the
            Dataset, and each step comes before the steps it reads from.
    """

    verb: str
    node: int


@dataclass(frozen=True, slots=True)
class LeftOutSeries:
    """A series a step of the recipe behind a Dataset dropped for missing data.

    The repr leads with the entity, as
    `LeftOutSeries(destination=country/NGA: growth dropped 1 row from data,
    endpoint_missing)`. A Dataset a recipe from this client made names each
    column by the role the call used, such as `destination`; one read from a
    ref or a saved file names DFO's column, such as `financingRecipient`. The
    `stat_var` of a frame an earlier step computed, `dcid:ops_…`, is left out
    of the repr.

    `reason` is one of DFO's data-gap codes:

    - `endpoint_missing`: growth found no value in the window's first year or
      its last.
    - `zero_or_sign_crossing_base`: a relative growth's first-year value is
      zero, or the value changes sign, so the fraction has no meaning.
    - `non_finite`: the change worked out to a number too large to hold.
    - `unmatched_key`: the other reading holds no row for this member, as
      when a population reading lacks Ghana; `side` names the reading that
      held the row.
    - `period_unmatched`: the two readings share no year for this member, or
      hold some of its years on one side only.
    - `zero_denominator`: a quotient whose other reading sums to zero.
    - `unit_unbound`: the rows declare no unit, so the step could not check
      that both readings share one.

    A newer DFO can send a code this list lacks.

    Attributes:
        coordinates: The value of each column that names the series, by DFO's
            column names, such as `{"financingRecipient": "country/NGA"}`,
            which match the frame's columns.
        step: The step that dropped the series.
        side: The step input it came from: `data`, or `other` for the second
            reading of a two-reading operation.
        reason: Why the step dropped it, one of the codes above.
        rows: The rows of the series the step left out.
    """

    coordinates: Mapping[str, str]
    step: LeftOutStep
    side: str
    reason: str
    rows: int
    # The role word the call named each column by, for the repr alone.
    _roles: Mapping[str, str] = field(default_factory=dict, repr=False, compare=False)

    @override
    def __hash__(self) -> int:
        return hash(
            (
                frozenset(self.coordinates.items()),
                self.step,
                self.side,
                self.reason,
                self.rows,
            )
        )

    @override
    def __repr__(self) -> str:
        entity = [
            (self._roles.get(key, key), value)
            for key, value in self.coordinates.items()
            if key != "stat_var"
        ]
        variable = self.coordinates.get("stat_var")
        if variable is not None and not variable.startswith("dcid:ops_"):
            entity.append(("stat_var", variable))
        named = ", ".join(f"{key}={value}" for key, value in entity)
        rows = "1 row" if self.rows == 1 else f"{self.rows:,} rows"
        lead = f"{named}: " if named else ""
        return single_line(
            f"LeftOutSeries({lead}{self.step.verb} dropped {rows} "
            f"from {self.side}, {self.reason})"
        )


@dataclass(frozen=True, slots=True)
class PartyTotalsLeftOut:
    """Group totals on one party role that a fetch left out of one member's rows.

    A fetch leaves party totals out by default, so a sum over `value` counts each
    flow once. `party_totals=True` keeps them. DFO names what the cut dropped in
    the version's manifest, one entry per party role and provenance that lost
    rows, and the Dataset gathers those entries in member order.

    Attributes:
        spec_id: The spec of the member whose rows lost the totals.
        role: The party role, by DFO's column name, such as `financingProvider`.
        entities: The dcids of the totals left out, such as `DACCountriesTotal`.
        provenance: The dataset whose rows lost the totals, or None for rows with
            no provenance, or when `every_provenance` is true.
        every_provenance: Whether the totals left the rows of every dataset, as
            on a version DFO recorded before it named the provenance.
    """

    spec_id: str
    role: str
    entities: tuple[str, ...]
    provenance: str | None = None
    every_provenance: bool = False


@dataclass(frozen=True, slots=True)
class DerivedStep:
    """One step of a recipe, as a derived Dataset's repr names it.

    Attributes:
        verb: The operation.
        by: The columns or roles it keeps apart.
        limit: The most members it keeps, for a ranking.
    """

    verb: str
    by: tuple[str, ...] = ()
    limit: int | None = None

    def text(self) -> str:
        """The step as `rank by origin, limit 10`."""
        text = self.verb + (f" by {', '.join(self.by)}" if self.by else "")
        return text + (f", limit {self.limit}" if self.limit is not None else "")


def steps_text(steps: Sequence[DerivedStep], source: str) -> str:
    """Steps in the order they run and what they start from, as
    `growth by origin, then rank by origin, limit 10, from 1 reading`."""
    done = ", then ".join(step.text() for step in steps)
    return f"{done}, from {source}" if done else f"from {source}"


@dataclass(frozen=True, slots=True, eq=False, repr=False)
class Dataset:
    """A table of data with its provenance, one exact version per member.

    The type of `time_period` follows the layout. The long layout holds it as
    an integer calendar year, such as 2022. The frame layout, which a derived
    Dataset and a share fetch hold, writes it as text: a year such as
    `"2022"`, or for a growth an interval of its first and last years, such as
    `"2021/2022"`. So `df[df.time_period == 2022]` finds no rows in a frame,
    and a merge of a frame with a long table must cast one side first. The
    repr's Rows line names the type.

    Attributes:
        sentence: What the data shows, in Search's words, or the members' sentences
            in order when there are several.
        members: One member per built spec, each an exact version; readings
            that narrow to one spec share a member. A dataset DFO computed holds
            derived members instead. Empty for a website bundle opened from a
            folder, which names no artifact.
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
            a newer version, as `DFO_OFFLINE=1` reads it.
        from_cache: Whether this fetch read any member's data from the cache,
            whether or not it asked the server for a newer version. False for a
            dataset `dfo.load` read.
        fetched_at: When the data left the server, in UTC to the second: the
            earliest member's time. A cache hit keeps the time of the download
            that stored it. None when the cache recorded no time for a member,
            for a file saved without one, and for a website bundle.
        question: The question the data answers, when it was fetched from an
            answer to one; None otherwise.
        layout_version: The column set of the table: the long layout's version,
            `frame` for the pipeline frame, or a bundle's rendition.
        left_out: Every series a step of the recipe behind a derived Dataset
            dropped for missing data, at any step, each naming its step. Empty
            for a Dataset of dataset versions. DFO lists at most 2,000; the repr
            says "at least" when it dropped more.
        party_totals_left_out: The group totals a fetch left out of each
            member's rows, one entry per member, party role and provenance that
            lost rows. Empty when nothing was left out, when the fetch passed
            `party_totals=True`, and for a derived Dataset.
    """

    sentence: str
    members: tuple[Member | DerivedMember, ...]
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
    left_out: tuple[LeftOutSeries, ...] = ()
    party_totals_left_out: tuple[PartyTotalsLeftOut, ...] = ()
    # Whether `left_out` lists every series the recipe dropped.
    _left_out_complete: bool = field(default=True, repr=False)
    # The recipe's steps in the order they ran, for the repr's derived line.
    _steps: tuple[DerivedStep, ...] = field(default=(), repr=False)
    # The share slot a share fetch read, as the repr's "Shown by" line names it:
    # `share k3Qx8vTa, slot 2 "Malaria grants", on 3 October 2026`. None otherwise.
    _shown_by: str | None = field(default=None, repr=False)
    from_cache: bool = False
    fetched_at: datetime | None = None
    question: str | None = None

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
            InvalidRequestError: The dataset is a website bundle opened from a
                folder, which names no version (`ref_unavailable`).
        """
        if (ref := self._ref()) is None:
            raise client_error(
                REF_UNAVAILABLE,
                "A website bundle opened from a folder names no version, so it has "
                "no ref; open the bundle's ZIP, or fetch the dataset with dfo.fetch",
                builtin=ValueError,
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

        `path` is a local path, or a URI such as `s3://bucket/data.parquet` that
        pyarrow's filesystems reach. The file holds the bytes `to_bytes` returns.
        `dfo.load(path)` reads a local file back into a dataset with the same
        table, provenance and ref.
        """
        import pyarrow.parquet as pq  # noqa: PLC0415 - pyarrow loads on first use

        pq.write_table(self.to_arrow(), path)

    def to_bytes(self) -> bytes:
        """The Parquet file `save` writes, as bytes, to store where a path cannot
        reach, such as a database column or an HTTP upload.

        `dfo.load(data)` reads the bytes back as it reads the file.
        """
        import pyarrow as pa  # noqa: PLC0415 - pyarrow loads on first use
        import pyarrow.parquet as pq  # noqa: PLC0415 - pyarrow loads on first use

        sink = pa.BufferOutputStream()
        pq.write_table(self.to_arrow(), sink)
        return sink.getvalue().to_pybytes()

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
        lines.extend(self._derived_summary())
        if totals := _party_totals_line(self.party_totals_left_out):
            lines.append(totals)
        if self._shown_by is not None:
            lines.append(f"Shown by: {self._shown_by}")
        versions = [member.content_version for member in self.members]
        retention = self._retention()
        if versions:
            label = "Version" if len(versions) == 1 else "Versions"
            held = f", {retention}" if retention else ""
            lines.append(f"{label}: {', '.join(versions)} (exact){held}")
        elif retention:
            lines.append(retention[0].upper() + retention[1:])
        lines.append(f"Rows: {len(self):,}{self._period_type()}")
        if not self.complete:
            lines.append(f"Incomplete: {len(self.missing)} part(s) left out")
        if self.from_cache or self.stale:
            lines.append(self._cache_line())
        keep = "Keep: data.save(path)"
        if versions:
            keep += f" · newest later: {self._caller}.fetch(data.ref, latest=True)"
        lines.append(keep)
        return lines

    def _cache_line(self) -> str:
        """The repr's line for data read from the cache, with its fetch time."""
        fetched = (
            "fetch time unknown"
            if self.fetched_at is None
            else f"fetched {_time_text(self.fetched_at)}"
        )
        if self.stale:
            return (
                "Stale: read from the cache without asking for a newer version, "
                + fetched
            )
        return f"Cached: read from the cache, {fetched}"

    def _period_type(self) -> str:
        """The type `time_period` holds, as the Rows line names it."""
        import pyarrow as pa  # noqa: PLC0415 - pyarrow loads on first use

        names = self._table.column_names
        if "time_period" not in names:
            return ""
        kind = self._table.schema.field("time_period").type
        if pa.types.is_integer(kind):
            return ", time_period as integer years"
        if pa.types.is_string(kind) or pa.types.is_large_string(kind):
            return ', time_period as text, such as "2022" or "2021/2022"'
        return f", time_period as {kind}"

    def _derived_summary(self) -> list[str]:
        """The lines of a derived dataset: its steps, the period its latest years
        settled on, and the series it left out. Empty for dataset versions."""
        derived = [m for m in self.members if isinstance(m, DerivedMember)]
        if not derived:
            return []
        roots = _unique(root for member in derived for root in member.roots)
        readings = f"{len(roots)} reading" + ("" if len(roots) == 1 else "s")
        lines = [f"Derived: {steps_text(self._steps, readings)}"]
        if period := _period_line(derived[0].resolved_periods):
            lines.append(period)
        if self.left_out:
            count = len(self.left_out)
            least = "" if self._left_out_complete else "at least "
            lines.append(
                f"Missing data: {least}{count:,} series left out · data.left_out"
            )
        return lines

    def _retention(self) -> str | None:
        if self.pinned:
            return "pinned"
        if self.held_until is None:
            return None
        return f"held until {day_text(self.held_until)}, not pinned"

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
        derived = any(isinstance(member, DerivedMember) for member in self.members)
        version = SAVED_DERIVED_FORMAT_VERSION if derived else SAVED_FORMAT_VERSION
        metadata = {
            "dfo.format_version": str(version),
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
        # Keys of their own, as for the party totals below.
        if self.question is not None:
            metadata["dfo.question"] = _dumps(self.question)
        if self.fetched_at is not None:
            metadata["dfo.fetched_at"] = _dumps(_iso_time(self.fetched_at))
        if derived:
            metadata["dfo.left_out"] = _dumps(
                {
                    "series": [_left_out_object(series) for series in self.left_out],
                    "complete": self._left_out_complete,
                }
            )
            metadata["dfo.steps"] = _dumps([asdict(step) for step in self._steps])
        if self.party_totals_left_out:
            # A key of its own, since the 0.1.0 loader refuses any key in
            # `dfo.dataset` it does not know, and reads only the `dfo.*` keys it names.
            metadata["dfo.party_totals_left_out"] = _dumps(
                [_party_totals_object(entry) for entry in self.party_totals_left_out]
            )
        return {key.encode(): value.encode() for key, value in metadata.items()}


def _party_totals_line(entries: Sequence[PartyTotalsLeftOut]) -> str | None:
    """The repr's line counting the totals left out on each role, as
    `Party totals left out: 15 on financingProvider · data.party_totals_left_out`,
    or None when none were."""
    by_role: dict[str, set[str]] = {}
    for entry in entries:
        by_role.setdefault(entry.role, set()).update(entry.entities)
    if not by_role:
        return None
    counts = ", ".join(f"{len(dcids):,} on {role}" for role, dcids in by_role.items())
    return f"Party totals left out: {counts} · data.party_totals_left_out"


def _period_line(periods: Sequence[ResolvedPeriod]) -> str | None:
    """The years a recipe's latest years settled on, and the newest year they
    count back from, as `Period: 2020 to 2024, counted back from 2024, ...`."""
    if not periods:
        return None
    # Each period is a year, and its offset counts years back from the newest.
    newest = int(periods[0].period) - periods[0].offset
    years = sorted({int(period.period) for period in periods})
    span = f"{years[0]}" if len(years) == 1 else f"{years[0]} to {years[-1]}"
    rule = "the newest year at least half the series hold"
    if years == [newest]:
        return f"Period: {newest}, {rule}"
    return f"Period: {span}, counted back from {newest}, {rule}"


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
    if (
        pa.types.is_float16(column.type)
        and _pyarrow_major() < _NATIVE_HALF_FLOAT_UNIQUE
    ):
        # Arrow has no unique kernel for 16-bit floats here, and casts them only
        # from pyarrow 16, so they go through Python floats, which hold them exactly.
        halves = [None if cell is None else float(cell) for cell in column.to_pylist()]
        column = pa.chunked_array([pa.array(halves, pa.float64())])
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
    question: str | None = None,
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
        question: The question of the answer the members answer, or None.

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
    # A member with no rendering of its own reads as the plain rendering. Fetches,
    # mints and resolves always pass one, so only hand-built members reach this.
    plain = rendering_for(layout, party_totals=True)

    tables: list[pa.Table] = []
    built: list[Member] = []
    layouts: list[str] = []
    retentions: list[Mapping[str, Any] | None] = []
    warnings: list[Notice] = []
    party_totals: list[PartyTotalsLeftOut] = []
    for fetched in members:
        layouts.append(_layout_version(fetched, layout))
        party_totals.extend(
            served_party_totals(fetched.manifest, spec_id=fetched.spec.spec_id)
        )
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
        tables.append(
            read_artifact(
                fetched.data,
                digest=fetched.digest,
                spec_id=fetched.spec.spec_id,
                manifest=fetched.manifest,
                cache=cache,
            )
        )
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
            if _pyarrow_major() < _NATIVE_STRUCT_PROMOTION:
                tables = _with_unified_structs(tables)
            table = pa.concat_tables(tables, promote_options="permissive")
        # ValueError covers pyarrow's ArrowInvalid and the refusal of a nanosecond
        # cell as a Python value without pandas. OverflowError covers a cell too
        # large for the unified type.
        except (pa.ArrowTypeError, ValueError, OverflowError) as error:
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
        party_totals_left_out=tuple(party_totals),
        from_cache=any(fetched.from_cache for fetched in members),
        fetched_at=_earliest(fetched.fetched_at for fetched in members),
        question=question,
    )


def _earliest(times: Iterable[datetime | None]) -> datetime | None:
    """The earliest of `times`, or None when any is unknown."""
    known = list(times)
    if any(moment is None for moment in known):
        return None
    return min(moment for moment in known if moment is not None)


def derived_dataset(
    member: DerivedRefMember,
    manifest: Mapping[str, Any],
    data: bytes,
    *,
    cache: Cache | None = None,
    caller: str = "dfo",
    roles: Mapping[str, str] | None = None,
    fetched_at: datetime | None = None,
    from_cache: bool = False,
) -> Dataset:
    """Make a dataset from a derived frame: its ref member, the derived manifest
    DFO serves for it and its stored frame, the bare Parquet file whose digest
    the ref names.

    The member keeps every field of the ref. The manifest gives the citation,
    the retention, the series the recipe left out and the steps the repr names,
    read from the recipe's tree in the order they ran. `roles` maps a column to
    the role word the call named it by, which the repr's steps and left-out
    series print in its place. The file reads through `read_artifact`, as a
    dataset version's does, and leaves `cache` when it does not read.
    `fetched_at` is when the file left the server, None when unknown, and
    `from_cache` whether it was read from the cache.

    Raises:
        ContractError: The manifest names another frame, or its `left_out` or
            `left_out_complete` breaks the served shape (`contract_violation`);
            the file is not Parquet (`unexpected_response`) or holds no
            `time_period` or numeric `value` column (`contract_violation`).
    """
    frame = f"{member.spec.spec_id} at {member.content_version}"
    if (manifest.get("spec_id"), manifest.get("content_version")) != (
        member.spec.spec_id,
        member.content_version,
    ):
        raise client_error(
            CONTRACT_VIOLATION,
            f"The derived manifest names {manifest.get('spec_id')} at "
            f"{manifest.get('content_version')}, not {frame}",
        )
    left_out, complete = _served_left_out(manifest)
    roles = dict(roles or {})
    if roles:
        left_out = tuple(replace(series, _roles=roles) for series in left_out)
    table = read_artifact(
        data,
        digest=member.digest,
        spec_id=member.spec.spec_id,
        manifest=manifest,
        cache=cache,
    )
    retention = manifest.get("retention")
    held_until, pinned = _retention(
        [retention if isinstance(retention, Mapping) else None]
    )
    citation = parse_citation(manifest.get("citation"))
    recipe = manifest.get("recipe")
    tree = recipe.get("tree") if isinstance(recipe, Mapping) else None
    return Dataset(
        sentence=member.sentence,
        members=(derived_member(member, citation),),
        citation=citation,
        warnings=(),
        departures=(),
        requested_operations=(),
        complete=True,
        missing=(),
        held_until=held_until,
        pinned=pinned,
        stale=False,
        layout_version="frame",
        _table=table.replace_schema_metadata(None),
        _member_rows=(table.num_rows,),
        _caller=caller,
        left_out=left_out,
        _left_out_complete=complete,
        _steps=tuple(
            replace(step, by=tuple(roles.get(column, column) for column in step.by))
            for step in (_tree_steps(tree) if isinstance(tree, Mapping) else ())
        ),
        from_cache=from_cache,
        fetched_at=fetched_at,
    )


def _served_left_out(
    manifest: Mapping[str, Any],
) -> tuple[tuple[LeftOutSeries, ...], bool]:
    """A derived manifest's `left_out` and `left_out_complete`. Both are null for
    a recipe stored without them, which reads as none left out.

    Raises:
        ContractError: Either breaks the served shape (`contract_violation`).
    """
    served, complete = manifest.get("left_out"), manifest.get("left_out_complete")
    if served is None:
        return (), True
    try:
        series = tuple(
            read_left_out_series(item, f"/left_out/{index}")
            for index, item in enumerate(_array(served, "/left_out"))
        )
    except FormatError as error:
        raise _manifest_violation(error.pointer) from error
    if not isinstance(complete, bool):
        raise _manifest_violation("/left_out_complete")
    return series, complete


def served_party_totals(
    manifest: Mapping[str, Any], *, spec_id: str
) -> tuple[PartyTotalsLeftOut, ...]:
    """The totals a manifest's `trace.party_totals_left_out` names for the
    member of `spec_id`, or none when the trace names none. A trace that is no
    object or a member that is no list names none, an entry that is malformed
    is dropped while the entries beside it still read, and a key an entry holds
    beyond `role`, `entities` and `provenance` is ignored."""
    trace = manifest.get("trace")
    served = trace.get("party_totals_left_out") if isinstance(trace, Mapping) else None
    if not isinstance(served, list):
        return ()
    pointer = "/trace/party_totals_left_out"
    totals: list[PartyTotalsLeftOut] = []
    for index, item in enumerate(served):
        with suppress(FormatError):
            totals.append(
                read_party_totals(item, f"{pointer}/{index}", spec_id=spec_id)
            )
    return tuple(totals)


def read_party_totals(
    value: object, pointer: str, *, spec_id: str
) -> PartyTotalsLeftOut:
    """One entry of `party_totals_left_out` as the manifest's trace serves it
    and a saved file keeps it: `{role, entities, provenance}`, where an absent
    `provenance` means every dataset's rows.

    Raises:
        FormatError: A key of that shape is missing or of the wrong type.
            `pointer` locates it.
    """
    obj = object_at(value, pointer)
    _require(obj, pointer, ("role", "entities"))
    entities = tuple(
        _string(item, f"{pointer}/entities/{index}")
        for index, item in enumerate(_array(obj["entities"], f"{pointer}/entities"))
    )
    provenance = obj.get("provenance")
    if provenance is not None:
        _string(provenance, f"{pointer}/provenance")
    return PartyTotalsLeftOut(
        spec_id=spec_id,
        role=_string(obj["role"], f"{pointer}/role"),
        entities=entities,
        provenance=provenance,
        every_provenance="provenance" not in obj,
    )


def _party_totals_object(entry: PartyTotalsLeftOut) -> dict[str, Any]:
    """An entry as a saved file keeps it: the served shape with its spec id."""
    obj: dict[str, Any] = {
        "spec_id": entry.spec_id,
        "role": entry.role,
        "entities": list(entry.entities),
    }
    if not entry.every_provenance:
        obj["provenance"] = entry.provenance
    return obj


def _load_party_totals(
    text: str, spec_ids: Sequence[str]
) -> tuple[PartyTotalsLeftOut, ...]:
    """A saved file's `dfo.party_totals_left_out`, whose entries name a member of
    the ref (`spec_ids`, in member order) and follow member order."""
    pointer = "/dfo.party_totals_left_out"
    loaded: list[PartyTotalsLeftOut] = []
    for index, item in enumerate(_array(decode_value(text, pointer), pointer)):
        at = f"{pointer}/{index}"
        obj = object_at(item, at)
        check_keys(
            obj, at, required=("spec_id", "role", "entities"), allowed=("provenance",)
        )
        spec_id = _string(obj["spec_id"], f"{at}/spec_id")
        loaded.append(read_party_totals(obj, at, spec_id=spec_id))
    positions = [
        spec_ids.index(entry.spec_id) if entry.spec_id in spec_ids else -1
        for entry in loaded
    ]
    if -1 in positions or positions != sorted(positions):
        raise FormatError(
            "format_invalid",
            pointer,
            "names a spec that is no member of dfo.ref, or lists members out of order",
        )
    return tuple(loaded)


def _manifest_violation(pointer: str) -> ContractError:
    error = client_error(
        CONTRACT_VIOLATION,
        f"The derived manifest's {pointer} breaks the shape this client reads",
    )
    error.pointer = pointer
    return error


# The parameter each operation names the columns it keeps apart in.
_BY_PARAMETERS = ("group_by", "entity_by", "rank_by", "numerator_by", "join_keys")


def _tree_steps(node: Mapping[str, Any]) -> Iterator[DerivedStep]:
    """The steps of a stored recipe's tree in the order they ran: each step
    after its inputs, the primary input first. A part of the tree this client
    cannot read names no step, since only the repr reads them."""
    op_spec = node.get("op_spec")
    verb = op_spec.get("verb") if isinstance(op_spec, Mapping) else None
    inputs = node.get("inputs")
    if isinstance(inputs, Mapping):
        # Compare reads its primary input as the right frame, as DFO's runner
        # places it.
        primary = "right_frame_ref" if verb == "compare" else "frame_ref"
        for slot in sorted(inputs, key=lambda slot: (slot != primary, slot)):
            if isinstance(child := inputs[slot], Mapping):
                yield from _tree_steps(child)
    if not isinstance(op_spec, Mapping) or not isinstance(verb, str):
        return
    parameters = op_spec.get("parameters")
    parameters = parameters if isinstance(parameters, Mapping) else {}
    by = next(
        (
            parameters[name]
            for name in _BY_PARAMETERS
            if isinstance(parameters.get(name), list)
        ),
        [],
    )
    limit = parameters.get("limit")
    yield DerivedStep(
        verb=verb,
        by=tuple(column for column in by if isinstance(column, str)),
        limit=limit if type(limit) is int else None,
    )


def read_artifact(
    data: bytes,
    *,
    digest: str,
    spec_id: str,
    manifest: Mapping[str, Any],
    cache: Cache | None,
) -> pa.Table:
    """An artifact's bytes as a table, removed from `cache` when they do not read.

    A dataset version's file and a derived frame's file both read through it;
    `manifest` is the one that lists the artifact, whose coverage counts its rows.

    Raises:
        ContractError: The bytes are not Parquet (`unexpected_response`), or
            break a rule `_artifact_fault` checks (`contract_violation`).
    """
    import pyarrow as pa  # noqa: PLC0415 - pyarrow loads on first use
    import pyarrow.parquet as pq  # noqa: PLC0415 - pyarrow loads on first use

    name = f"The artifact {digest} of {spec_id}"
    try:
        table = pq.ParquetFile(pa.BufferReader(data)).read()
    # pyarrow raises OSError, outside ArrowException, for a damaged footer or page
    except (pa.ArrowException, OSError) as error:
        if cache is not None:
            cache.discard(digest)
        raise client_error(
            UNEXPECTED_RESPONSE, f"{name} is not a Parquet file this client reads"
        ) from error
    if (fault := _artifact_fault(table, manifest)) is None:
        return table
    if cache is not None:
        cache.discard(digest)
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
        fields = [data_type.field(index) for index in range(data_type.num_fields)]
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
        FormatError: The metadata is not a saved dataset's or is of a later
            format, at `/dfo.format_version`, or a `dfo.*` key is missing or
            breaks the saved format. The pointer starts with the key, as in
            `/dfo.dataset/missing`.
    """
    values = _saved_values(metadata)
    versions = (str(SAVED_FORMAT_VERSION), str(SAVED_DERIVED_FORMAT_VERSION))
    if values.get("dfo.format_version") not in versions:
        raise FormatError(
            "format_invalid",
            "/dfo.format_version",
            "the file carries no dataset saved by this client's format versions "
            f"{SAVED_FORMAT_VERSION} and {SAVED_DERIVED_FORMAT_VERSION}; a later "
            "client reads it",
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
        _saved_member(
            stored,
            _load_citation(citation, f"/dfo.dataset/member_citations/{index}"),
        )
        for index, (stored, citation) in enumerate(
            zip(ref_members, citations, strict=True)
        )
    )
    member_rows = _load_member_rows(
        rest["member_rows"], members=len(members), rows=table.num_rows
    )
    # Only a derived dataset carries left-out series and steps.
    derived = any(isinstance(member, DerivedMember) for member in members)
    expected = SAVED_DERIVED_FORMAT_VERSION if derived else SAVED_FORMAT_VERSION
    if values["dfo.format_version"] != str(expected):
        raise FormatError(
            "format_invalid",
            "/dfo.format_version",
            f"is {values['dfo.format_version']} for a file whose dfo.ref "
            f"{'holds' if derived else 'holds no'} derived member; it is {expected}",
        )
    party_totals = (
        _load_party_totals(text, [member.spec.spec_id for member in ref_members])
        if (text := values.get("dfo.party_totals_left_out")) is not None
        else ()
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
        party_totals_left_out=party_totals,
        fetched_at=(
            _load_fetched_at(text)
            if (text := values.get("dfo.fetched_at")) is not None
            else None
        ),
        question=(
            _string(decode_value(text, "/dfo.question"), "/dfo.question")
            if (text := values.get("dfo.question")) is not None
            else None
        ),
        **(_load_derived(values) if derived else {}),
    )


def _load_fetched_at(text: str) -> datetime:
    """A saved `dfo.fetched_at`, a JSON string holding an ISO 8601 time with a
    zone, in UTC."""
    pointer = "/dfo.fetched_at"
    value = _string(decode_value(text, pointer), pointer)
    try:
        moment = datetime.fromisoformat(value)
    except ValueError as error:
        raise FormatError("format_invalid", pointer, "not an ISO 8601 time") from error
    if moment.tzinfo is None:
        raise FormatError("format_invalid", pointer, "a time without a zone")
    return moment.astimezone(UTC)


def _saved_member(
    stored: RefMember | DerivedRefMember, citation: Citation
) -> Member | DerivedMember:
    """A saved ref's member as the dataset holds it, with its citation."""
    if isinstance(stored, RefMember):
        return Member(
            parts=stored.parts,
            spec=stored.spec,
            content_version=stored.content_version,
            sentence=stored.sentence,
            citation=citation,
            digest=stored.digest,
            rendering=stored.rendering,
        )
    return derived_member(stored, citation)


def _left_out_object(series: LeftOutSeries) -> dict[str, Any]:
    return {
        "coordinates": dict(series.coordinates),
        "step": {"verb": series.step.verb, "node": series.step.node},
        "side": series.side,
        "reason": series.reason,
        "rows": series.rows,
    }


def _load_derived(values: Mapping[str, str]) -> dict[str, Any]:
    """A saved file's `dfo.left_out` and `dfo.steps`, as the `Dataset` fields
    they fill; none when the file holds dataset versions."""
    loaded: dict[str, Any] = {}
    if (text := values.get("dfo.left_out")) is not None:
        series, complete = _load_left_out(decode(text, "/dfo.left_out"))
        loaded["left_out"] = series
        loaded["_left_out_complete"] = complete
    if (text := values.get("dfo.steps")) is not None:
        pointer = "/dfo.steps"
        loaded["_steps"] = tuple(
            _load_step(item, f"{pointer}/{index}")
            for index, item in enumerate(_array(decode_value(text, pointer), pointer))
        )
    return loaded


def _load_left_out(obj: Mapping[str, Any]) -> tuple[tuple[LeftOutSeries, ...], bool]:
    """A saved `dfo.left_out`: the dropped series and whether they are all."""
    pointer = "/dfo.left_out"
    check_keys(obj, pointer, required=("series", "complete"))
    complete = obj["complete"]
    if not isinstance(complete, bool):
        raise FormatError("format_invalid", f"{pointer}/complete", "not a boolean")
    items = _array(obj["series"], f"{pointer}/series")
    return (
        tuple(
            read_left_out_series(item, f"{pointer}/series/{index}")
            for index, item in enumerate(items)
        ),
        complete,
    )


def read_left_out_series(value: object, pointer: str) -> LeftOutSeries:
    """One dropped series as the derived manifest serves it and a saved file
    keeps it: `{coordinates, step: {verb, node}, side, reason, rows}`. A key
    outside that shape is ignored, so a member DFO adds reads as before.

    Raises:
        FormatError: A key of that shape is missing or of the wrong type;
            `pointer` locates it.
    """
    obj = object_at(value, pointer)
    _require(obj, pointer, ("coordinates", "step", "side", "reason", "rows"))
    coordinates = object_at(obj["coordinates"], f"{pointer}/coordinates")
    for key, item in coordinates.items():
        _string(item, f"{pointer}/coordinates/{key}")
    step = object_at(obj["step"], f"{pointer}/step")
    _require(step, f"{pointer}/step", ("verb", "node"))
    node = step["node"]
    if not is_integer(node) or node < 0:
        raise FormatError("format_invalid", f"{pointer}/step/node", "not a node index")
    rows = obj["rows"]
    if not is_integer(rows) or rows < 0:
        raise FormatError("format_invalid", f"{pointer}/rows", "not a row count")
    return LeftOutSeries(
        coordinates=dict(coordinates),
        step=LeftOutStep(
            verb=_string(step["verb"], f"{pointer}/step/verb"), node=int(node)
        ),
        side=_string(obj["side"], f"{pointer}/side"),
        reason=_string(obj["reason"], f"{pointer}/reason"),
        rows=int(rows),
    )


def _require(obj: Mapping[str, Any], pointer: str, keys: Sequence[str]) -> None:
    """Refuse a missing key of `keys`; any other key passes."""
    for key in keys:
        if key not in obj:
            raise FormatError("format_invalid", f"{pointer}/{key}", "missing")


def _load_step(value: object, pointer: str) -> DerivedStep:
    obj = object_at(value, pointer)
    check_keys(obj, pointer, required=("verb", "by", "limit"))
    by = _array(obj["by"], f"{pointer}/by")
    limit = obj["limit"]
    if limit is not None and not is_integer(limit):
        raise FormatError("format_invalid", f"{pointer}/limit", "not an integer")
    return DerivedStep(
        verb=_string(obj["verb"], f"{pointer}/verb"),
        by=tuple(
            _string(item, f"{pointer}/by/{index}") for index, item in enumerate(by)
        ),
        limit=None if limit is None else int(limit),
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


def _pyarrow_major() -> int:
    """The major version of the Arrow C++ library pyarrow runs on, which is
    pyarrow's own."""
    import pyarrow as pa  # noqa: PLC0415 - pyarrow loads on first use

    return pa.cpp_version_info.major


def _with_unified_structs(tables: list[pa.Table]) -> list[pa.Table]:
    """`tables` with each column that holds structs and differs from the unified
    type rebuilt as that type, structs unifying by field name in the order they are
    first named. Before pyarrow `_NATIVE_STRUCT_PROMOTION` Arrow casts no struct to
    one with more or reordered fields, so the cells go through Python, and the
    rebuilt column drops field nullability and metadata."""
    import pyarrow as pa  # noqa: PLC0415 - pyarrow loads on first use

    schema = pa.unify_schemas(
        [table.schema for table in tables], promote_options="permissive"
    )
    result = []
    for table in tables:
        unified = table
        for index, column_field in enumerate(table.schema):
            target = schema.field(column_field.name).type
            if _holds_struct(target) and not column_field.type.equals(target):
                cells = unified.column(index).to_pylist()
                column = pa.array(cells, type=target)
                unified = unified.set_column(index, column_field.name, column)
        result.append(unified)
    return result


def _holds_struct(data_type: pa.DataType) -> bool:
    """Whether `data_type` is a struct, or a list of them at any depth."""
    import pyarrow as pa  # noqa: PLC0415 - pyarrow loads on first use

    if pa.types.is_list(data_type) or pa.types.is_large_list(data_type):
        return _holds_struct(data_type.value_type)
    return pa.types.is_struct(data_type)


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
