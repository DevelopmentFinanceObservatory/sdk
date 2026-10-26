"""The pieces of a dataset build that do no I/O, shared by both clients.

A build posts a spec to the datasets surface with a scope and a rendering, and
reads back a manifest or a long-build operation. This module writes those request
bodies, reads the operation resource, picks the artifact a manifest lists for the
client's rendering, and paces polls.
`dfo._datasets.fetch`, `dfo._datasets.resolve` and `dfo._datasets.operation` hold the
requests themselves.
"""

from collections.abc import Iterable, Mapping, Sequence
from contextlib import nullcontext
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Protocol

import httpx2

from dfo._core.codes import CONTRACT_VIOLATION, INVALID_ARGUMENT, UNEXPECTED_RESPONSE
from dfo._core.errors import client_error
from dfo._core.json_text import loads
from dfo._core.parse import check_manifest, check_operation, violation
from dfo._core.refusals import sent_key, trace_id_of
from dfo._core.text import quoted, redacted_json
from dfo._core.types import (
    CONTENT_VERSION,
    OPERATION_ID,
    Layout,
    Part,
    Rendering,
    Spec,
    Window,
    Wire,
    matches,
)
from dfo._http.hooks import Hold

# The longest the client reads a synchronous build. The server cuts off at 120 s.
BUILD_READ_TIMEOUT = 150.0

# Poll backoff when the server sends no pacing, doubling from the first to the cap.
POLL_BACKOFF_FIRST = 1.0
POLL_BACKOFF_CAP = 8.0

_LAYOUTS = ("long", "frame")

# The years a window range may name: the integers JSON carries exactly, as the
# build request's schema bounds them.
WINDOW_FIRST_YEAR = -(2**53 - 1)
WINDOW_LAST_YEAR = 2**53 - 1


@dataclass(frozen=True, slots=True)
class Progress:
    """How far a long build has got, as the server last reported it.

    Attributes:
        rows_written: Rows the build has written so far.
        estimate_rows: The rows the server expects the build to write.
    """

    rows_written: int | None = None
    estimate_rows: int | None = None


@dataclass(frozen=True, slots=True)
class Reading:
    """One reading a fetch builds, with what it answers.

    Attributes:
        parts: The variable text of each answer part the reading answers, in
            query order; empty for a spec fetched outside an answer.
        spec: The reading to build.
        sentence: Search's sentence for the reading, when known.
        answer_parts: The answer parts the reading answers, whose departures and
            requested operations reach the dataset.
    """

    parts: tuple[str, ...]
    spec: Spec
    sentence: str | None = None
    answer_parts: tuple[Part[object], ...] = ()


class Cache(Protocol):
    """The local store a fetch reads before the network and writes after it."""

    def get_bytes(self, digest: str, /) -> bytes | None:
        """The bytes stored under `digest`, or None when absent or not hashing to it.

        A damaged entry reads as a miss, so the fetch downloads it again.
        """
        ...

    def put_bytes(self, digest: str, data: bytes, /) -> None:
        """Store bytes already checked against `digest`."""
        ...

    def discard(self, digest: str, /) -> None:
        """Remove the bytes stored under `digest`, which do not read as an artifact."""
        ...

    def downloading(
        self, digest: str, /, *, timeout: float | None = None
    ) -> Hold | nullcontext[None]:
        """Hold `digest`, sync or async, while one fetch reads, downloads and
        stores it, waiting up to `timeout` seconds."""
        ...

    def merging(
        self, spec_id: str, content_version: str, rendering: Rendering, /
    ) -> Hold | nullcontext[None]:
        """Hold one rendering of one version's manifest, among threads, while
        one fetch reads, merges and writes it."""
        ...

    def get_manifest(
        self, spec_id: str, content_version: str, rendering: Rendering, /
    ) -> dict[str, Any] | None:
        """The manifest stored for one rendering of one version, or None."""
        ...

    def put_manifest(
        self,
        spec_id: str,
        content_version: str,
        rendering: Rendering,
        manifest: Mapping[str, Any],
        /,
    ) -> None:
        """Store the manifest for one rendering of one version."""
        ...

    def manifest_candidates(
        self, spec_id: str, rendering: Rendering, /
    ) -> list[dict[str, Any]]:
        """Stored manifests for a spec and rendering, newest first."""
        ...


