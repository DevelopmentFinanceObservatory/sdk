"""Fetching a target: a spec through the build path, or a ref's exact versions.

A `DatasetRef` returns the versions it names, found in this order: the local cache
by digest; the snapshot route and the files route at the stored digest; the file
selector, which renders the version again from its stored frame; a fresh build,
which must return the same version; and otherwise `VersionUnavailableError`,
naming the newest version. The steps after the snapshot run only for a version
whose file has expired. A version the server never built (`snapshot_not_found`)
raises at once.
"""

from collections.abc import Mapping, Sequence

from dfo._core.codes import (
    CONTRACT_VIOLATION,
    DIGEST_MISMATCH,
    INVALID_ARGUMENT,
    OFFLINE,
    VERSION_UNAVAILABLE,
)
from dfo._core.errors import (
    ContractError,
    DfoError,
    InvalidRequestError,
    NotFoundError,
    VersionUnavailableError,
    client_error,
)
from dfo._core.parse import check_manifest
from dfo._core.refs import DatasetRef, RefMember
from dfo._core.refusals import describing, trace_id_of
from dfo._core.types import (
    Layout,
    Spec,
    Window,
    Wire,
)
from dfo._datasets.build import (
    Cache,
    Reading,
    build_body,
    check_built,
    layout_of,
    pick_artifact,
    rebind,
    rendering_options,
    response_json,
    scope,
)
from dfo._datasets.dataset import Dataset, FetchedMember, build_dataset
from dfo._datasets.fetch import (
    build_version,
    download,
    fetch_members,
    finish_member,
    note_warnings,
    store,
)
from dfo._datasets.operation import (
    ProgressHook,
    progress_hook,
)
from dfo._datasets.progress import ProgressRenderer
from dfo._http.transport import AsyncTransport, offline

# Refusals after which the next step of a stored version's lookup order runs: the
# version exists but its stored file has expired. An unknown version
# (`snapshot_not_found`) ends the lookup, since a build cannot bring it back.
_FILE_EXPIRED = "artifact_expired"
_FILE_GONE = frozenset({_FILE_EXPIRED, "artifact_not_found", "not_found"})


async def fetch(
    transport: AsyncTransport,
    target: Spec | DatasetRef,
    *,
    window: Window | None = None,
    entities: Mapping[str, Sequence[str] | None] | None = None,
    facets: Mapping[str, str | None] | None = None,
    layout: Layout | None = None,
    strict: bool = False,
    timeout: float | None = 1800.0,
    progress: bool | None = None,
    cache: Cache | None = None,
) -> Dataset:
    """Fetch a spec's latest version, or the exact versions a ref names.

    Args:
        transport: The transport requests go through.
        target: A `Spec` to build, or a `DatasetRef` to read back.
        window: Narrow a spec to `"all"`, `"latest"` or `(start_year, end_year)`.
        entities: Rebind the named roles of a spec to dcids; None drops a role.
            The spec's other roles keep their binding, and an empty map
            narrows nothing.
        facets: Bind a spec's provenance, measurement method or unit.
        layout: `long` (the default for a spec) or `frame`. A ref holds its own
            layout; naming another raises.
        strict: Raise the first dataset warning instead of issuing it.
        timeout: The longest the fetch takes, in seconds, downloads included;
            None for no limit.
        progress: False silences long-build progress.
        cache: The local cache, or None to fetch without one.

    Raises:
        InvalidRequestError: A ref is narrowed or given another layout, or
            `entities` rebinds a spec whose definition holds no identity.
        VersionUnavailableError: A ref's version can no longer be fetched.
        DfoError: The server refused a request.
    """
    if isinstance(target, DatasetRef):
        if window is not None or entities or facets:
            raise client_error(
                INVALID_ARGUMENT,
                "A DatasetRef names exact versions and takes no narrowing; "
                "narrow the spec instead",
            )
        return await _fetch_ref(
            transport,
            target,
            layout=layout,
            strict=strict,
            timeout=timeout,
            progress=progress,
            cache=cache,
        )
    return await fetch_members(
        transport,
        [Reading((), target, target.sentence)],
        layout=layout or "long",
        strict=strict,
        timeout=timeout,
        progress=progress,
        cache=cache,
        narrowing=scope(
            window=window,
            entities=rebind(target, entities) if entities else None,
            facets=facets,
        ),
    )


