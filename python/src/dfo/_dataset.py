"""The `Dataset` a fetch returns, and how fetched members become one.

A dataset holds its table and its provenance, and no client: its conversions never
touch the network, and it pickles. Several members stack into one long table with
a leading `part` column naming each row's member. `save` writes one Parquet file
whose key-value metadata carries the provenance and the ref, which `open_bundle`
reads back.

Both clients call this module; it is sync and does no network I/O.
"""

import html
import json
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass, field
from datetime import date, datetime
from os import PathLike
from typing import TYPE_CHECKING, Any, Literal

import pyarrow as pa
import pyarrow.parquet as pq

from dfo._error_map import CONTRACT_VIOLATION
from dfo._errors import client_error
from dfo._parse import parse_citation, parse_notices, parse_part
from dfo._types import (
    Citation,
    CitationSource,
    DatasetRef,
    Departure,
    Gap,
    Member,
    Notice,
    Option,
    Part,
    Rendering,
    RequestedOperation,
    Spec,
)

if TYPE_CHECKING:
    import pandas
    import polars

type Layout = Literal["long", "frame"]

# The column that names each row's member in a dataset of several members.
PART_COLUMN = "part"

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
            `digest`: a download that misses it raises `ServerError`
            (`digest_mismatch`), and a cache entry that misses it is a miss.
        answer_parts: The answer parts the member answers, when it came from an
            answer; their departures and requested operations reach the dataset.
    """

    parts: tuple[str, ...]
    spec: Spec
    sentence: str
    content_version: str
    manifest: Mapping[str, Any] = field(repr=False)
    digest: str
    data: bytes = field(repr=False)
    answer_parts: tuple[Part, ...] = field(default=(), repr=False)


@dataclass(frozen=True, slots=True, eq=False, repr=False)
class Dataset:
    """A table of data with its provenance: one exact version per member.

    Attributes:
        sentence: What the data shows, in Search's words; the members' sentences
            in order when there are several.
        members: One member per reading, each an exact version; empty for a
            website bundle opened from a folder, which names no artifact.
        citation: How to cite the data, every member's sources together.
        warnings: The datasets surface's warnings about the members' data.
        departures: How the readings differ from the question.
        requested_operations: Computations the question asked for, which the
            data leaves to the caller.
        assumptions: What the server assumed to read the question; empty until
            the server states assumptions.
        complete: Whether every part of the question has a member.
        missing: The parts left out of a partial fetch.
        held_until: The earliest date any member's version can still be fetched
            without being pinned; None when every member is pinned or the server
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
    _table: pa.Table = field(repr=False)
    assumptions: tuple[str, ...] = ()

    @property
    def ref(self) -> DatasetRef | None:
        """The exact versions the dataset holds, to fetch them again later.

        None for a website bundle opened from a folder, which names no artifact.
        """
        return DatasetRef.of(self.members) if self.members else None

    @property
    def rows(self) -> int:
        """The number of rows in the table."""
        return self._table.num_rows

    @property
    def sources(self) -> tuple[str, ...]:
        """The names of the sources the data comes from."""
        return tuple(source.label for source in self.citation.sources)

    @property
    def licence(self) -> str:
        """The licences the sources publish under, joined by "; "; empty when none says."""
        return "; ".join(
            _unique(
                source.licence
                for source in self.citation.sources
                if source.licence is not None
            )
        )

    def __len__(self) -> int:
        return self.rows

    def to_arrow(self) -> pa.Table:
        """The table as a `pyarrow.Table`, with the provenance in its schema metadata."""
        return self._table.replace_schema_metadata(self._metadata())

    def __arrow_c_stream__(self, requested_schema: object | None = None) -> object:
        """A fresh Arrow C stream of the table, read by pandas, polars and DuckDB."""
        return self.to_arrow().__arrow_c_stream__(requested_schema)

    def to_pandas(self) -> "pandas.DataFrame":
        """The table as a pandas DataFrame, with the provenance in `attrs`.

        A merge or a concat drops `attrs`; the provenance stays on the dataset.

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

    def to_polars(self) -> "polars.DataFrame":
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

        `dfo.open_bundle(path)` reads it back into an equal dataset.
        """
        pq.write_table(self.to_arrow(), path)

    def __repr__(self) -> str:
        lines = [self.sentence, *(f"  {line}" for line in self._summary())]
        return "<Dataset " + "\n".join(lines) + ">"

    def _repr_html_(self) -> str:
        items = "".join(f"<li>{html.escape(line)}</li>" for line in self._summary())
        return (
            '<div class="dfo-dataset">'
            f"<p><strong>{html.escape(self.sentence)}</strong></p>"
            f"<ul>{items}</ul>{_preview_html(self._table)}</div>"
        )

    def _summary(self) -> list[str]:
        lines: list[str] = []
        if self.sources:
            lines.append("Source: " + "; ".join(self.sources))
        versions = [member.content_version for member in self.members]
        if versions:
            label = "Version" if len(versions) == 1 else "Versions"
            lines.append(f"{label}: " + ", ".join(versions))
        lines.append(f"Rows: {self.rows:,}")
        if retention := self._retention():
            lines.append(retention)
        if not self.complete:
            lines.append(f"Incomplete: {len(self.missing)} part(s) left out")
        if self.stale:
            lines.append(
                "Stale: read from the cache without asking for a newer version"
            )
        return lines

    def _retention(self) -> str | None:
        if self.pinned:
            return "Pinned"
        if self.held_until is None:
            return None
        held = self.held_until
        return (
            f"Held until {held.day} {_MONTHS[held.month - 1]} {held.year}, not pinned"
        )

    def _attrs(self) -> dict[str, Any]:
        ref = self.ref
        return {
            "sentence": self.sentence,
            "citation": self.citation.text,
            "sources": list(self.sources),
            "licence": self.licence,
            "ref": ref.to_json() if ref is not None else None,
        }

    def _metadata(self) -> dict[bytes, bytes]:
        """The provenance as the saved file's key-value metadata, under `dfo.*` keys."""
        ref = self.ref
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
                    "assumptions": list(self.assumptions),
                    "complete": self.complete,
                    "missing": [_gap_object(gap) for gap in self.missing],
                    "held_until": (
                        self.held_until.isoformat() if self.held_until else None
                    ),
                    "pinned": self.pinned,
                    "stale": self.stale,
                    "layout_version": self.layout_version,
                }
            ),
        }
        if ref is not None:
            metadata["dfo.ref"] = ref.to_json()
        return {key.encode(): value.encode() for key, value in metadata.items()}