def rendering_for(layout: str, *, without_party_totals: bool = False) -> Rendering:
    """The bare Parquet rendering both clients build for `layout`.

    Raises:
        InvalidRequestError: `layout` is neither `long` nor `frame`, or
            `without_party_totals` is not a bool.
    """
    if layout not in _LAYOUTS:
        raise client_error(
            INVALID_ARGUMENT, f'layout is "long" or "frame", not {layout!r}'
        )
    if not isinstance(without_party_totals, bool):
        raise client_error(
            INVALID_ARGUMENT,
            f"without_party_totals is True or False, not {without_party_totals!r}",
        )
    return Rendering(
        "parquet",
        False,
        "frame" if layout == "frame" else None,
        without_party_totals=without_party_totals,
    )


def check_strict(strict: object) -> None:
    """Refuse a `strict` that is not a bool.

    Raises:
        InvalidRequestError: It is not (`invalid_argument`).
    """
    if not isinstance(strict, bool):
        raise client_error(INVALID_ARGUMENT, f"strict is True or False, not {strict!r}")


def layout_of(rendering: Rendering) -> Layout:
    """The layout a bare Parquet rendering holds."""
    return "frame" if rendering.layout == "frame" else "long"


def file_params(rendering: Rendering) -> dict[str, Any]:
    """The file selector's query for `rendering`: format, bundle and layout.

    The selector takes no other option. It renders a version with the options
    the version was minted with, so a party-totals cut renders as itself.
    """
    params: dict[str, Any] = {"format": rendering.format, "bundle": rendering.bundle}
    if rendering.layout is not None:
        params["layout"] = rendering.layout
    return params


def scope(
    *,
    window: Window | None = None,
    entities: Mapping[str, Sequence[str]] | None = None,
    facets: Mapping[str, str | None] | None = None,
) -> dict[str, Any] | None:
    """The build request's `scope` for the narrowing a fetch asks for.

    Args:
        window: `"all"`, `"latest"` or `(start_year, end_year)`.
        entities: Role names bound to dcids, such as `{"recipient": ["country/NGA"]}`.
        facets: Facet axes (`provenance`, `measurementMethod`, `unit`) bound to a
            ref; None binds the facets that declare no value on the axis. An
            empty map names no axis.

    Returns:
        The scope object, or None when the fetch narrows nothing.

    Raises:
        InvalidRequestError: The window is neither a known kind nor a pair of
            years from `WINDOW_FIRST_YEAR` to `WINDOW_LAST_YEAR`, start first;
            `entities` is not a map of role names to non-empty sequences of
            dcids; or `facets` is not a map of axis names to refs or None
            (`invalid_argument`).
    """
    result: dict[str, Any] = {}
    if window is not None:
        result["window"] = _window(window)
    if entities is not None:
        result["entities"] = _entities(entities)
    if facets is not None and _names("facets", facets):
        result["facets"] = {
            axis: {"ref": _ref(axis, ref)} for axis, ref in facets.items()
        }
    return result or None


def rebind(
    spec: Spec, entities: Mapping[str, Sequence[str] | None]
) -> dict[str, Sequence[str]]:
    """The whole entity binding a fetch posts, the spec's own with `entities` applied.

    The server replaces a spec's entire binding with the posted one, so the
    client starts from the roles the spec's definition binds and changes only
    the roles `entities` names. A role bound to None is dropped.

    Raises:
        InvalidRequestError: `entities` is not a map of role names, or the
            spec's definition holds no `identity` object (`invalid_argument`).
    """
    _names("entities", entities)
    identity = spec.definition.get("identity")
    if not isinstance(identity, Mapping):
        raise client_error(
            INVALID_ARGUMENT,
            f"The definition of {spec.spec_id} holds no identity to rebind; use a "
            "spec from a search, or one Spec.from_json loaded from Spec.to_json",
        )
    bound: dict[str, Sequence[str]] = dict(identity.get("entities", {}))
    for role, dcids in entities.items():
        if dcids is None:
            bound.pop(role, None)
        else:
            bound[role] = dcids
    return bound