async def _fetch_ref(
    transport: AsyncTransport,
    ref: DatasetRef,
    *,
    layout: Layout | None,
    strict: bool,
    timeout: float | None,
    progress: bool | None,
    cache: Cache | None,
) -> Dataset:
    ref_layout = _ref_layout(ref)
    if layout is not None and layout != ref_layout:
        raise client_error(
            INVALID_ARGUMENT,
            f'The DatasetRef holds the {ref_layout} layout, not "{layout}"; '
            "fetch its specs for another layout",
        )
    deadline = transport.deadline(timeout)
    stale = offline()
    with ProgressRenderer(enabled=progress) as renderer:
        fetched = [
            await _fetch_version(
                transport,
                member,
                strict=strict,
                on_progress=progress_hook(renderer),
                cache=cache,
                cache_only=stale,
                deadline=deadline,
            )
            for member in ref.members
        ]
    return build_dataset(
        fetched, layout=ref_layout, complete=True, missing=(), stale=stale
    )


def _ref_layout(ref: DatasetRef) -> Layout:
    layouts = set()
    for member in ref.members:
        if member.rendering.format != "parquet" or member.rendering.bundle:
            raise client_error(
                INVALID_ARGUMENT,
                f"The DatasetRef stores {member.spec.spec_id} as "
                f"{rendering_options(member.rendering)}; this client reads bare "
                "Parquet versions",
            )
        layouts.add(layout_of(member.rendering))
    if "frame" in layouts and len(ref.members) > 1:
        raise client_error(
            INVALID_ARGUMENT,
            'layout="frame" holds one reading, and this DatasetRef holds several',
        )
    return layouts.pop()


async def _fetch_version(
    transport: AsyncTransport,
    member: RefMember,
    *,
    strict: bool,
    on_progress: ProgressHook | None,
    cache: Cache | None,
    cache_only: bool,
    deadline: float | None,
) -> FetchedMember:
    """One stored version, through the lookup order."""
    spec_id = member.spec.spec_id
    version = member.content_version
    if cache is not None:
        data = cache.get_bytes(member.digest)
        manifest = cache.get_manifest(spec_id, version, member.rendering)
        if data is not None and manifest is not None:
            note_warnings(manifest, strict=strict, trace_id=None)
            return _stored(member, manifest, data)
    if cache_only:
        raise client_error(
            OFFLINE, f"DFO_OFFLINE=1 is set, and the cache lacks {spec_id} at {version}"
        )
    refusal: DfoError | None = None

    try:
        manifest, trace_id = await _snapshot(transport, member, deadline=deadline)
    except DfoError as error:
        if error.code != _FILE_EXPIRED:
            raise
        refusal, manifest, trace_id = error, None, None
    if manifest is not None:
        note_warnings(manifest, strict=strict, trace_id=trace_id)
        data, refusal = await _stored_file(
            transport, member, manifest, trace_id, deadline=deadline
        )
        if data is not None:
            store(cache, manifest, member.rendering, member.digest, data)
            return _stored(member, manifest, data)

    try:
        manifest, trace_id = await build_version(
            transport,
            build_body(member.spec, member.rendering),
            deadline=deadline,
            on_progress=on_progress,
        )
    except (InvalidRequestError, NotFoundError, VersionUnavailableError) as error:
        refusal = refusal or error
        newest = await _newest(transport, spec_id, deadline=deadline)
    else:
        if manifest["content_version"] == version:
            return await finish_member(
                transport,
                manifest,
                trace_id,
                want=Reading(member.parts, member.spec, member.sentence),
                rendering=member.rendering,
                strict=strict,
                cache=cache,
                deadline=deadline,
            )
        newest = manifest["content_version"]
    raise _unavailable(member, newest, refusal)


