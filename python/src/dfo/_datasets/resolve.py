"""Fetching a target: a spec through the build path, or a ref's exact versions.

A `DatasetRef` fetched with `latest=True` builds the newest version of each
member's spec, in the ref's one rendering, stacked under the members' parts as an
answer's fetch stacks them. Otherwise a `DatasetRef` returns the versions it names, found in this order: the local cache
by digest; the snapshot route and the files route at the stored digest; the file
selector, which renders the version again from its stored frame; a fresh build,
which must return the same version; and otherwise `VersionUnavailableError`,
whose `newest_version` names the version the build answered, else the newest
plain build. A rebuilt file whose digest
differs from the ref's issues a `DfoWarning` (`ref_digest_changed`) naming both,
and the fetch returns its data, since the ref pins the version and the digest
names one rendering of it. A snapshot or build that answers another spec raises
`ContractError`, so a recovered member keeps the ref's identity. The steps after the
snapshot run only for a version whose file has expired. A version the server never
built (`snapshot_not_found`) raises at once. Concurrent fetches of one member wait
while the first reads the cache or fetches the stored file, so the file downloads
once. A cached manifest counts only when it lists the member's digest. Bytes the
file selector served for a manifest that does not list them are stored with an
artifact entry naming the selector, so they count on the next fetch.
"""

from collections.abc import Mapping

import httpx2

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
    recast,
    warn,
)
from dfo._core.refs import DatasetRef, RefMember
from dfo._core.refusals import describing, trace_id_of
from dfo._core.text import cited
from dfo._core.types import (
    CONTENT_VERSION,
    SPEC_ID,
    FormatError,
    Layout,
    Spec,
    Window,
    Wire,
    matches,
)
from dfo._datasets.build import (
    Cache,
    Entities,
    Reading,
    build_body,
    check_built,
    check_served_manifest,
    check_strict,
    file_params,
    layout_of,
    lists_digest,
    pick_artifact,
    response_json,
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
    finishing,
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
    entities: Entities | None = None,
    facets: Mapping[str, str | None] | None = None,
    layout: Layout | None = None,
    party_totals: bool | None = None,
    latest: bool = False,
    strict: bool = False,
    timeout: float | None = None,
    progress: bool | None = None,
    cache: Cache | None = None,
) -> Dataset:
    """Fetch a spec's latest version, the exact versions a ref names, or with
    `latest=True` the newest versions of a ref's specs.

    Args:
        transport: The transport requests go through.
        target: A `Spec` to build, or a `DatasetRef` to read back.
        window: Narrow a spec to `"all"`, `"latest"` or `(start_year, end_year)`.
        entities: Rebind the named roles of a spec to dcids; None drops a role.
            The keys are the spec's role keys, `spec.roles`. The spec's other
            roles keep their binding, and an empty map narrows nothing.
        facets: Bind a spec's provenance, measurement method or unit.
        layout: `long` (the default for a spec) or `frame`. A ref holds its own
            layout; naming another raises.
        party_totals: Keep the rows of parties the code index declares totals,
            on each party role a spec leaves open; None is False for a spec,
            which leaves them out. A ref holds its own choice; naming another
            raises.
        latest: Build the newest version of each of a ref's specs, in the
            rendering the ref holds, in place of the exact versions it names.
            A spec always fetches its newest version and refuses it.
        strict: Raise the first dataset warning instead of issuing it.
        timeout: The longest the fetch takes, in seconds, downloads included;
            None waits as long as the build takes.
        progress: False silences long-build progress.
        cache: The local cache, or None to fetch without one.

    Raises:
        InvalidRequestError: The target is neither a `Spec` nor a `DatasetRef`,
            such as a spec id; a ref is narrowed or given another layout or
            `party_totals`; `latest` is not a bool, is given a spec, or
            is given a ref whose members differ in rendering; `window`,
            `entities`, `facets`, `layout`, `strict` or `progress` is malformed;
            `entities` names a role the spec does not declare; or `entities`
            rebinds a spec whose definition holds no identity.
            No request is sent.
        VersionUnavailableError: A ref's version can no longer be fetched.
        FormatError: A ref's stored version lists the member's digest under
            another rendering than the member's (`format_invalid` at
            `/members/{i}/artifact/rendering`); its file is not downloaded.
        ContractError: An artifact is not Parquet (`unexpected_response`), or
            lacks a `time_period` or numeric `value` column
            (`contract_violation`); the cache drops it.
        DfoError: The server refused a request.
    """
    if not isinstance(latest, bool):
        raise client_error(
            INVALID_ARGUMENT, f"latest is True or False, not {latest!r}."
        )
    caller = transport.caller
    if isinstance(target, DatasetRef):
        members = _dataset_members(target)
        if window is not None:
            raise client_error(
                INVALID_ARGUMENT, _ref_window_refusal(window, latest, caller)
            )
        if entities or facets:
            raise client_error(
                INVALID_ARGUMENT,
                "A ref fetch takes no entities or facets; narrow a member's spec "
                f"instead, as {caller}.fetch(ref.members[0].spec, entities=...).",
            )
        layout = _checked_ref_layout(members, layout=layout, party_totals=party_totals)
        if latest:
            return await _fetch_newest(
                transport,
                members,
                layout=layout,
                strict=strict,
                timeout=timeout,
                progress=progress,
                cache=cache,
            )
        return await _fetch_ref(
            transport,
            members,
            layout=layout,
            strict=strict,
            timeout=timeout,
            progress=progress,
            cache=cache,
        )
    if not isinstance(target, Spec):
        raise client_error(
            INVALID_ARGUMENT,
            "fetch takes a Spec, such as answer.specs[0], or a DatasetRef, not "
            f"{type(target).__name__}; a spec id alone does not build",
        )
    if latest:
        raise client_error(
            INVALID_ARGUMENT,
            "A spec always fetches its newest version, so latest is for a "
            f"DatasetRef; drop it: {caller}.fetch(spec).",
        )
    return await fetch_members(
        transport,
        [Reading((), target, target.sentence)],
        layout="long" if layout is None else layout,
        party_totals=False if party_totals is None else party_totals,
        strict=strict,
        timeout=timeout,
        progress=progress,
        cache=cache,
        window=window,
        entities=entities,
        facets=facets,
    )


