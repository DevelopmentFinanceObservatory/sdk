"""Fetching a target: a spec through the build path, or a ref's exact versions.

A `DatasetRef` returns the versions it names, found in this order: the local cache
by digest; the snapshot route and the files route at the stored digest; the file
selector, which renders the version again from its stored frame; a fresh build,
which must return the same version; and otherwise `VersionUnavailableError`,
naming the newest version in the member's rendering. A rebuilt file whose digest
differs from the ref's issues a `DfoWarning` (`ref_digest_changed`) naming both,
and the fetch returns its data, since the ref pins the version and the digest
names one rendering of it. A snapshot or build that answers another spec raises
`ContractError`, so a recovered member keeps the ref's identity. The steps after the
snapshot run only for a version whose file has expired. A version the server never
built (`snapshot_not_found`) raises at once. Concurrent fetches of one member wait
while the first reads the cache or fetches the stored file, so the file downloads
once. A cached manifest counts only when it lists the member's digest.
"""

from collections.abc import Mapping, Sequence

from dfo._core.codes import (
    CONTRACT_VIOLATION,
    DIGEST_MISMATCH,
    INVALID_ARGUMENT,
    OFFLINE,
    REF_DIGEST_CHANGED,
    VERSION_UNAVAILABLE,
)
from dfo._core.errors import (
    ContractError,
    DfoError,
    DfoWarning,
    InvalidRequestError,
    NotFoundError,
    VersionUnavailableError,
    client_error,
    client_warning,
    warn,
)
from dfo._core.parse import check_manifest
from dfo._core.refs import DatasetRef, RefMember
from dfo._core.refusals import describing, trace_id_of
from dfo._core.types import (
    CONTENT_VERSION,
    SPEC_ID,
    Layout,
    Rendering,
    Spec,
    Window,
    Wire,
    matches,
)
from dfo._datasets.build import (
    Cache,
    Reading,
    build_body,
    check_built,
    file_params,
    layout_of,
    mint_options,
    pick_artifact,
    rebind,
    response_json,
    scope,
)
from dfo._datasets.dataset import Dataset, FetchedMember, build_dataset
from dfo._datasets.fetch import (
    build_version,
    download,
    fetch_members,
    finish_member,
    holding,
    note_warnings,
    store,
)
from dfo._datasets.operation import (
    ProgressHook,
    progress_hook,
)
from dfo._datasets.progress import ProgressRenderer
from dfo._http.hooks import async_offload
from dfo._http.transport import AsyncTransport, offline

# Refusals after which the next step of a stored version's lookup order runs: the
# version exists but its stored file has expired. An unknown version
# (`snapshot_not_found`) ends the lookup, since a build cannot bring it back.
_FILE_EXPIRED = "artifact_expired"
_FILE_GONE = frozenset({_FILE_EXPIRED, "artifact_not_found", "not_found"})
# The versions one page of the versions route lists, the route's default page size.
_VERSIONS_PAGE = 100
# The most versions pages a newest-version lookup reads. Past them the lookup
# reports no newest version.
VERSIONS_PAGE_BUDGET = 20