def build_dataset(
    members: Sequence[FetchedMember],
    *,
    layout: Layout,
    complete: bool,
    missing: Sequence[Gap],
    stale: bool,
) -> Dataset:
    """Make one dataset from the members a fetch built and downloaded.

    Each member's manifest must list the artifact its bytes came from. Several members stack into one long table, a `part` column
    first, holding each member's parts joined by "; " (its sentence when it
    answers no part); columns one member lacks are null in its rows.

    Args:
        members: The members, in query order, each with a distinct spec.
        layout: The layout the artifacts were rendered in.
        complete: Whether every part of the question has a member.
        missing: The parts a partial fetch left out.
        stale: Whether the members came from the cache without asking the server.

    Raises:
        ValueError: No members, or several members in the frame layout.
        ContractError: A member's manifest does not list the artifact.
    """
    if not members:
        raise ValueError("a dataset needs at least one member")
    if layout == "frame" and len(members) > 1:
        raise ValueError("the frame layout holds one member")
    rendering = Rendering("parquet", False, "frame" if layout == "frame" else None)

    tables: list[pa.Table] = []
    built: list[Member] = []
    layouts: list[str] = []
    retentions: list[Mapping[str, Any] | None] = []
    warnings: list[Notice] = []
    for fetched in members:
        artifact = _artifact(fetched.manifest, fetched.digest)
        layouts.append(str(artifact["rendering"].get("layout", layout)))
        built.append(
            Member(
                parts=fetched.parts,
                spec=fetched.spec,
                content_version=fetched.content_version,
                sentence=fetched.sentence,
                citation=parse_citation(fetched.manifest.get("citation")),
                digest=fetched.digest,
                rendering=rendering,
            )
        )
        retention = fetched.manifest.get("retention")
        retentions.append(retention if isinstance(retention, Mapping) else None)
        warnings.extend(parse_notices(fetched.manifest.get("warnings")))
        tables.append(pq.read_table(pa.BufferReader(fetched.data)))

    if len(tables) > 1:
        tables = [
            _with_part(table, "; ".join(member.parts) or member.sentence)
            for table, member in zip(tables, built, strict=True)
        ]
        table = pa.concat_tables(tables, promote_options="permissive")
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
        complete=complete,
        missing=tuple(missing),
        held_until=held_until,
        pinned=pinned,
        stale=stale,
        layout_version="; ".join(_unique(layouts)),
        _table=table.replace_schema_metadata(None),
    )


