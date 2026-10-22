"""The pieces of a dataset build that do no I/O, shared by both clients.

A build posts a spec to the datasets surface with a scope and a rendering, and
reads back a manifest or a long-build operation. This module writes those request
bodies, reads the operation resource, picks the artifact a manifest lists for the
client's rendering, and paces polls.
`dfo._fetch` and `dfo._operation` hold the requests themselves.
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

import httpx2

from dfo._error_map import CONTRACT_VIOLATION, INVALID_ARGUMENT, UNEXPECTED_RESPONSE
from dfo._errors import client_error
from dfo._parse import check_manifest, check_operation
from dfo._refusals import trace_id_of
from dfo._types import Layout, Part, Rendering, Spec, Window, Wire

# The longest the client reads a synchronous build. The server cuts off at 120 s.
BUILD_READ_TIMEOUT = 150.0

# Poll backoff when the server sends no pacing, doubling from the first to the cap.
POLL_BACKOFF_FIRST = 1.0
POLL_BACKOFF_CAP = 8.0

_LAYOUTS = ("long", "frame")


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

    def latest_manifest(
        self, spec_id: str, rendering: Rendering, /
    ) -> dict[str, Any] | None:
        """The manifest of a spec's newest stored version in one rendering, or None."""
        ...

    def manifest_candidates(
        self, spec_id: str, rendering: Rendering, /
    ) -> list[dict[str, Any]]:
        """Stored manifests for a spec and rendering, newest first."""
        ...


def rendering_for(layout: str) -> Rendering:
    """The bare Parquet rendering both clients build for `layout`.

    Raises:
        InvalidRequestError: `layout` is neither `long` nor `frame`.
    """
    if layout not in _LAYOUTS:
        raise client_error(
            INVALID_ARGUMENT, f'layout is "long" or "frame", not {layout!r}'
        )
    return Rendering("parquet", False, "frame" if layout == "frame" else None)


def layout_of(rendering: Rendering) -> Layout:
    """The layout a bare Parquet rendering holds."""
    return "frame" if rendering.layout == "frame" else "long"


def rendering_options(rendering: Rendering) -> dict[str, Any]:
    """The build request's `options` for `rendering`."""
    options: dict[str, Any] = {"format": rendering.format, "bundle": rendering.bundle}
    if rendering.layout is not None:
        options["layout"] = rendering.layout
    return options


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
            years, or an entity role is bound to a string instead of a sequence
            of dcids.
    """
    result: dict[str, Any] = {}
    if window is not None:
        result["window"] = _window(window)
    if entities is not None:
        result["entities"] = _entities(entities)
    if facets:
        result["facets"] = {axis: {"ref": ref} for axis, ref in facets.items()}
    return result or None


def rebind(
    spec: Spec, entities: Mapping[str, Sequence[str] | None]
) -> dict[str, Sequence[str]]:
    """The whole entity binding a fetch posts, the spec's own with `entities` applied.

    The server replaces a spec's entire binding with the posted one, so the
    client starts from the roles the spec's definition binds and changes only
    the roles `entities` names. A role bound to None is dropped.

    Raises:
        InvalidRequestError: The spec's definition holds no `identity` object
            (`invalid_argument`).
    """
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
            return {"kind": "range", "start_year": start, "end_year": end}
        case _:
            raise client_error(
                INVALID_ARGUMENT,
                f'window is "all", "latest" or (start_year, end_year), not {window!r}',
            )


def _entities(entities: Mapping[str, Sequence[str]]) -> dict[str, list[str]]:
    bound = {}
    for role, dcids in entities.items():
        if isinstance(dcids, str):
            raise client_error(
                INVALID_ARGUMENT,
                f"entities[{role!r}] is a string; bind the role to a list of dcids, "
                f"such as [{dcids!r}]",
            )
        bound[role] = list(dcids)
    return bound


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
        "options": rendering_options(rendering),
    }


def kept_entity_groups(held: Spec | None, built: Wire) -> dict[str, Any]:
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
    groups that `kept_entity_groups` keeps go with the identity, so a group of
    places reads the same way again.
    """
    entry: dict[str, Any] = {
        "entry_kind": "identity",
        "variable_text": variable_text,
        "identity": built["identity"],
    }
    if groups := kept_entity_groups(held, built):
        entry["entity_groups"] = groups
    return {
        "schema_version": 1,
        "input": {"kind": "dataset_resubmit", "entries": [entry]},
    }


def pick_artifact(
    manifest: Wire, rendering: Rendering, *, digest: str | None = None
) -> Wire | None:
    """The artifact a manifest lists for `rendering`, or for `digest` when given.

    Artifacts match on their rendering's format, bundle and frame layout. The
    rendering object's other members change with layout versions, so they are
    ignored.
    """
    for artifact in manifest["artifacts"]:
        if digest is not None:
            if artifact["artifact_digest"] == digest:
                return artifact
        elif isinstance(artifact["rendering"], Mapping) and rendering.matches(
            artifact["rendering"]
        ):
            return artifact
    return None


@dataclass(frozen=True, slots=True)
class OperationState:
    """One reading of a long-build operation resource.

    Attributes:
        operation_id: The operation's id, `op_` and 64 hex digits.
        status: `pending`, `running`, `done`, `failed`, or a status this client
            does not know.
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


def read_operation(resource: Wire) -> OperationState:
    """Read an operation resource.

    Raises:
        ContractError: The operation id or status is missing, or a done
            operation holds no manifest.
    """
    check_operation(resource)
    operation = resource["operation"]
    status = operation["status"]
    manifest = resource.get("manifest")
    if status == "done":
        check_manifest(manifest, "/manifest")
    wait = operation.get("retry_after_ms")
    progress = operation.get("progress")
    error = resource.get("error")
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


def _progress(progress: Wire) -> Progress:
    def count(name: str) -> int | None:
        value = progress.get(name)
        return value if isinstance(value, int) and not isinstance(value, bool) else None

    return Progress(count("rows_written"), count("estimate_rows"))


def poll_backoff(step: int) -> float:
    """The wait before poll `step` (from 0) when the server sends no pacing."""
    return min(POLL_BACKOFF_FIRST * 2**step, POLL_BACKOFF_CAP)


def check_built(manifest: Wire, spec_id: str, content_version: str) -> None:
    """Check a version's manifest names the spec and version it was asked for.

    Raises:
        ContractError: The manifest names another spec or version.
    """
    built = (manifest["definition"]["spec_id"], manifest["content_version"])
    if built != (spec_id, content_version):
        raise client_error(
            CONTRACT_VIOLATION,
            f"The server answered {built[0]} at {built[1]} for "
            f"{spec_id} at {content_version}",
        )


def response_json(response: httpx2.Response) -> Any:
    """The decoded JSON body of a response the client acts on.

    Raises:
        ContractError: The body is not JSON.
    """
    try:
        return response.json()
    except ValueError as error:
        raise client_error(
            UNEXPECTED_RESPONSE,
            f"{response.request.method} {response.request.url.path} answered "
            f"HTTP {response.status_code} with a body that is not JSON",
            status=response.status_code,
            trace_id=trace_id_of(response),
        ) from error