def _window(window: Window) -> dict[str, Any]:
    if window in ("all", "latest"):
        return {"kind": window}
    match window:
        case (int() as start, int() as end) if not isinstance(
            start, bool
        ) and not isinstance(end, bool):
            if not WINDOW_FIRST_YEAR <= start <= end <= WINDOW_LAST_YEAR:
                raise client_error(
                    INVALID_ARGUMENT,
                    "window is (start_year, end_year), start_year first, each "
                    f"within ±{WINDOW_LAST_YEAR}, not {window!r}",
                )
            return {"kind": "range", "start_year": start, "end_year": end}
        case _:
            raise client_error(
                INVALID_ARGUMENT,
                f'window is "all", "latest" or (start_year, end_year), not {window!r}',
            )


def _names(argument: str, value: object) -> Mapping[str, object]:
    """`value` when it is a map keyed by non-empty names, such as role names.

    Raises:
        InvalidRequestError: It is not (`invalid_argument`).
    """
    if not isinstance(value, Mapping):
        raise client_error(
            INVALID_ARGUMENT,
            f"{argument} is a map of names, such as {{'recipient': ...}}, not "
            f"{value!r}",
        )
    for name in value:
        if not isinstance(name, str) or not name:
            raise client_error(
                INVALID_ARGUMENT, f"{argument} names a key {name!r}; a key is a name"
            )
    return value


def _entities(entities: Mapping[str, Sequence[str]]) -> dict[str, list[str]]:
    bound = {}
    for role, dcids in _names("entities", entities).items():
        if isinstance(dcids, str):
            raise client_error(
                INVALID_ARGUMENT,
                f"entities[{role!r}] is a string; bind the role to a list of dcids, "
                f"such as [{dcids!r}]",
            )
        listed = list(dcids) if isinstance(dcids, Iterable) else None
        if not listed or not all(isinstance(dcid, str) and dcid for dcid in listed):
            raise client_error(
                INVALID_ARGUMENT,
                f"entities[{role!r}] is a list of dcids, such as ['country/NGA'], "
                f"not {dcids!r}; bind the role to None to drop it",
            )
        bound[role] = listed
    return bound


def _ref(axis: str, ref: object) -> str | None:
    if ref is None or (isinstance(ref, str) and ref):
        return ref
    raise client_error(
        INVALID_ARGUMENT,
        f"facets[{axis!r}] is a ref or None, not {ref!r}",
    )