def _ref_window_refusal(window: object, latest: bool, caller: str) -> str:
    """Why a ref fetch refuses `window`, and the call that does what it asks:
    `latest=True` for the newest version, else a member's spec for a narrower
    window."""
    if window == "latest" and not latest:
        return "A ref fetch takes no window; for the newest version use latest=True."
    return (
        "A ref fetch takes no window; to narrow the years, fetch a member's spec: "
        f"{caller}.fetch(ref.members[0].spec, window={cited(window)})."
    )


def _dataset_members(ref: DatasetRef) -> tuple[RefMember, ...]:
    """The dataset members of a ref.

    Raises:
        InvalidRequestError: The ref holds derived members, which this client
            reads but does not fetch (`invalid_argument`).
    """
    members = tuple(member for member in ref.members if isinstance(member, RefMember))
    if len(members) != len(ref.members):
        raise client_error(
            INVALID_ARGUMENT,
            f"The DatasetRef names {ref.members[0].spec.spec_id}, a frame DFO "
            "computed, and this client fetches dataset versions only",
        )
    return members


def _checked_ref_layout(
    members: tuple[RefMember, ...], *, layout: Layout | None, party_totals: bool | None
) -> Layout:
    """The layout a ref holds, once the call's `layout` and `party_totals`, when
    given, are the ref's own.

    Raises:
        InvalidRequestError: The ref holds a rendering this client does not read,
            or the call names another layout or `party_totals`
            (`invalid_argument`).
    """
    ref_layout = _ref_layout(members)
    if layout is not None and layout != ref_layout:
        raise client_error(
            INVALID_ARGUMENT,
            f'The DatasetRef holds the {ref_layout} layout, not "{layout}"; '
            "fetch its specs for another layout",
        )
    for member in members:
        held = not member.rendering.without_party_totals
        if party_totals is not None and party_totals is not held:
            raise client_error(
                INVALID_ARGUMENT,
                f"The DatasetRef holds {member.spec.spec_id} with "
                f"party_totals {held}, not {party_totals!r}; "
                "fetch its specs for the other rendering",
            )
    return ref_layout


async def _fetch_newest(
    transport: AsyncTransport,
    members: tuple[RefMember, ...],
    *,
    layout: Layout,
    strict: bool,
    timeout: float | None,
    progress: bool | None,
    cache: Cache | None,
) -> Dataset:
    """The newest version of each member's spec in the ref's rendering, stacked
    under the members' parts as an answer's fetch stacks them.

    Raises:
        InvalidRequestError: The members hold different renderings, since one
            fetch builds one (`invalid_argument`).
    """
    first, *others = members
    for index, other in enumerate(others, start=1):
        if other.rendering != first.rendering:
            raise client_error(
                INVALID_ARGUMENT,
                f"The DatasetRef holds {first.spec.spec_id} and "
                f"{other.spec.spec_id} in different renderings, and a latest "
                "fetch builds one; fetch each spec on its own, as "
                f'{transport.caller}.fetch(ref.members[{index}].spec, layout="'
                f'{layout_of(other.rendering)}", party_totals='
                f"{not other.rendering.without_party_totals}).",
            )
    return await fetch_members(
        transport,
        [Reading(member.parts, member.spec, member.sentence) for member in members],
        layout=layout,
        party_totals=not first.rendering.without_party_totals,
        strict=strict,
        timeout=timeout,
        progress=progress,
        cache=cache,
    )


