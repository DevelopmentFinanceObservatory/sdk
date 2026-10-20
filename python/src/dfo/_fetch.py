"""Fetching datasets: building a spec's latest version, or a ref's exact versions.

A `Spec` builds its latest version as bare Parquet, narrowed by `window`,
`entities` and `facets`. A narrowing gives the build its own `spec_id`, so the
member keeps the spec, the version and the definition the server answered with.

A `DatasetRef` returns the versions it names, found in this order: the local cache
by digest; the snapshot route and the files route at the stored digest; the file
selector, which renders the version again from its stored frame; a fresh build,
which must return the same version; and otherwise `VersionUnavailableError`,
naming the newest version. The steps after the snapshot run only for a version
whose file has expired: a version the server never built (`snapshot_not_found`)
raises at once.

Each member's sentence is Search's: the one the caller holds when the built
`spec_id` equals the posted one, else the sentence Search gives the built identity
when it is resubmitted, checked on `spec_id`. Every download is a bare request to
the signed URL the files route redirects to, checked against its digest before the
fetch returns. Members build one after another, under one deadline.
"""

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from dfo._build import (
    Cache,
    Layout,
    Reading,
    Window,
    Wire,
    build_body,
    check_built,
    digest_of,
    layout_of,
    offline,
    pick_artifact,
    rendering_for,
    rendering_options,
    response_json,
    resubmit_body,
    scope,
)
from dfo._dataset import Dataset, FetchedMember, build_dataset
from dfo._error_map import (
    CONTRACT_VIOLATION,
    DIGEST_MISMATCH,
    INVALID_ARGUMENT,
    OFFLINE,
    UNEXPECTED_RESPONSE,
    VERSION_UNAVAILABLE,
)
from dfo._errors import (
    DataWarning,
    DfoError,
    InvalidRequestError,
    NotFoundError,
    PermissionDeniedError,
    VersionUnavailableError,
    client_error,
    warn,
)
from dfo._operation import (
    AsyncOperation,
    Finish,
    Poller,
    ProgressHook,
    post_build,
    progress_hook,
    resume,
)
from dfo._parse import check_manifest, parse_notices, parse_parts
from dfo._progress import ProgressRenderer
from dfo._strict import RESOLUTION_KIND
from dfo._transport import AsyncTransport
from dfo._types import DatasetRef, DefinitePart, Gap, RefMember, Rendering, Spec


@dataclass(frozen=True, slots=True)
class Session:
    """What a client's calls go through: its transport and its cache.

    Attributes:
        transport: The transport requests go through.
        cache: The local cache, or None to fetch without one.
    """

    transport: AsyncTransport
    cache: Cache | None = None


type SessionSource = Callable[[], Session]
"""Returns the session a call goes through, read when the call runs."""

_REDIRECTS = frozenset({301, 302, 303, 307, 308})

# The variable text an identity resubmit sends for a spec no answer part names;
# Search echoes it onto the part, and it does not change the sentence.
_UNNAMED_PART = "dataset"

# Refusals after which the next step of a stored version's lookup order runs: the
# version exists but its stored file has expired. An unknown version
# (`snapshot_not_found`) ends the lookup, since a build cannot bring it back.
_FILE_EXPIRED = "artifact_expired"
_FILE_GONE = frozenset({_FILE_EXPIRED, "artifact_not_found", "not_found"})

_SEARCH_AGAIN = (
    " The server can no longer build this reading; search the question again "
    "for a current one."
)


