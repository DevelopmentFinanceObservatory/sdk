"""Building a spec's latest version, and the steps every fetch shares.

A `Spec` builds its latest version as bare Parquet, narrowed by `window`,
`entities` and `facets`. A narrowing gives the build its own `spec_id`, so the
member keeps the spec, the version and the definition the server answered with.

Each member's sentence is Search's. It is the one the caller holds when the built
`spec_id` equals the posted one, else the sentence Search gives the built identity
when it is resubmitted, checked on `spec_id`. A narrowing that holds no data
builds an empty version, and Search answers its identity with one `no_data` part,
whose sentence labels the empty member. Every download asks the files route
and fetches the URL its `Location` names: bare on the storage host, with the
client's headers on the API's origin, checked against its digest before the fetch
returns. A manifest artifact's `url` must be on the API's origin. Members build
one after another, under one deadline. Cache reads and writes, hashing and
Parquet decoding run through `async_offload`, off the event loop. Concurrent
fetches of one artifact download it once, through `Cache.downloading`.

`dfo._datasets.resolve` holds `fetch`, which reads a `DatasetRef` through these steps.
"""

from collections.abc import Callable, Mapping, Sequence
from contextlib import nullcontext
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urljoin

from dfo._core.codes import (
    CONTRACT_VIOLATION,
    DIGEST_MISMATCH,
    INVALID_ARGUMENT,
    OFFLINE,
    UNEXPECTED_RESPONSE,
)
from dfo._core.errors import (
    DataWarning,
    DfoError,
    client_error,
    warn,
)
from dfo._core.parse import parse_notices, parse_parts
from dfo._core.refusals import describing, trace_id_of
from dfo._core.types import (
    RENDERING_SELECTORS,
    AsyncCandidate,
    DefinitePart,
    Gap,
    Layout,
    NoDataPart,
    Rendering,
    Spec,
    Wire,
)
from dfo._datasets.build import (
    Cache,
    Reading,
    build_body,
    counted_rows,
    layout_of,
    mint_options,
    pick_artifact,
    rendering_for,
    response_json,
    resubmit_body,
)
from dfo._datasets.cache import sha256_digest
from dfo._datasets.dataset import Dataset, FetchedMember, build_dataset
from dfo._datasets.operation import (
    AsyncOperation,
    Finish,
    Poller,
    ProgressHook,
    post_build,
    progress_hook,
    resume,
)
from dfo._datasets.progress import ProgressRenderer
from dfo._generated.strict import RESOLUTION_KIND
from dfo._http.hooks import Hold, async_offload
from dfo._http.transport import DEFAULT_MAX_BYTES, AsyncTransport, offline


@dataclass(frozen=True, slots=True)
class Session:
    """What a client's calls go through: its transport and its cache.

    Attributes:
        transport: The transport requests go through.
        cache: The local cache, or None to fetch without one.
    """

    transport: AsyncTransport
    cache: Cache | None = None
    # A default-client session holds its client only while an operation uses it.
    # That keeps a replaced default client's transport open through its request.
    owner: object | None = field(default=None, compare=False, repr=False)


type SessionSource = Callable[[], Session]
"""Returns the session a call goes through, read when the call runs."""

# The variable text an identity resubmit sends for a spec no answer part names;
# Search echoes it onto the part, and it does not change the sentence.
_UNNAMED_PART = "dataset"

_SEARCH_AGAIN = (
    " The server can no longer build this reading; search the question again "
    "for a current one."
)