async def _fetch_ref(
    transport: AsyncTransport,
    members: tuple[RefMember, ...],
    *,
    layout: Layout,
    strict: bool,
    timeout: float | None,
    progress: bool | None,
    cache: Cache | None,
) -> Dataset:
    check_strict(strict)
    deadline = transport.deadline(timeout)
    stale = offline()
    with ProgressRenderer(enabled=progress) as renderer:
        on_progress = progress_hook(renderer)
        fetched = [
            await _fetch_version(
                transport,
                member,
                pointer=f"/members/{index}",
                strict=strict,
                on_progress=on_progress,
                cache=cache,
                cache_only=stale,
                deadline=deadline,
                timeout=timeout,
            )
            for index, member in enumerate(members)
        ]
    return await async_offload(
        build_dataset,
        fetched,
        layout=layout,
        complete=True,
        missing=(),
        stale=stale,
        cache=cache,
        caller=transport.caller,
    )


def _ref_layout(members: tuple[RefMember, ...]) -> Layout:
    layouts = set()
    for member in members:
        if member.rendering.format != "parquet" or member.rendering.bundle:
            raise client_error(
                INVALID_ARGUMENT,
                f"The DatasetRef stores {member.spec.spec_id} as "
                f"{member.rendering.to_object()}; this client reads bare "
                "Parquet versions",
            )
        layouts.add(layout_of(member.rendering))
    if "frame" in layouts and len(members) > 1:
        raise client_error(
            INVALID_ARGUMENT,
            'layout="frame" holds one reading, and this DatasetRef holds several',
        )
    return layouts.pop()


async def _fetch_version(
    transport: AsyncTransport,
    member: RefMember,
    *,
    pointer: str,
    strict: bool,
    on_progress: ProgressHook,
    cache: Cache | None,
    cache_only: bool,
    deadline: float | None,
    timeout: float | None,
) -> FetchedMember:
    """One stored version, through the lookup order. `pointer` locates the
    member in the ref, and `timeout` is the caller's, which set `deadline`.

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
                transport, member, pointer, manifest, trace_id, deadline=deadline
            )
            if data is not None:
                await async_offload(
                    store,
                    cache,
                    _listing(transport, manifest, member, data),
                    member.rendering,
                    member.digest,
                    data,
                )
                return _stored(member, manifest, data)

    try:
        built = await build_version(
            transport,
            build_body(member.spec, member.rendering),
            deadline=deadline,
            timeout=timeout,
            on_progress=on_progress,
        )
    except (InvalidRequestError, NotFoundError, VersionUnavailableError) as error:
        refusal = refusal or error
        newest = await _newest(transport, spec_id, deadline=deadline)
    else:
        with describing(built.trace_id):
            check_built(built.manifest, spec_id)
        if built.manifest["content_version"] == version:
            with finishing(transport, built, deadline, timeout=timeout) as (
                finisher,
                bound,
            ):
                fetched = await finish_member(
                    finisher,
                    built.manifest,
                    built.trace_id,
                    want=Reading(member.parts, member.spec, member.sentence),
                    rendering=member.rendering,
                    strict=strict,
                    cache=cache,
                    deadline=bound,
                )
            if fetched.digest != member.digest:
                warn(_digest_changed(member, fetched.digest))
            return fetched
        newest = built.manifest["content_version"]
    raise _unavailable(member, newest, refusal, caller=transport.caller)


async def _cached_version(
    cache: Cache | None, member: RefMember
) -> tuple[Wire, bytes] | None:
    """The cached manifest and bytes of a ref member, or None.

    The manifest must list the member's artifact, and the bytes hash to its
    digest. The cache checks the manifest's shape and version.
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


def _listing(
    transport: AsyncTransport, manifest: Wire, member: RefMember, data: bytes
) -> Wire:
    """`manifest`, listing the member's artifact as an entry naming the file
    selector when it does not list the member's digest.

    The selector served `data`, which hashes to the digest, for this version, so
    the entry is what a later cache read checks the bytes belong to it by.
    """
    if pick_artifact(manifest, member.rendering, digest=member.digest) is not None:
        return manifest
    selector = httpx2.URL(
        transport.base_url.removeprefix(transport.origin) + _selector_path(member),
        params=file_params(member.rendering),
    )
    entry = {
        "artifact_digest": member.digest,
        "rendering": member.rendering.to_object(),
        "bytes": len(data),
        "url": str(selector),
    }
    return {**manifest, "artifacts": [*manifest["artifacts"], entry]}