async def fetch(
    transport: AsyncTransport,
    target: Spec | DatasetRef,
    *,
    window: Window | None = None,
    entities: Mapping[str, Sequence[str] | None] | None = None,
    facets: Mapping[str, str | None] | None = None,
    layout: Layout | None = None,
    without_party_totals: bool | None = None,
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
        without_party_totals: Leave out the rows of parties the code index
            declares totals, on each party role a spec leaves open; None is
            False for a spec. A ref holds its own choice; naming another raises.
        strict: Raise the first dataset warning instead of issuing it.
        timeout: The longest the fetch takes, in seconds, downloads included;
            None for no limit.
        progress: False silences long-build progress.
        cache: The local cache, or None to fetch without one.

    Raises:
        InvalidRequestError: A ref is narrowed or given another layout or
            `without_party_totals`; `window`, `entities`, `facets` or `layout`
            is malformed; or `entities` rebinds a spec whose definition holds
            no identity.
        VersionUnavailableError: A ref's version can no longer be fetched.
        ContractError: An artifact is not Parquet (`unexpected_response`), or
            lacks a `time_period` or numeric `value` column
            (`contract_violation`); the cache drops it.
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
            without_party_totals=without_party_totals,
            strict=strict,
            timeout=timeout,
            progress=progress,
            cache=cache,
        )
    return await fetch_members(
        transport,
        [Reading((), target, target.sentence)],
        layout="long" if layout is None else layout,
        without_party_totals=False
        if without_party_totals is None
        else without_party_totals,
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
    without_party_totals: bool | None,
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
    for member in ref.members:
        held = member.rendering.without_party_totals
        if without_party_totals is not None and without_party_totals is not held:
            raise client_error(
                INVALID_ARGUMENT,
                f"The DatasetRef holds {member.spec.spec_id} with "
                f"without_party_totals={held}, not {without_party_totals!r}; "
                "fetch its specs for the other rendering",
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
    return await async_offload(
        build_dataset,
        fetched,
        layout=ref_layout,
        complete=True,
        missing=(),
        stale=stale,
        cache=cache,
    )


def _ref_layout(ref: DatasetRef) -> Layout:
    layouts = set()
    for member in ref.members:
        if member.rendering.format != "parquet" or member.rendering.bundle:
            raise client_error(
                INVALID_ARGUMENT,
                f"The DatasetRef stores {member.spec.spec_id} as "
                f"{mint_options(member.rendering)}; this client reads bare "
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
    """One stored version, through the lookup order.

    Raises:
        InvalidRequestError: The member's spec id or version is not a server id
            (`invalid_argument`); no request is sent.
    """
    spec_id = member.spec.spec_id
    version = member.content_version
    if not matches(SPEC_ID, spec_id) or not matches(CONTENT_VERSION, version):
        raise client_error(
            INVALID_ARGUMENT,
            f"The DatasetRef member {spec_id!r} at {version!r} does not name a "
            "spec_ id and a cv_ version; load refs with DatasetRef.from_json",
        )
    refusal: DfoError | None = None
    async with holding(transport, cache, member.digest, deadline=deadline):
        if (cached := await _cached_version(cache, member)) is not None:
            note_warnings(cached[0], strict=strict, trace_id=None)
            return _stored(member, *cached)
        if cache_only:
            raise client_error(
                OFFLINE,
                f"DFO_OFFLINE=1 is set, and the cache lacks {spec_id} at {version}",
            )
        try:
            manifest, trace_id = await _snapshot(transport, member, deadline=deadline)
        except DfoError as error:
            if error.code != _FILE_EXPIRED:
                raise
            refusal = error
        else:
            note_warnings(manifest, strict=strict, trace_id=trace_id)
            data, refusal = await _stored_file(
                transport, member, manifest, trace_id, deadline=deadline
            )
            if data is not None:
                await async_offload(
                    store, cache, manifest, member.rendering, member.digest, data
                )
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
        newest = await _newest(transport, spec_id, member.rendering, deadline=deadline)
    else:
        with describing(trace_id):
            check_built(manifest, spec_id)
        if manifest["content_version"] == version:
            fetched = await finish_member(
                transport,
                manifest,
                trace_id,
                want=Reading(member.parts, member.spec, member.sentence),
                rendering=member.rendering,
                strict=strict,
                cache=cache,
                deadline=deadline,
            )
            if fetched.digest != member.digest:
                warn(_digest_changed(member, fetched.digest))
            return fetched
        newest = manifest["content_version"]
    raise _unavailable(member, newest, refusal)


async def _cached_version(
    cache: Cache | None, member: RefMember
) -> tuple[Wire, bytes] | None:
    """The cached manifest and bytes of a ref member, or None.

    The manifest must list the member's artifact, and the bytes hash to its
    digest; the cache checks the manifest's shape and version.
    """
    if cache is None:
        return None
    data = await async_offload(cache.get_bytes, member.digest)
    if data is None:
        return None
    manifest = await async_offload(
        cache.get_manifest,
        member.spec.spec_id,
        member.content_version,
        member.rendering,
    )
    if (
        manifest is None
        or pick_artifact(manifest, member.rendering, digest=member.digest) is None
    ):
        return None
    return manifest, data


def _digest_changed(member: RefMember, digest: str) -> DfoWarning:
    """The warning that a rebuild of the ref's version has another digest.

    The rebuild returned the ref's version, so the rows are the version the ref
    names, rendered to bytes with another digest.
    """
    return client_warning(
        REF_DIGEST_CHANGED,
        f"{member.spec.spec_id} at {member.content_version} was rebuilt as "
        f"{digest}, not the ref's {member.digest}; the version is the same, and "
        "dataset.ref names the rebuilt file",
    )


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
            data = await download(
                transport,
                route,
                member.digest,
                size=artifact.get("bytes"),
                deadline=deadline,
            )
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
            params=file_params(member.rendering),
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
    transport: AsyncTransport,
    spec_id: str,
    rendering: Rendering,
    *,
    deadline: float | None,
) -> str | None:
    """The newest stored version of a spec in `rendering`, or None.

    The versions route lists versions newest first, `_VERSIONS_PAGE` to a page,
    and each page's `next_cursor` names the next. Each version names the
    rendering it is: `plain`, `without_party_totals` for a party-totals cut,
    `groupby` or `not_recorded`. The newest version is the first listed in the
    rendering a ref member holds, `plain` or `without_party_totals`. A list
    that ends without one, `NotFoundError`, or `VERSIONS_PAGE_BUDGET` pages
    read without one, reads as no version. Any other refusal raises.

    Raises:
        ContractError: A page is not a versions page this client can read, or
            its `next_cursor` names a page already read (`contract_violation`);
            see `_newest_on_page`.
    """
    target = f"/datasets/{spec_id}/versions"
    route = f"GET {target}"
    wanted = "without_party_totals" if rendering.without_party_totals else "plain"
    params: dict[str, str | int] = {"limit": _VERSIONS_PAGE}
    seen: set[str] = set()
    for _ in range(VERSIONS_PAGE_BUDGET):
        try:
            response = await transport.request(
                "GET", target, params=params, deadline=deadline
            )
        except NotFoundError:
            return None
        body = response_json(response)
        trace_id = trace_id_of(response, body)
        newest, cursor = _newest_on_page(body, wanted, route, trace_id)
        if newest is not None or cursor is None:
            return newest
        if cursor in seen:
            raise _violation(route, "/next_cursor", trace_id)
        seen.add(cursor)
        params = {"limit": _VERSIONS_PAGE, "cursor": cursor}
    return None


def _newest_on_page(
    body: object, wanted: str, route: str, trace_id: str | None
) -> tuple[str | None, str | None]:
    """The first version a versions page lists in the `wanted` rendering, or None,
    and the page's `next_cursor`.

    Raises:
        ContractError: The page has no `versions` list, a listed version has no
            `content_version` or `rendering` string, or `next_cursor` is neither
            a string nor null (`contract_violation`).
    """
    versions = body.get("versions") if isinstance(body, Mapping) else None
    if not isinstance(body, Mapping) or not isinstance(versions, list):
        raise _violation(route, "/versions", trace_id)
    newest = None
    for index, version in enumerate(versions):
        entry = version if isinstance(version, Mapping) else {}
        content_version = entry.get("content_version")
        if not isinstance(content_version, str):
            raise _violation(route, f"/versions/{index}/content_version", trace_id)
        if not isinstance(listed := entry.get("rendering"), str):
            raise _violation(route, f"/versions/{index}/rendering", trace_id)
        if listed == wanted and newest is None:
            newest = content_version
    cursor = body.get("next_cursor")
    if not isinstance(cursor, str | None):
        raise _violation(route, "/next_cursor", trace_id)
    return newest, cursor


def _violation(route: str, pointer: str, trace_id: str | None) -> ContractError:
    error = client_error(
        CONTRACT_VIOLATION,
        f"{route} answered a page whose {pointer} this client cannot read",
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