async def fetch_members(
    transport: AsyncTransport,
    readings: Sequence[Reading],
    *,
    layout: Layout = "long",
    without_party_totals: bool = False,
    strict: bool = False,
    timeout: float | None = 1800.0,
    progress: bool | None = None,
    cache: Cache | None = None,
    missing: Sequence[Gap[AsyncCandidate]] = (),
    narrowing: Mapping[str, Any] | None = None,
) -> Dataset:
    """Build the latest version of each spec and assemble one dataset.

    Args:
        transport: The transport requests go through.
        readings: The readings to build, in query order. A spec listed twice
            builds once, answering both readings' parts.
        layout: `long`, or `frame` for one reading.
        without_party_totals: Leave out the rows of parties the code index
            declares totals, on each party role the reading leaves open.
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
        NetworkError: `DFO_OFFLINE=1` is set, and the cache holds no version of
            a spec, or the fetch narrows it (`offline`).
        DfoTimeoutError: The deadline passed; a long build's message names the
            call that resumes it.
        DfoError: The server refused a request.
    """
    wants = _distinct(readings)
    rendering = rendering_for(layout, without_party_totals=without_party_totals)
    if layout == "frame" and len(wants) > 1:
        raise client_error(
            INVALID_ARGUMENT,
            'layout="frame" holds one reading; fetch each spec on its own for its '
            "frame",
        )
    stale = offline()
    if stale and narrowing is not None:
        raise client_error(
            OFFLINE,
            "DFO_OFFLINE=1 is set, and a narrowed spec's version is known only to "
            "the server; fetch it without window, entities or facets",
        )
    deadline = transport.deadline(timeout)
    fetched = []
    with ProgressRenderer(enabled=progress) as renderer:
        for want in wants:
            if stale:
                manifest, cached_data = await _latest_cached(
                    cache, want.spec.spec_id, rendering
                )
                trace_id = None
            else:
                manifest, trace_id = await _build_latest(
                    transport,
                    build_body(want.spec, rendering, narrowing),
                    deadline=deadline,
                    on_progress=progress_hook(renderer),
                )
                cached_data = None
            fetched.append(
                await finish_member(
                    transport,
                    manifest,
                    trace_id,
                    want=want,
                    rendering=rendering,
                    strict=strict,
                    cache=cache,
                    deadline=deadline,
                    cached_data=cached_data,
                )
            )
    return await async_offload(
        build_dataset,
        fetched,
        layout=layout,
        complete=not missing,
        missing=missing,
        stale=stale,
        cache=cache,
    )


async def _build_latest(
    transport: AsyncTransport,
    body: Wire,
    *,
    deadline: float | None,
    on_progress: ProgressHook | None,
) -> tuple[Wire, str | None]:
    """Build a spec's latest version, hinting a search when a member is gone."""
    try:
        return await build_version(
            transport, body, deadline=deadline, on_progress=on_progress
        )
    except DfoError as error:
        if error.code == "member_not_resolvable":
            raise _with_hint(error, _SEARCH_AGAIN) from error
        raise


async def _latest_cached(
    cache: Cache | None, spec_id: str, rendering: Rendering
) -> tuple[Wire, bytes]:
    """The newest plain cached manifest and its verified artifact bytes.

    Raises:
        NetworkError: The cache holds no version of it (`offline`).
    """
    if cache is not None:
        candidates = await async_offload(cache.manifest_candidates, spec_id, rendering)
        for manifest in candidates:
            cached = await _plain_cached_manifest(cache, manifest, rendering)
            if cached is not None:
                return cached
    raise client_error(
        OFFLINE,
        f"DFO_OFFLINE=1 is set, and the cache holds no version of {spec_id}",
    )


async def _plain_cached_manifest(
    cache: Cache, manifest: Wire, rendering: Rendering, /
) -> tuple[Wire, bytes] | None:
    """A plain artifact from a cached manifest, with verified bytes.

    A `DatasetRef` records only the coarse selector, while an artifact can also
    record a column projection or pivot. Such an artifact remains available to
    its exact-digest ref, but cannot stand in for a plain spec fetch.
    """
    for artifact in manifest["artifacts"]:
        artifact_rendering = artifact["rendering"]
        if not rendering.matches(artifact_rendering) or not _is_plain_rendering(
            artifact_rendering
        ):
            continue
        data = await async_offload(cache.get_bytes, artifact["artifact_digest"])
        if data is None:
            continue
        cached = dict(manifest)
        cached["artifacts"] = [artifact]
        return cached, data
    return None


def _is_plain_rendering(rendering: Mapping[str, Any], /) -> bool:
    """Whether an artifact's rendering holds only what `Rendering.matches` compares.

    Besides those members it may carry `metadata` set to `incomplete`. Any other
    member, such as `columns`, `pivot` or `groupby`, reshapes the rows.
    """
    for key, value in rendering.items():
        if key == "metadata" and value == "incomplete":
            continue
        if key not in RENDERING_SELECTORS:
            return False
    return True