async def fetch(
    transport: AsyncTransport,
    target: Spec | DatasetRef,
    *,
    window: Window | None = None,
    entities: Mapping[str, Sequence[str]] | None = None,
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
        entities: Narrow a spec's roles to dcids.
        facets: Bind a spec's provenance, measurement method or unit.
        layout: `long` (the default for a spec) or `frame`. A ref holds its own
            layout; naming another raises.
        strict: Raise the first dataset warning instead of issuing it.
        timeout: The longest the fetch takes, in seconds; None for no limit.
        progress: False silences long-build progress.
        cache: The local cache, or None to fetch without one.

    Raises:
        InvalidRequestError: A ref is narrowed or given another layout.
        VersionUnavailableError: A ref's version can no longer be fetched.
        DfoError: The server refused a request.
    """
    if isinstance(target, DatasetRef):
        if window is not None or entities is not None or facets is not None:
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
        narrowing=scope(window=window, entities=entities, facets=facets),
    )


async def fetch_members(
    transport: AsyncTransport,
    readings: Sequence[Reading],
    *,
    layout: Layout = "long",
    strict: bool = False,
    timeout: float | None = 1800.0,
    progress: bool | None = None,
    cache: Cache | None = None,
    missing: Sequence[Gap] = (),
    narrowing: Mapping[str, Any] | None = None,
) -> Dataset:
    """Build the latest version of each spec and assemble one dataset.

    Args:
        transport: The transport requests go through.
        readings: The readings to build, in query order. A spec listed twice
            builds once, answering both readings' parts.
        layout: `long`, or `frame` for one reading.
        strict: Raise the first dataset warning instead of issuing it.
        timeout: The longest the fetch takes, in seconds; None for no limit.
        progress: Show long-build progress; None shows it unless `DFO_PROGRESS=0`.
        cache: The local cache, or None to fetch without one.
        missing: The gaps a partial answer leaves out; the dataset is complete
            when there are none.
        narrowing: The build request's `scope`, applied to every member.

    Raises:
        InvalidRequestError: `layout="frame"` with several members, or a build
            the server refused as malformed.
        NetworkError: `DFO_OFFLINE=1` is set, and a spec builds on the server.
        DfoTimeoutError: The deadline passed; a long build's message names the
            call that resumes it.
        DfoError: The server refused a request.
    """
    wants = _distinct(readings)
    rendering = rendering_for(layout)
    if layout == "frame" and len(wants) > 1:
        raise client_error(
            INVALID_ARGUMENT,
            'layout="frame" holds one reading; fetch each spec on its own for its '
            "frame",
        )
    if offline():
        raise client_error(
            OFFLINE,
            "DFO_OFFLINE=1 is set, and a spec builds its latest version on the "
            "server; fetch a DatasetRef to read a stored version from the cache",
        )
    deadline = transport.deadline(timeout)
    # Groups resolved for the answer's places do not hold for places rebound here.
    keep_groups = narrowing is None or "entities" not in narrowing
    fetched = []
    with ProgressRenderer(enabled=progress) as renderer:
        for want in wants:
            body = build_body(want.spec, rendering, narrowing)
            try:
                manifest = await _build(
                    transport,
                    body,
                    deadline=deadline,
                    on_progress=progress_hook(renderer),
                )
            except DfoError as error:
                if error.code == "member_not_resolvable":
                    raise _with_hint(error, _SEARCH_AGAIN) from error
                raise
            fetched.append(
                await _finish(
                    transport,
                    manifest,
                    want=want,
                    entity_groups=want.spec.entity_groups if keep_groups else None,
                    rendering=rendering,
                    strict=strict,
                    cache=cache,
                    deadline=deadline,
                )
            )
    return build_dataset(
        fetched, layout=layout, complete=not missing, missing=missing, stale=False
    )


async def mint(
    transport: AsyncTransport,
    spec: Spec,
    *,
    layout: Layout = "long",
    strict: bool = False,
    progress: bool | None = None,
    cache: Cache | None = None,
) -> AsyncOperation:
    """Start a spec's build and return it as an operation, done or running.

    Raises:
        DfoError: The server refused the build.
    """
    rendering = rendering_for(layout)
    body = build_body(spec, rendering)
    reply = await post_build(transport, body, deadline=None)
    renderer = ProgressRenderer(enabled=progress)
    poller = Poller(transport, reply, body=body, on_progress=progress_hook(renderer))
    return AsyncOperation(
        poller,
        _finisher(
            transport,
            Reading((), spec, spec.sentence),
            layout=layout,
            strict=strict,
            cache=cache,
        ),
        renderer=renderer,
    )


async def operation(
    transport: AsyncTransport,
    operation_id: str,
    *,
    layout: Layout = "long",
    strict: bool = False,
    progress: bool | None = None,
    cache: Cache | None = None,
) -> AsyncOperation:
    """Resume a build another process started, by its operation id.

    The build's rendering is in its id, so `layout` must be the one it was
    started with.

    Raises:
        NotFoundError: The server holds no operation with that id.
        DfoError: The operation failed.
    """
    renderer = ProgressRenderer(enabled=progress)
    poller = await resume(transport, operation_id, on_progress=progress_hook(renderer))
    return AsyncOperation(
        poller,
        _finisher(transport, None, layout=layout, strict=strict, cache=cache),
        renderer=renderer,
    )


def _finisher(
    transport: AsyncTransport,
    want: Reading | None,
    *,
    layout: Layout,
    strict: bool,
    cache: Cache | None,
) -> Finish:
    rendering = rendering_for(layout)

    async def finish(manifest: Wire, deadline: float | None, /) -> Dataset:
        member = await _finish(
            transport,
            manifest,
            want=want,
            entity_groups=None if want is None else want.spec.entity_groups,
            rendering=rendering,
            strict=strict,
            cache=cache,
            deadline=deadline,
        )
        return build_dataset(
            [member], layout=layout, complete=True, missing=(), stale=False
        )

    return finish


def _distinct(readings: Sequence[Reading]) -> list[Reading]:
    """One reading per `spec_id`, in first-seen order, with the parts merged."""
    merged: dict[str, Reading] = {}
    for reading in readings:
        if (seen := merged.get(reading.spec.spec_id)) is None:
            merged[reading.spec.spec_id] = reading
            continue
        merged[reading.spec.spec_id] = Reading(
            seen.parts
            + tuple(part for part in reading.parts if part not in seen.parts),
            seen.spec,
            seen.sentence or reading.sentence,
            seen.answer_parts + reading.answer_parts,
        )
    return list(merged.values())


def _with_hint(error: DfoError, hint: str) -> DfoError:
    return type(error)(
        f"{error}{hint}",
        code=error.code,
        status=error.status,
        detail=error.detail,
        trace_id=error.trace_id,
        retryable=error.retryable,
        problem=error.problem,
        docs_url=error.docs_url,
        retry_after=error.retry_after,
    )


async def _build(
    transport: AsyncTransport,
    body: Wire,
    *,
    deadline: float | None,
    on_progress: ProgressHook | None,
) -> Wire:
    """Post a build and wait for its manifest, through a long build if needed."""
    reply = await post_build(transport, body, deadline=deadline)
    if reply.manifest is not None:
        return reply.manifest
    poller = Poller(transport, reply, body=body, on_progress=on_progress)
    return await poller.wait(deadline)


async def _finish(
    transport: AsyncTransport,
    manifest: Wire,
    *,
    want: Reading | None,
    entity_groups: Mapping[str, Any] | None,
    rendering: Rendering,
    strict: bool,
    cache: Cache | None,
    deadline: float | None,
) -> FetchedMember:
    """Download a built version's artifact and give it Search's sentence.

    `want` is the reading posted, or None for a build resumed by its id.
    """
    definition = manifest["definition"]
    spec_id = definition["spec_id"]
    content_version = manifest["content_version"]
    _note_warnings(manifest, strict=strict)
    artifact = pick_artifact(manifest, rendering)
    if artifact is None:
        raise client_error(
            CONTRACT_VIOLATION,
            f"The manifest of {spec_id} at {content_version} lists no "
            f"{rendering_options(rendering)} artifact",
        )
    parts = () if want is None else want.parts
    sentence = None if want is None else want.sentence or want.spec.sentence
    if want is None or spec_id != want.spec.spec_id or sentence is None:
        sentence = await _sentence(
            transport, definition, parts, entity_groups, deadline=deadline
        )
    digest = artifact["artifact_digest"]
    data = cache.get_bytes(digest) if cache is not None else None
    if data is None:
        data = await _download(
            transport, transport.origin_url(artifact["url"]), digest, deadline=deadline
        )
    _store(cache, manifest, rendering, digest, data)
    return FetchedMember(
        parts=parts,
        spec=Spec(spec_id, definition, sentence),
        sentence=sentence,
        content_version=content_version,
        manifest=manifest,
        digest=digest,
        data=data,
        answer_parts=() if want is None else want.answer_parts,
    )


def _store(
    cache: Cache | None,
    manifest: Wire,
    rendering: Rendering,
    digest: str,
    data: bytes,
) -> None:
    if cache is None:
        return
    cache.put_bytes(digest, data)
    cache.put_manifest(
        manifest["definition"]["spec_id"],
        manifest["content_version"],
        rendering,
        manifest,
    )


def _note_warnings(manifest: Wire, *, strict: bool) -> None:
    """Issue a manifest's warn-level warnings, or raise the first under strict."""
    for notice in parse_notices(manifest.get("warnings")):
        if notice.severity == "info":
            continue
        warning = DataWarning(
            notice.message, code=notice.code, severity=notice.severity
        )
        if strict:
            raise warning
        warn(warning)


async def _download(
    transport: AsyncTransport,
    target: str,
    digest: str,
    *,
    params: Mapping[str, Any] | None = None,
    deadline: float | None,
) -> bytes:
    """Fetch a file through the route that redirects to it, checked on `digest`.

    The route answers a redirect to a signed storage URL, fetched with a bare
    request. A signed fetch that fails, or bytes that do not hash to `digest`,
    ask the route once more for a fresh URL rather than retrying the old one.

    Raises:
        ServerError: The bytes did not hash to `digest` on either attempt
            (`digest_mismatch`), or the signed fetch failed on both.
        ContractError: The route answered neither 200 nor a redirect with a
            Location.
    """
    failure: DfoError | None = None
    for _ in range(2):
        response = await transport.request(
            "GET", target, params=params, deadline=deadline
        )
        if response.status_code == 200:
            data = response.content
        elif response.status_code in _REDIRECTS:
            location = response.headers.get("location")
            if not location:
                raise client_error(
                    CONTRACT_VIOLATION,
                    f"GET {target} answered HTTP {response.status_code} "
                    "with no Location",
                    status=response.status_code,
                )
            try:
                data = await transport.download(location, deadline=deadline)
            except DfoError as error:
                if not error.retryable:
                    raise
                failure = error
                continue
        else:
            raise client_error(
                UNEXPECTED_RESPONSE,
                f"GET {target} answered HTTP {response.status_code}; "
                "a file route answers a redirect",
                status=response.status_code,
            )
        if (found := digest_of(data)) == digest:
            return data
        failure = client_error(
            DIGEST_MISMATCH, f"The file at {target} hashes to {found}, not {digest}"
        )
    assert failure is not None
    raise failure


async def _sentence(
    transport: AsyncTransport,
    definition: Wire,
    parts: tuple[str, ...],
    entity_groups: Mapping[str, Any] | None,
    *,
    deadline: float | None,
) -> str:
    """Search's sentence for a built identity, from resubmitting it.

    Raises:
        ContractError: Search did not answer the identity with one definite part
            of the same `spec_id` and a sentence.
    """
    spec_id = definition["spec_id"]
    response = await transport.request(
        "POST",
        "/search/resolve",
        json=resubmit_body(
            definition["identity"], "; ".join(parts) or _UNNAMED_PART, entity_groups
        ),
        deadline=deadline,
    )
    answer = response_json(response)
    found = None
    if isinstance(answer, Mapping) and answer.get("kind") == RESOLUTION_KIND:
        resolved = parse_parts(answer)
        if len(resolved) == 1 and isinstance(part := resolved[0], DefinitePart):
            found = part.spec
    if found is None or found.spec_id != spec_id or not found.sentence:
        raise client_error(
            CONTRACT_VIOLATION,
            f"Search did not resolve the built identity {spec_id} to itself "
            "with a sentence",
        )
    return found.sentence


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
            _note_warnings(manifest, strict=strict)
            return _stored(member, manifest, data)
    if cache_only:
        raise client_error(
            OFFLINE, f"DFO_OFFLINE=1 is set, and the cache lacks {spec_id} at {version}"
        )
    refusal: DfoError | None = None

    try:
        manifest = await _snapshot(transport, member, deadline=deadline)
    except DfoError as error:
        if error.code != _FILE_EXPIRED:
            raise
        refusal, manifest = error, None
    if manifest is not None:
        _note_warnings(manifest, strict=strict)
        data, refusal = await _stored_file(
            transport, member, manifest, deadline=deadline
        )
        if data is not None:
            _store(cache, manifest, member.rendering, member.digest, data)
            return _stored(member, manifest, data)

    try:
        manifest = await _build(
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
            return await _finish(
                transport,
                manifest,
                want=Reading(member.parts, member.spec, member.sentence),
                entity_groups=None,
                rendering=member.rendering,
                strict=strict,
                cache=cache,
                deadline=deadline,
            )
        newest = manifest["content_version"]
    raise _unavailable(member, newest, refusal)


async def _snapshot(
    transport: AsyncTransport, member: RefMember, *, deadline: float | None
) -> Wire:
    spec_id = member.spec.spec_id
    response = await transport.request(
        "GET", f"/datasets/{spec_id}/{member.content_version}", deadline=deadline
    )
    manifest = response_json(response)
    check_manifest(manifest)
    check_built(manifest, spec_id, member.content_version)
    return manifest


async def _stored_file(
    transport: AsyncTransport,
    member: RefMember,
    manifest: Wire,
    *,
    deadline: float | None,
) -> tuple[bytes | None, DfoError | None]:
    """The stored artifact's bytes, from the files route or else the file selector.

    Returns the bytes, or None when neither route serves bytes with the stored
    digest, and the files route's refusal when it refused.
    """
    refusal = None
    artifact = pick_artifact(manifest, member.rendering, digest=member.digest)
    if artifact is not None:
        try:
            data = await _download(
                transport,
                transport.origin_url(artifact["url"]),
                member.digest,
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
        data = await _download(
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
    """The newest stored version of a spec, from the versions route, or None."""
    try:
        response = await transport.request(
            "GET", f"/datasets/{spec_id}/versions", deadline=deadline
        )
    except (NotFoundError, PermissionDeniedError):
        return None
    body = response_json(response)
    versions = body.get("versions") if isinstance(body, Mapping) else None
    if not versions or not isinstance(versions[0], Mapping):
        return None
    newest = versions[0].get("content_version")
    return newest if isinstance(newest, str) else None


def _stored(member: RefMember, manifest: Wire, data: bytes) -> FetchedMember:
    return FetchedMember(
        parts=member.parts,
        spec=member.spec,
        sentence=member.sentence,
        content_version=member.content_version,
        manifest=manifest,
        digest=member.digest,
        data=data,
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