def build_body(
    spec: Spec, rendering: Rendering, narrowing: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    """The `POST /datasets` body that builds `spec`'s latest version.

    The body always carries the spec's unmodified definition, so a spec the
    server has not registered still builds.
    """
    built: dict[str, Any] = {
        "kind": "spec_id",
        "spec_id": spec.spec_id,
        "definition": spec.definition,
    }
    if narrowing is not None:
        built["scope"] = narrowing
    return {
        "schema_version": 1,
        "input": built,
        "options": rendering.to_object(),
    }


def _kept_entity_groups(held: Spec | None, built: Wire) -> dict[str, Any]:
    """The held spec's entity groups that hold for a built definition.

    A role keeps its group when the built identity binds it to the same entities
    as `held`'s definition, so a window or facets narrowing keeps every group and
    a role that `entities` rebound or dropped loses its group. The server drops a
    posted group whose members differ from the role's entities.
    """
    if held is None or not held.entity_groups:
        return {}
    before = held.definition["identity"].get("entities", {})
    after = built["identity"].get("entities", {})
    return {
        role: group
        for role, group in held.entity_groups.items()
        if role in after and set(after[role]) == set(before.get(role, ()))
    }


def resubmit_body(
    built: Wire, variable_text: str, held: Spec | None = None
) -> dict[str, Any]:
    """The Search request that re-resolves one built definition for its sentence.

    `held` is the spec the client built from, None for a resumed build. Its
    groups that `_kept_entity_groups` keeps go with the identity, so a group of
    places reads the same way again.
    """
    entry: dict[str, Any] = {
        "entry_kind": "identity",
        "variable_text": variable_text,
        "identity": built["identity"],
    }
    if groups := _kept_entity_groups(held, built):
        entry["entity_groups"] = groups
    return {
        "schema_version": 1,
        "input": {"kind": "dataset_resubmit", "entries": [entry]},
    }


def pick_artifact(
    manifest: Wire, rendering: Rendering, *, digest: str | None = None
) -> Wire | None:
    """The artifact a manifest lists for `rendering`, with `digest` when given.

    Artifacts match on `Rendering.matches`. A party-totals cut that leaves
    nothing out lists its file under the plain version, beside the plain file,
    so the flag tells the two apart.
    """
    for artifact in manifest["artifacts"]:
        if digest is not None and artifact["artifact_digest"] != digest:
            continue
        if isinstance(artifact["rendering"], Mapping) and rendering.matches(
            artifact["rendering"]
        ):
            return artifact
    return None


def lists_digest(manifest: Wire, digest: str) -> bool:
    """Whether a manifest lists an artifact with `digest`, in any rendering."""
    return any(
        artifact["artifact_digest"] == digest for artifact in manifest["artifacts"]
    )


# The statuses an operation resource holds. The contract's enum is closed.
OPERATION_STATUSES = frozenset({"pending", "running", "done", "failed"})


@dataclass(frozen=True, slots=True)
class OperationState:
    """One reading of a long-build operation resource.

    Attributes:
        operation_id: The operation's id, `op_` and 64 hex digits.
        status: `pending`, `running`, `done` or `failed`.
        retry_after: The wait before the next poll the resource asks for, in
            seconds, or None.
        progress: The progress the resource reports, or None.
        manifest: The manifest, once the build is done.
        error: The problem document of a failed build, when the resource holds one.
    """

    operation_id: str
    status: str
    retry_after: float | None
    progress: Progress | None
    manifest: Wire | None
    error: Wire | None


def read_operation(resource: Wire, *, key: str | None = None) -> OperationState:
    """Read an operation resource.

    A message that quotes the resource's text has `key`, the client's key,
    redacted, and quotes at most `MESSAGE_TEXT_MAX` characters of it.

    Raises:
        ContractError: The operation's status is missing or outside `pending`,
            `running`, `done` and `failed`, its id is not `op_` and 64
            lowercase hex digits, a done operation holds no manifest that
            `check_served_manifest` passes, or a failed operation's error gives
            a `status` that is not an integer from 400 to 599
            (`contract_violation`). The id is checked before any poll names it
            in a path.
    """
    check_operation(resource)
    operation = resource["operation"]
    operation_id = operation["operation_id"]
    if not matches(OPERATION_ID, operation_id):
        raise violation(
            "The operation's id is not op_ and 64 lowercase hex digits",
            pointer="/operation/operation_id",
        )
    status = operation["status"]
    if status not in OPERATION_STATUSES:
        raise violation(
            f"The operation {operation_id} has the status {quoted(status, key)}, not "
            "pending, running, done or failed",
            pointer="/operation/status",
        )
    manifest = resource.get("manifest")
    if status == "done":
        check_served_manifest(manifest, "/manifest")
    wait = operation.get("retry_after_ms")
    progress = operation.get("progress")
    error = resource.get("error")
    if (
        status == "failed"
        and isinstance(error, Mapping)
        and "status" in error
        and not _is_error_status(error["status"])
    ):
        raise violation(
            f"The failed operation {operation_id} gives its error the status "
            f"{quoted(error['status'], key)}, not an integer from 400 to 599",
            pointer="/error/status",
        )
    return OperationState(
        operation_id=operation["operation_id"],
        status=status,
        retry_after=wait / 1000
        if isinstance(wait, int | float) and not isinstance(wait, bool) and wait >= 0
        else None,
        progress=_progress(progress) if isinstance(progress, Mapping) else None,
        manifest=manifest if isinstance(manifest, Mapping) else None,
        error=error if isinstance(error, Mapping) else None,
    )


def _is_error_status(value: object) -> bool:
    """Whether `value` is a refusal's HTTP status, an integer from 400 to 599."""
    return type(value) is int and 400 <= value <= 599


def _progress(progress: Wire) -> Progress:
    def count(name: str) -> int | None:
        value = progress.get(name)
        return value if isinstance(value, int) and not isinstance(value, bool) else None

    return Progress(count("rows_written"), count("estimate_rows"))


def poll_backoff(step: int) -> float:
    """The wait before poll `step` (from 0) when the server sends no pacing."""
    return min(POLL_BACKOFF_FIRST * 2**step, POLL_BACKOFF_CAP)


def counted_rows(manifest: Wire) -> int:
    """The rows a manifest's coverage counts, or 0 when it counts none or says no
    count."""
    coverage = manifest.get("coverage")
    rows = coverage.get("rows") if isinstance(coverage, Mapping) else None
    return rows if type(rows) is int and rows > 0 else 0


def check_served_manifest(manifest: object, pointer: str = "", /) -> None:
    """Check a manifest as `check_manifest` does, and that its `content_version`
    is a version id a ref and a cache path can hold.

    Args:
        manifest: The decoded manifest.
        pointer: The manifest's JSON Pointer in the response body.

    Raises:
        ContractError: `check_manifest` refuses it, or its `content_version` is
            not `cv_` and 32 lowercase hex digits (`contract_violation`).
    """
    check_manifest(manifest, pointer)
    assert isinstance(manifest, Mapping)
    if not matches(CONTENT_VERSION, manifest["content_version"]):
        raise violation(
            "The manifest's content_version is not cv_ and 32 lowercase hex digits",
            pointer=f"{pointer}/content_version",
        )


def read_held_until(value: object) -> date | None:
    """A retention's `held_until` as a date, or None when it is not an ISO 8601
    date or date-time string."""
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value).date()
    except ValueError:
        return None