async def mint(
    transport: AsyncTransport,
    spec: Spec,
    *,
    layout: Layout = "long",
    without_party_totals: bool = False,
    progress: bool | None = None,
    cache: Cache | None = None,
) -> AsyncOperation:
    """Start a spec's build and return it as an operation, done or running.

    The build request reads for up to 150 seconds and has no outer deadline.
    The operation's `result` bounds the wait for the build.

    Raises:
        InvalidRequestError: `spec` is not a `Spec`, such as a spec id
            (`invalid_argument`); no request is sent.
        DfoError: The server refused the build.
    """
    if not isinstance(spec, Spec):
        raise client_error(
            INVALID_ARGUMENT,
            "mint takes a Spec, such as answer.specs[0], not "
            f"{type(spec).__name__}; a spec id alone does not build",
        )
    rendering = rendering_for(layout, without_party_totals=without_party_totals)
    body = build_body(spec, rendering)
    reply = await post_build(transport, body, deadline=None)
    renderer = ProgressRenderer(enabled=progress)
    poller = Poller(transport, reply, body=body, on_progress=progress_hook(renderer))
    return AsyncOperation(
        poller,
        _finisher(transport, Reading((), spec, spec.sentence), rendering, cache=cache),
        renderer=renderer,
    )


async def operation(
    transport: AsyncTransport,
    operation_id: str,
    *,
    layout: Layout = "long",
    without_party_totals: bool = False,
    progress: bool | None = None,
    cache: Cache | None = None,
) -> AsyncOperation:
    """Resume a build another process started, by its operation id.

    The build's rendering is in its id, so `layout` and `without_party_totals`
    must be the ones it was started with. An operation that already failed
    raises its error from `result`.

    Raises:
        NotFoundError: The server holds no operation with that id.
    """
    rendering = rendering_for(layout, without_party_totals=without_party_totals)
    renderer = ProgressRenderer(enabled=progress)
    poller = await resume(transport, operation_id, on_progress=progress_hook(renderer))
    return AsyncOperation(
        poller,
        _finisher(transport, None, rendering, cache=cache),
        renderer=renderer,
    )