def saved_dataset(table: pa.Table, metadata: Mapping[bytes, bytes]) -> Dataset:
    """Rebuild a dataset from a file `Dataset.save` wrote.

    Raises:
        ValueError: The metadata is not a saved dataset's, or of a later format.
    """
    values = {key.decode(): value.decode() for key, value in metadata.items()}
    if values.get("dfo.format_version") != str(SAVED_FORMAT_VERSION):
        raise ValueError(
            "the file carries no dataset saved by this client's format version "
            f"{SAVED_FORMAT_VERSION}"
        )
    rest = json.loads(values["dfo.dataset"])
    ref = DatasetRef.from_json(values["dfo.ref"]) if "dfo.ref" in values else None
    ref_members = ref.members if ref is not None else ()
    members = tuple(
        Member(
            parts=stored.parts,
            spec=stored.spec,
            content_version=stored.content_version,
            sentence=stored.sentence,
            citation=_load_citation(citation),
            digest=stored.digest,
            rendering=stored.rendering,
        )
        for stored, citation in zip(ref_members, rest["member_citations"], strict=True)
    )
    held_until = rest["held_until"]
    return Dataset(
        sentence=values["dfo.sentence"],
        members=members,
        citation=_load_citation(json.loads(values["dfo.citation"])),
        warnings=tuple(Notice(**notice) for notice in rest["warnings"]),
        departures=tuple(Departure(**item) for item in rest["departures"]),
        requested_operations=tuple(
            RequestedOperation(**item) for item in rest["requested_operations"]
        ),
        assumptions=tuple(rest["assumptions"]),
        complete=rest["complete"],
        missing=tuple(_load_gap(gap) for gap in rest["missing"]),
        held_until=date.fromisoformat(held_until) if held_until else None,
        pinned=rest["pinned"],
        stale=rest["stale"],
        layout_version=rest["layout_version"],
        _table=table.replace_schema_metadata(None),
    )


def _artifact(manifest: Mapping[str, Any], digest: str) -> Mapping[str, Any]:
    artifacts = manifest.get("artifacts")
    for artifact in artifacts if isinstance(artifacts, list) else ():
        if (
            isinstance(artifact, Mapping)
            and artifact.get("artifact_digest") == digest
            and isinstance(artifact.get("rendering"), Mapping)
        ):
            return artifact
    raise client_error(CONTRACT_VIOLATION, f"the manifest lists no artifact {digest}")


def _with_part(table: pa.Table, label: str) -> pa.Table:
    column = pa.array([label] * table.num_rows, type=pa.string())
    return table.add_column(0, PART_COLUMN, column)


def _retention(
    retentions: Sequence[Mapping[str, Any] | None],
) -> tuple[date | None, bool]:
    """The earliest `held_until` across members, and whether every member is pinned."""
    known = [retention for retention in retentions if retention is not None]
    if len(known) == len(retentions) and all(
        retention.get("pinned") is True for retention in known
    ):
        return None, True
    dates = [
        held
        for retention in known
        if retention.get("pinned") is not True
        and (held := _held_until(retention.get("held_until"))) is not None
    ]
    return (min(dates) if dates else None), False


def _held_until(value: object) -> date | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value).date()
    except ValueError:
        return None


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


def _load_citation(obj: Mapping[str, Any]) -> Citation:
    return Citation(
        text=obj["text"],
        sources=tuple(CitationSource(**source) for source in obj["sources"]),
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
        ],
    }


def _load_gap(obj: Mapping[str, Any]) -> Gap:
    return Gap(
        part_index=obj["part_index"],
        part=parse_part(obj["part"]),
        kind=obj["kind"],
        message=obj["message"],
        options=tuple(
            Option(
                label=option["label"],
                mentions=tuple(option["mentions"]),
                data_query=option["data_query"],
            )
            for option in obj["options"]
        ),
    )


def _preview_html(table: pa.Table) -> str:
    preview = table.slice(0, _PREVIEW_ROWS).to_pylist()
    head = "".join(f"<th>{html.escape(name)}</th>" for name in table.column_names)
    body = "".join(
        "<tr>"
        + "".join(
            f"<td>{html.escape('' if value is None else str(value))}</td>"
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