def check_built(
    manifest: Wire, spec_id: str, content_version: str | None = None
) -> None:
    """Check a manifest names the spec it was asked for, and the version when
    `content_version` names one. A rebuild asks for no version.

    Raises:
        ContractError: The manifest names another spec or version.
    """
    built_spec, built_version = (
        manifest["definition"]["spec_id"],
        manifest["content_version"],
    )
    if built_spec != spec_id or content_version not in (None, built_version):
        asked = (
            spec_id if content_version is None else f"{spec_id} at {content_version}"
        )
        raise client_error(
            CONTRACT_VIOLATION,
            f"The server answered {built_spec} at {built_version} for {asked}",
        )


def response_json(response: httpx2.Response) -> Any:
    """The decoded JSON body of a response the client acts on, with the key its
    request carried redacted in every string and member name.

    Raises:
        ContractError: The body is not JSON.
    """
    try:
        body = loads(response.content)
    except ValueError as error:  # not JSON, or nested past JSON_MAX_DEPTH
        raise client_error(
            UNEXPECTED_RESPONSE,
            f"{response.request.method} {response.request.url.path} answered "
            f"HTTP {response.status_code} with a body that is not JSON",
            status=response.status_code,
            trace_id=trace_id_of(response),
        ) from error
    return redacted_json(body, sent_key(response))