def _finisher(
    transport: AsyncTransport,
    want: Reading | None,
    rendering: Rendering,
    *,
    cache: Cache | None,
) -> Finish:
    """The step that downloads an operation's done build; it raises no warning."""

    async def finish(
        manifest: Wire, trace_id: str | None, deadline: float | None, /
    ) -> Dataset:
        member = await finish_member(
            transport,
            manifest,
            trace_id,
            want=want,
            rendering=rendering,
            strict=False,
            cache=cache,
            deadline=deadline,
        )
        return await async_offload(
            build_dataset,
            [member],
            layout=layout_of(rendering),
            complete=True,
            missing=(),
            stale=False,
            cache=cache,
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


async def build_version(
    transport: AsyncTransport,
    body: Wire,
    *,
    deadline: float | None,
    on_progress: ProgressHook | None,
) -> tuple[Wire, str | None]:
    """Post a build and wait for its manifest, through a long build if needed.

    Returns the manifest and the trace id of the response that carried it.
    """
    reply = await post_build(transport, body, deadline=deadline)
    if reply.manifest is not None:
        return reply.manifest, reply.trace_id
    poller = Poller(transport, reply, body=body, on_progress=on_progress)
    manifest = await poller.wait(deadline)
    return manifest, poller.trace_id


async def finish_member(
    transport: AsyncTransport,
    manifest: Wire,
    trace_id: str | None,
    *,
    want: Reading | None,
    rendering: Rendering,
    strict: bool,
    cache: Cache | None,
    deadline: float | None,
    cached_data: bytes | None = None,
) -> FetchedMember:
    """Download a built version's artifact and give it Search's sentence.

    `want` is the reading posted, or None for a build resumed by its id, and
    `trace_id` the trace id of the response that carried the manifest, or None
    for a cached one. The manifest's warnings and its artifact's `url` are
    checked before any request.
    """
    definition = manifest["definition"]
    spec_id = definition["spec_id"]
    content_version = manifest["content_version"]
    note_warnings(manifest, strict=strict, trace_id=trace_id)
    with describing(trace_id):
        artifact = pick_artifact(manifest, rendering)
        if artifact is None:
            raise client_error(
                CONTRACT_VIOLATION,
                f"The manifest of {spec_id} at {content_version} lists no "
                f"{mint_options(rendering)} artifact",
            )
        route = transport.origin_url(artifact["url"])
    parts = () if want is None else want.parts
    sentence = None if want is None else want.sentence or want.spec.sentence
    if want is None or spec_id != want.spec.spec_id or sentence is None:
        sentence = await _sentence(
            transport,
            manifest,
            parts,
            None if want is None else want.spec,
            deadline=deadline,
        )
    digest = artifact["artifact_digest"]
    data = cached_data
    if data is None:
        data = await _cached_download(
            transport,
            cache,
            manifest,
            rendering,
            artifact,
            route=route,
            deadline=deadline,
        )
    elif cache is not None:
        await async_offload(store, cache, manifest, rendering, digest)
    return FetchedMember(
        parts=parts,
        spec=Spec(spec_id, definition, sentence),
        sentence=sentence,
        content_version=content_version,
        manifest=manifest,
        digest=digest,
        data=data,
        answer_parts=() if want is None else want.answer_parts,
        rendering=rendering,
    )


async def _cached_download(
    transport: AsyncTransport,
    cache: Cache | None,
    manifest: Wire,
    rendering: Rendering,
    artifact: Wire,
    *,
    route: str,
    deadline: float | None,
) -> bytes:
    """An artifact's bytes from the cache, else downloaded from `route` and stored."""
    digest = artifact["artifact_digest"]
    async with holding(transport, cache, digest, deadline=deadline):
        data = None if cache is None else await async_offload(cache.get_bytes, digest)
        if data is not None:
            await async_offload(store, cache, manifest, rendering, digest)
            return data
        data = await download(
            transport, route, digest, size=artifact.get("bytes"), deadline=deadline
        )
        await async_offload(store, cache, manifest, rendering, digest, data)
        return data


def holding(
    transport: AsyncTransport,
    cache: Cache | None,
    digest: str,
    *,
    deadline: float | None,
) -> Hold | nullcontext[None]:
    """`Cache.downloading` for `digest`, waiting until `deadline`. Without a cache
    it holds nothing.

    Concurrent fetches of one artifact wait while the first reads, downloads
    and stores it, then read the stored file, so it downloads once.
    """
    if cache is None:
        return nullcontext()
    wait = None if deadline is None else deadline - transport.now()
    return cache.downloading(digest, timeout=wait)


def store(
    cache: Cache | None,
    manifest: Wire,
    rendering: Rendering,
    digest: str,
    data: bytes | None = None,
) -> None:
    if cache is None:
        return
    if data is not None:
        cache.put_bytes(digest, data)
    spec_id = manifest["definition"]["spec_id"]
    content_version = manifest["content_version"]
    stored = cache.get_manifest(spec_id, content_version, rendering)
    cached = dict(manifest)
    downloaded = [
        artifact
        for artifact in manifest["artifacts"]
        if artifact["artifact_digest"] == digest
    ]
    prior = [] if stored is None else stored.get("artifacts", [])
    cached["artifacts"] = _merge_artifacts(prior, downloaded)
    cache.put_manifest(
        spec_id,
        content_version,
        rendering,
        cached,
    )


def _merge_artifacts(prior: object, downloaded: Sequence[Wire], /) -> list[Wire]:
    """Keep same-version artifact records distinct by digest and rendering."""
    artifacts: list[Wire] = []
    if isinstance(prior, list):
        artifacts = [artifact for artifact in prior if isinstance(artifact, dict)]
    artifacts.extend(
        artifact
        for artifact in downloaded
        if not any(
            artifact["artifact_digest"] == seen.get("artifact_digest")
            and artifact["rendering"] == seen.get("rendering")
            for seen in artifacts
        )
    )
    return artifacts


def note_warnings(manifest: Wire, *, strict: bool, trace_id: str | None) -> None:
    """Issue a manifest's warn-level warnings, or raise the first under strict.

    Each warning carries `trace_id`, the trace id of the response that carried
    the manifest, or None for a cached one.
    """
    for notice in parse_notices(manifest.get("warnings")):
        if notice.severity == "info":
            continue
        warning = DataWarning(
            notice.message,
            code=notice.code,
            severity=notice.severity,
            trace_id=trace_id,
        )
        if strict:
            raise warning
        warn(warning)


async def download(
    transport: AsyncTransport,
    target: str,
    digest: str,
    *,
    params: Mapping[str, Any] | None = None,
    size: object = None,
    deadline: float | None,
) -> bytes:
    """Fetch a file through the route that redirects to it, checked on `digest`.

    The route answers 200, whose body is the file, or a 302, whose `Location`
    resolves against the route's URL and is fetched once, with a bare request on
    the storage host. A signed fetch that fails retryably, or bytes that do not
    hash to `digest`, ask the route once more for a fresh URL. Reading stops
    once the file passes `size`, the manifest's `bytes` for the artifact, or
    `DEFAULT_MAX_BYTES` when that is not a byte count.

    Raises:
        ServerError: The bytes did not hash to `digest` on either attempt
            (`digest_mismatch`), the signed fetch failed on both
            (`download_failed`), or the file passed its size
            (`response_too_large`).
        ContractError: The route answered another 2xx or 3xx
            (`unexpected_response`), a 302 with no Location, or a Location on
            neither the API's origin nor the storage host
            (`contract_violation`).
    """
    limit = (
        size
        if isinstance(size, int) and not isinstance(size, bool) and size >= 0
        else DEFAULT_MAX_BYTES
    )
    failure: DfoError | None = None
    for _ in range(2):
        response = await transport.request(
            "GET", target, params=params, deadline=deadline, max_bytes=limit
        )
        if response.status_code == 200:
            data = response.content
        elif response.status_code == 302:
            location = response.headers.get("location")
            if not location:
                raise client_error(
                    CONTRACT_VIOLATION,
                    f"GET {target} answered HTTP {response.status_code} "
                    "with no Location",
                    status=response.status_code,
                    trace_id=trace_id_of(response),
                )
            try:
                with describing(trace_id_of(response)):
                    data = await transport.download(
                        urljoin(str(response.url), location),
                        deadline=deadline,
                        max_bytes=limit,
                    )
            except DfoError as error:
                if not error.retryable:
                    raise
                failure = error
                continue
        else:
            raise client_error(
                UNEXPECTED_RESPONSE,
                f"GET {target} answered HTTP {response.status_code}; "
                "a file route answers 200 or a 302",
                status=response.status_code,
                trace_id=trace_id_of(response),
            )
        if (found := await async_offload(sha256_digest, data)) == digest:
            return data
        failure = client_error(
            DIGEST_MISMATCH, f"The file at {target} hashes to {found}, not {digest}"
        )
    assert failure is not None
    raise failure


async def _sentence(
    transport: AsyncTransport,
    manifest: Wire,
    parts: tuple[str, ...],
    held: Spec | None,
    *,
    deadline: float | None,
) -> str:
    """Search's sentence for a built identity, from resubmitting it.

    `held` is the spec the client built from, None for a resumed build. Search
    answers one definite part of the same `spec_id`, or one `no_data` part when
    the build holds no data; the manifest's warnings say why.

    Raises:
        ContractError: Search did not answer the identity with one definite part
            of the same `spec_id` and a sentence, or with one `no_data` part
            with a sentence for a manifest that counts no rows.
    """
    definition = manifest["definition"]
    spec_id = definition["spec_id"]
    response = await transport.request(
        "POST",
        "/search/resolve",
        json=resubmit_body(definition, parts[0] if parts else _UNNAMED_PART, held),
        deadline=deadline,
    )
    answer = response_json(response)
    sentence = None
    with describing(trace_id_of(response, answer)):
        if isinstance(answer, Mapping) and answer.get("kind") == RESOLUTION_KIND:
            resolved = parse_parts(answer)
            match resolved:
                case [DefinitePart(spec=found)] if found.spec_id == spec_id:
                    sentence = found.sentence
                case [NoDataPart(sentence=found)] if not counted_rows(manifest):
                    sentence = found
        if not sentence:
            raise client_error(
                CONTRACT_VIOLATION,
                f"Search did not resolve the built identity {spec_id} to itself "
                "with a sentence",
            )
    return sentence