def _selector_path(member: RefMember) -> str:
    """The file selector's path for the member's version, under the base URL."""
    return f"/datasets/{member.spec.spec_id}/{member.content_version}/file"


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
        check_served_manifest(manifest)
        check_built(manifest, spec_id, member.content_version)
    return manifest, trace_id


async def _stored_file(
    transport: AsyncTransport,
    member: RefMember,
    pointer: str,
    manifest: Wire,
    trace_id: str | None,
    *,
    deadline: float | None,
) -> tuple[bytes | None, DfoError | None]:
    """The stored artifact's bytes, from the files route or else the file selector.

    `pointer` locates the member in the ref, and `trace_id` is the trace id of
    the response that carried the manifest. Returns the bytes, or None when
    neither route serves bytes with the stored digest, and the files route's
    refusal when it refused.

    Raises:
        FormatError: The manifest lists the member's digest only under another
            rendering, so the ref's rendering and its file disagree
            (`format_invalid`).
    """
    refusal = None
    artifact = pick_artifact(manifest, member.rendering, digest=member.digest)
    if artifact is None and lists_digest(manifest, member.digest):
        raise FormatError(
            "format_invalid",
            f"{pointer}/artifact/rendering",
            f"{member.rendering.to_object()} is not the rendering the server "
            f"lists for {member.digest}",
        )
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
    try:
        data = await download(
            transport,
            _selector_path(member),
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
    *,
    deadline: float | None,
) -> str | None:
    """The newest plain build of a spec, or None.

    The versions route lists versions newest first, `_VERSIONS_PAGE` to a page,
    and each page's `next_cursor` names the next. A version derived from a plain
    build, a groupby collapse or a party-totals cut, names that build as its
    `base_content_version`; the newest plain build is the first version listed
    with none. A list that ends without one, `NotFoundError`, or
    `VERSIONS_PAGE_BUDGET` pages read without one, reads as no version. Any
    other refusal raises.

    Raises:
        ContractError: A page is not a versions page this client can read, or
            its `next_cursor` names a page already read (`contract_violation`);
            see `_newest_on_page`.
    """
    target = f"/datasets/{spec_id}/versions"
    route = f"GET {target}"
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
        newest, cursor = _newest_on_page(body, route, trace_id)
        if newest is not None or cursor is None:
            return newest
        if cursor in seen:
            raise _violation(route, "/next_cursor", trace_id)
        seen.add(cursor)
        params = {"limit": _VERSIONS_PAGE, "cursor": cursor}
    return None


def _newest_on_page(
    body: object, route: str, trace_id: str | None
) -> tuple[str | None, str | None]:
    """The first plain build a versions page lists, or None, and the page's
    `next_cursor`.

    Raises:
        ContractError: The page has no `versions` list, a listed version's
            `content_version` is not `cv_` and 32 lowercase hex digits or its
            `base_content_version` is neither a string nor null, or
            `next_cursor` is neither a string nor null (`contract_violation`).
    """
    versions = body.get("versions") if isinstance(body, Mapping) else None
    if not isinstance(body, Mapping) or not isinstance(versions, list):
        raise _violation(route, "/versions", trace_id)
    newest = None
    for index, version in enumerate(versions):
        entry = version if isinstance(version, Mapping) else {}
        content_version = entry.get("content_version")
        if not matches(CONTENT_VERSION, content_version):
            raise _violation(route, f"/versions/{index}/content_version", trace_id)
        if "base_content_version" not in entry or not isinstance(
            base := entry["base_content_version"], str | None
        ):
            raise _violation(route, f"/versions/{index}/base_content_version", trace_id)
        if base is None and newest is None:
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
    member: RefMember, newest: str | None, refusal: DfoError | None, *, caller: str
) -> VersionUnavailableError:
    lost = f"{member.spec.spec_id} at {member.content_version} can no longer be fetched"
    # The message names no other version: the newest plain build is not
    # comparable with the version of a party-totals cut.
    if newest == member.content_version:
        message = f"{lost}, though the server lists it as the newest version."
    else:
        message = f"{lost}. For the newest version: {caller}.fetch(ref, latest=True)"
    if refusal is None:
        error = client_error(VERSION_UNAVAILABLE, message)
    else:
        error = recast(
            refusal,
            VersionUnavailableError,
            message=message,
            retryable=False,
            retry_after=None,
        )
    error.newest_version = newest
    return error