async def _snapshot(
    transport: AsyncTransport, member: RefMember, *, deadline: float | None
) -> tuple[Wire, str | None]:
    """A stored version's manifest, and the trace id of the response that carried
    it."""
    spec_id = member.spec.spec_id
    response = await transport.request(
        "GET", f"/datasets/{spec_id}/{member.content_version}", deadline=deadline
    )
    manifest = response_json(response)
    trace_id = trace_id_of(response, manifest)
    with describing(trace_id):
        check_manifest(manifest)
        check_built(manifest, spec_id, member.content_version)
    return manifest, trace_id


async def _stored_file(
    transport: AsyncTransport,
    member: RefMember,
    manifest: Wire,
    trace_id: str | None,
    *,
    deadline: float | None,
) -> tuple[bytes | None, DfoError | None]:
    """The stored artifact's bytes, from the files route or else the file selector.

    `trace_id` is the trace id of the response that carried the manifest.
    Returns the bytes, or None when neither route serves bytes with the stored
    digest, and the files route's refusal when it refused.
    """
    refusal = None
    artifact = pick_artifact(manifest, member.rendering, digest=member.digest)
    if artifact is not None:
        with describing(trace_id):
            route = transport.origin_url(artifact["url"])
        try:
            data = await download(transport, route, member.digest, deadline=deadline)
        except DfoError as error:
            if error.code not in _FILE_GONE:
                raise
            refusal = error
        else:
            return data, None
    path = f"/datasets/{member.spec.spec_id}/{member.content_version}/file"
    try:
        data = await download(
            transport,
            path,
            member.digest,
            params=rendering_options(member.rendering),
            deadline=deadline,
        )
    except DfoError as error:
        if error.code == DIGEST_MISMATCH.code:
            return None, refusal
        if error.code not in _FILE_GONE:
            raise
        return None, refusal or error
    return data, None


async def _newest(
    transport: AsyncTransport, spec_id: str, *, deadline: float | None
) -> str | None:
    """The newest stored version of a spec, or None when the spec has none.

    The versions route lists versions newest first, so a page of one holds the
    newest. Only an empty page or `NotFoundError` reads as no version. Any other
    refusal raises.

    Raises:
        ContractError: The page has no `versions` list, or its first entry has
            no `content_version` (`contract_violation`).
    """
    try:
        response = await transport.request(
            "GET",
            f"/datasets/{spec_id}/versions",
            params={"limit": 1},
            deadline=deadline,
        )
    except NotFoundError:
        return None
    body = response_json(response)
    route = f"GET /datasets/{spec_id}/versions"
    trace_id = trace_id_of(response, body)
    versions = body.get("versions") if isinstance(body, Mapping) else None
    if not isinstance(versions, list):
        raise _violation(route, "/versions", trace_id)
    if not versions:
        return None
    newest = (
        versions[0].get("content_version") if isinstance(versions[0], Mapping) else None
    )
    if not isinstance(newest, str):
        raise _violation(route, "/versions/0/content_version", trace_id)
    return newest


def _violation(route: str, pointer: str, trace_id: str | None) -> ContractError:
    error = client_error(
        CONTRACT_VIOLATION,
        f"{route} answered a page with no {pointer}, which this client acts on",
        trace_id=trace_id,
    )
    error.pointer = pointer
    return error


def _stored(member: RefMember, manifest: Wire, data: bytes) -> FetchedMember:
    return FetchedMember(
        parts=member.parts,
        spec=member.spec,
        sentence=member.sentence,
        content_version=member.content_version,
        manifest=manifest,
        digest=member.digest,
        data=data,
        rendering=member.rendering,
    )


def _unavailable(
    member: RefMember, newest: str | None, refusal: DfoError | None
) -> VersionUnavailableError:
    spec_id = member.spec.spec_id
    message = f"{spec_id} at {member.content_version} can no longer be fetched"
    if newest is not None:
        message += f"; the newest version is {newest}. Fetch the spec for it"
    message += "."
    if refusal is None:
        error = client_error(VERSION_UNAVAILABLE, message)
    else:
        error = VersionUnavailableError(
            message,
            code=refusal.code,
            status=refusal.status,
            detail=refusal.detail,
            trace_id=refusal.trace_id,
            problem=refusal.problem,
            docs_url=refusal.docs_url,
        )
    error.newest_version = newest
    return error
