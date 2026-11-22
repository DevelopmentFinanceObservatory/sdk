"""Running recipes on DFO and reading the frames they store.

`run_recipe` posts a recipe's tree to `POST /datasets/analysis`. The runner
answers 200 with the format 2 ref of the frame it stored, or 202 `pending` while
a root's dataset is still building, which the client posts again after the
answer's `Retry-After`, else its `retry_after_s`, held between 1 and 60 seconds,
until the call's deadline. The 200 body's `stat_vars_summed` lists each root DFO
read as the sum of its StatVars, which the Dataset keeps as `stat_vars_summed`.
The post is idempotent: the same tree on the same roots stores nothing new. A
refusal raises as the class its code maps to, with the problem document's `fix`
on `error.problem`.

A derived frame reads in two requests, both derived from the ref member: the
manifest at `GET /datasets/derived/{ops_id}/{ocv}`, which carries the
retention, citation, recipe and the series the recipe left out, and the rows at
`.../file?format=parquet&bundle=false&layout=frame`. That file is the stored
frame's bytes, checked against the ref's artifact digest as a dataset version's
file is: bytes that hash to another digest are asked for once more, then raise
`digest_mismatch`. The cache keeps the file under its digest, so a second read
of the frame asks for the manifest alone, and concurrent reads download it once.

A recipe run with `latest=False` or `latest="stored"` posts `include:
["manifest"]`, so the 200 carries the derived manifest, and the frame reads in
two requests in all: the post, and the file at `.../files/{digest}` with the
ref member's artifact digest. `latest: "stored"` has DFO read each root at the
version its dataset's stored head names. The Dataset's `freshness` is the worst the 200's
`resolved_roots` states, and None when any entry states none this client knows
or the member is absent.

`fetch_derived` reads a derived ref. An exact read takes the frame the ref names;
when its stored frame has aged out (`artifact_expired`), DFO computes the recipe
again on the root versions the ref names, which must answer the same version,
and the client reads the frame that answer names. When its digest differs from
the ref's, the read issues a `DfoWarning` (`ref_digest_changed`). A refusal that
says the roots cannot be read again raises `VersionUnavailableError`; any other
error raises as it came. `latest=True` posts the bare derived root with `latest: true`, so DFO computes
the stored recipe again on its datasets' newest versions.
`fetch_computed_frame` reads a frame from its ids alone, as a share's slot names
it, through the bare root with `latest: false`.

Each read that left series out issues one `SeriesLeftOutWarning`, or raises it
under `strict`.

`AsyncAnalysis` holds the `client.analysis` calls, each one step of a recipe
run at once.
"""

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from typing import Any, Literal

import httpx2

from dfo._core.codes import (
    CONTRACT_VIOLATION,
    DEADLINE_EXCEEDED,
    INVALID_ARGUMENT,
    REF_DIGEST_CHANGED,
    SERIES_LEFT_OUT,
    UNEXPECTED_RESPONSE,
    VERSION_UNAVAILABLE,
)
from dfo._core.errors import (
    ContractError,
    DfoError,
    DfoWarning,
    VersionUnavailableError,
    client_error,
    client_warning,
    recast,
    warn,
)
from dfo._core.refs import DatasetRef, DerivedRefMember
from dfo._core.refusals import describing, trace_id_of
from dfo._core.timeouts import CLIENT_TIMEOUT, CallTimeout, ran_out
from dfo._core.types import FormatError
from dfo._datasets.build import (
    BUILD_READ_TIMEOUT,
    Cache,
    check_strict,
    response_json,
)
from dfo._datasets.dataset import (
    FRESHNESS,
    Dataset,
    Freshness,
    SummedReading,
    derived_dataset,
    fetch_time,
    worst_freshness,
)
from dfo._datasets.fetch import download, holding
from dfo._datasets.operation import poll_interval, still_running
from dfo._datasets.recipe import (
    Aggregation,
    Columns,
    GrowthChange,
    Pairing,
    Recipe,
    Start,
    Year,
    column_roles,
    recipe,
    stored_tree,
)
from dfo._http.hooks import async_offload
from dfo._http.transport import AsyncTransport, retry_after

ANALYSIS_PATH = "/datasets/analysis"
# The query of the derived file route that serves a frame's rows as one bare
# Parquet file in the frame layout, the only layout a derived frame has.
FRAME_FILE = {"format": "parquet", "bundle": "false", "layout": "frame"}
_EXPIRED = "artifact_expired"
# The refusals of a recomputation that mean DFO cannot read the expired frame's
# roots again, so the frame can no longer be fetched. Any other refusal of the
# recomputation, a transient one included, raises as it came.
_ROOTS_UNREADABLE = frozenset(
    {
        "snapshot_not_found",
        "artifact_expired",
        "recipe_not_found",
        "rendering_not_recorded",
    }
)


async def run_recipe(
    transport: AsyncTransport,
    target: Recipe,
    *,
    latest: bool | Literal["stored"] = False,
    strict: bool = False,
    timeout: float | None = None,
    cache: Cache | None = None,
    deadline: float | None = None,
) -> Dataset:
    """Run `target` on DFO and read the frame it stores.

    Args:
        transport: The transport requests go through.
        target: The recipe.
        latest: True reads every root at its dataset's newest version, in
            place of the versions a ref or Dataset root names. `"stored"`
            reads every root at the version its dataset's stored head names,
            with the manifest in the answer, so the run costs the post and the
            file.
        strict: Raise `SeriesLeftOutWarning` instead of issuing it.
        timeout: The longest the run takes, in seconds, the read included; None
            waits as long as the roots take to build.
        cache: The local cache, or None to fetch without one.
        deadline: The clock reading the run ends by, when an earlier step of the
            same call set it from `timeout`. None sets it from `timeout` here.

    Raises:
        InvalidRequestError: The recipe has no step and starts from a dataset
            version or a spec (`invalid_argument`), or DFO refused the tree.
        DfoTimeoutError: `timeout` passed while a root was still building
            (`deadline_exceeded`).
        ContractError: DFO answered a ref or manifest this client cannot read
            (`contract_violation`), or a file that is not Parquet
            (`unexpected_response`).
        ServerError: The file did not hash to the ref's digest on either
            attempt (`digest_mismatch`).
    """
    check_strict(strict)
    tree = stored_tree(target) if latest == "stored" else target.tree()
    if deadline is None:
        deadline = transport.deadline(timeout)
    answer = await _analyse(
        transport, _body(tree, latest), deadline=deadline, timeout=timeout
    )
    return await _read(transport, answer, strict=strict, cache=cache, chain=target)


async def fetch_derived(
    transport: AsyncTransport,
    ref: DatasetRef,
    *,
    latest: bool | Literal["stored"] = False,
    strict: bool = False,
    timeout: float | None = None,
    cache: Cache | None = None,
) -> Dataset:
    """The derived frame a ref names, or with `latest=True` its recipe computed
    again on its datasets' newest versions, or with `latest="stored"` on the
    versions their stored heads name.

    Raises:
        InvalidRequestError: The ref holds several derived members, which one
            read cannot stack (`invalid_argument`).
        VersionUnavailableError: The frame has aged out and DFO cannot read its
            roots again (`snapshot_not_found`, `artifact_expired`,
            `recipe_not_found` or `rendering_not_recorded`), or computed
            another version on them.
    """
    check_strict(strict)
    member = _one_member(ref, transport.caller)
    deadline = transport.deadline(timeout)
    root = {"spec_id": member.spec.spec_id, "content_version": member.content_version}
    if latest:
        answer = await _analyse(
            transport, _body(root, latest), deadline=deadline, timeout=timeout
        )
        return await _read(transport, answer, strict=strict, cache=cache)
    try:
        return await _read(
            transport,
            _Answer(member, deadline=deadline),
            strict=strict,
            cache=cache,
        )
    except DfoError as error:
        if error.code != _EXPIRED:
            raise
        expired = error
    try:
        answer = await _analyse(
            transport,
            {"tree": root, "latest": False},
            deadline=deadline,
            timeout=timeout,
        )
    except DfoError as error:
        if error.code not in _ROOTS_UNREADABLE:
            raise
        raise _unavailable(member, error, transport.caller) from error
    again = answer.member
    if again.content_version != member.content_version:
        raise _unavailable(member, expired, transport.caller)
    if again.digest != member.digest:
        warn(_digest_changed(member, again.digest))
    return await _read(transport, answer, strict=strict, cache=cache)


async def fetch_computed_frame(
    transport: AsyncTransport,
    spec_id: str,
    content_version: str,
    *,
    strict: bool = False,
    deadline: float | None,
    timeout: float | None,
    cache: Cache | None = None,
) -> Dataset:
    """The frame DFO computed that `spec_id` and `content_version` name, read
    through its bare root, which answers the frame's ref member, by the clock
    reading `deadline`, which `timeout` set.

    DFO answers the stored frame, or computes its recipe again on the versions
    it read when the stored frame has aged out.

    Raises:
        DfoTimeoutError: The deadline passed while a root was building
            (`deadline_exceeded`).
        VersionUnavailableError: DFO computed another version on the versions
            the recipe read, so this one can no longer be fetched.
        ContractError: DFO answered a ref this client cannot read
            (`contract_violation`).
    """
    check_strict(strict)
    answer = await _analyse(
        transport,
        {
            "tree": {"spec_id": spec_id, "content_version": content_version},
            "latest": False,
        },
        deadline=deadline,
        timeout=timeout,
    )
    member = answer.member
    if member.content_version != content_version:
        raise client_error(
            VERSION_UNAVAILABLE,
            f"{spec_id} at {content_version} can no longer be fetched, and DFO "
            f"computed {member.content_version} on the versions it read",
        )
    return await _read(transport, answer, strict=strict, cache=cache)


def _one_member(ref: DatasetRef, caller: str) -> DerivedRefMember:
    first, *others = ref.members
    if others or not isinstance(first, DerivedRefMember):
        raise client_error(
            INVALID_ARGUMENT,
            f"The DatasetRef names {len(ref.members)} frames DFO computed, and one "
            f"fetch reads one; fetch each with {caller}.fetch("
            "DatasetRef((ref.members[0],)))",
        )
    return first


def _unavailable(
    member: DerivedRefMember, refusal: DfoError, caller: str
) -> VersionUnavailableError:
    error = recast(
        refusal,
        VersionUnavailableError,
        message=(
            f"{member.spec.spec_id} at {member.content_version} can no longer be "
            "fetched, and DFO cannot compute it again on the versions it read. "
            f"For the newest version: {caller}.fetch(ref, latest=True)"
        ),
        retryable=False,
        retry_after=None,
    )
    error.newest_version = None
    return error


def _digest_changed(member: DerivedRefMember, digest: str) -> DfoWarning:
    """The warning that DFO computed the ref's frame again with another digest.

    The recomputation answered the ref's version, so the rows are the frame the
    ref names, written to bytes with another digest.
    """
    return client_warning(
        REF_DIGEST_CHANGED,
        f"{member.spec.spec_id} at {member.content_version} was computed again as "
        f"{digest}, not the ref's {member.digest}; the version is the same, and "
        "dataset.ref names the new file",
    )


@dataclass(frozen=True)
class _Answer:
    """What a ready analysis answer gives the frame read: the ref's derived
    member, the roots DFO summed, the freshness `resolved_roots` states, the
    embedded manifest when the post asked for it, the trace id of the response
    that carried them, and the clock reading the read ends by."""

    member: DerivedRefMember
    summed: tuple[SummedReading, ...] = ()
    freshness: Freshness | None = None
    manifest: Mapping[str, Any] | None = None
    trace_id: str | None = None
    deadline: float | None = None


def _body(tree: Mapping[str, Any], latest: bool | Literal["stored"]) -> dict[str, Any]:
    """The analysis post of `tree`. Under `latest=False` and `latest="stored"`
    it asks for the manifest, so the read takes the derived facts from the
    answer and the file from the digest route; `latest=True` posts as before."""
    if latest is True:
        return {"tree": tree, "latest": True}
    return {"tree": tree, "latest": latest, "include": ["manifest"]}


async def _analyse(
    transport: AsyncTransport,
    body: Mapping[str, Any],
    *,
    deadline: float | None,
    timeout: float | None,
) -> _Answer:
    """Post a recipe tree until DFO answers its stored frame's ref member, the
    roots it read as the sum of their StatVars, and, when `body` asks for them,
    the freshness of the stored heads it read and the derived manifest.

    Raises:
        DfoTimeoutError: The deadline passed while a root was building
            (`deadline_exceeded`).
        ContractError: DFO answered another status than 200 or 202
            (`unexpected_response`), or a ref, `stat_vars_summed` or embedded
            `manifest` this client cannot read (`contract_violation`).
    """
    included = body.get("include") or ()
    with still_running(transport, deadline, timeout):
        while True:
            response = await transport.request(
                "POST",
                ANALYSIS_PATH,
                json=body,
                timeout=BUILD_READ_TIMEOUT,
                deadline=deadline,
            )
            answer = response_json(response)
            trace_id = trace_id_of(response, answer)
            if response.status_code == 200:
                with describing(trace_id):
                    member = _ready_member(answer)
                    return _Answer(
                        member,
                        _summed(answer),
                        freshness=_resolved_freshness(answer),
                        manifest=(
                            _embedded_manifest(answer, member)
                            if "manifest" in included
                            else None
                        ),
                        trace_id=trace_id,
                        deadline=deadline,
                    )
            if response.status_code != 202:
                raise client_error(
                    UNEXPECTED_RESPONSE,
                    f"POST {ANALYSIS_PATH} answered HTTP {response.status_code}; "
                    "an analysis answers 200 or 202",
                    status=response.status_code,
                    trace_id=trace_id,
                )
            wait = poll_interval(_pending_wait(response, answer))
            if deadline is not None and transport.now() + wait >= deadline:
                raise client_error(
                    DEADLINE_EXCEEDED,
                    "DFO is still building the data the recipe reads"
                    f"{ran_out(timeout)}. "
                    "The same fetch joins those builds.",
                    trace_id=trace_id,
                )
            await transport.sleep(wait)


def _pending_wait(response: httpx2.Response, answer: object) -> float:
    """The wait a pending answer asks for: its `Retry-After`, else its
    `retry_after_s`, else none."""
    header = retry_after(response)
    if header is not None:
        return header
    seconds = answer.get("retry_after_s") if isinstance(answer, Mapping) else None
    if isinstance(seconds, int | float) and not isinstance(seconds, bool):
        return float(seconds)
    return 0.0


def _ready_member(answer: object) -> DerivedRefMember:
    """The derived member of a ready analysis answer's ref.

    Raises:
        ContractError: The answer holds no format 2 ref of one derived member
            (`contract_violation`).
    """
    ref = answer.get("ref") if isinstance(answer, Mapping) else None
    try:
        members = DatasetRef.from_json(json.dumps(ref)).members
    except (FormatError, TypeError) as error:
        pointer = "/ref" + (error.pointer if isinstance(error, FormatError) else "")
        raise _violation(pointer) from error
    match members:
        case [DerivedRefMember() as member]:
            return member
        case _:
            raise _violation("/ref/members")


def _summed(answer: object) -> tuple[SummedReading, ...]:
    """The roots a ready answer read as the sum of their StatVars, from its
    `stat_vars_summed`, or none when the answer leaves it out.

    Raises:
        ContractError: `stat_vars_summed` is not a list of `{spec_id,
            content_version, count}` with `count` at least 2
            (`contract_violation`), at the pointer of the field it breaks.
    """
    listed = answer.get("stat_vars_summed") if isinstance(answer, Mapping) else None
    if listed is None:
        return ()
    if not isinstance(listed, list):
        raise _violation("/stat_vars_summed", what="a body")
    summed = []
    for index, entry in enumerate(listed):
        pointer = f"/stat_vars_summed/{index}"
        if not isinstance(entry, Mapping):
            raise _violation(pointer, what="a body")
        spec_id, version = entry.get("spec_id"), entry.get("content_version")
        count = entry.get("count")
        if not isinstance(spec_id, str):
            raise _violation(f"{pointer}/spec_id", what="a body")
        if not isinstance(version, str):
            raise _violation(f"{pointer}/content_version", what="a body")
        # DFO sums a reading of two StatVars or more. A bool is no count.
        if isinstance(count, bool) or not isinstance(count, int) or count < 2:
            raise _violation(f"{pointer}/count", what="a body")
        summed.append(SummedReading(spec_id, version, count))
    return tuple(summed)


def _resolved_freshness(answer: object) -> Freshness | None:
    """The worst freshness a stored answer's `resolved_roots` states, or None
    when the member is absent or not a list, or any entry states none this
    client knows."""
    listed = answer.get("resolved_roots") if isinstance(answer, Mapping) else None
    if not isinstance(listed, list) or not listed:
        return None
    stated: list[Freshness | None] = []
    for entry in listed:
        value = entry.get("freshness") if isinstance(entry, Mapping) else None
        stated.append(next((known for known in FRESHNESS if known == value), None))
    return worst_freshness(stated)


def _embedded_manifest(answer: object, member: DerivedRefMember) -> Mapping[str, Any]:
    """The derived manifest a 200 embeds for `member`'s pair.

    Raises:
        ContractError: The member is absent or not an object, names another
            pair than `member`, or holds a `left_out` that is neither a list
            nor null (`contract_violation`), at the pointer it breaks.
    """
    manifest = answer.get("manifest") if isinstance(answer, Mapping) else None
    if not isinstance(manifest, Mapping):
        raise _violation("/manifest", what="a body")
    for key, expected in (
        ("spec_id", member.spec.spec_id),
        ("content_version", member.content_version),
    ):
        if manifest.get(key) != expected:
            raise _violation(f"/manifest/{key}", what="a body")
    left_out = manifest.get("left_out")
    if left_out is not None and not isinstance(left_out, list):
        raise _violation("/manifest/left_out", what="a body")
    return manifest


def _violation(pointer: str, *, what: str = "a ref") -> ContractError:
    error = client_error(
        CONTRACT_VIOLATION,
        f"POST {ANALYSIS_PATH} answered {what} whose {pointer} this client cannot read",
    )
    error.pointer = pointer
    return error


async def _read(
    transport: AsyncTransport,
    answer: _Answer,
    *,
    strict: bool,
    cache: Cache | None,
    chain: Recipe | None = None,
) -> Dataset:
    """The derived frame `answer.member` names, from its manifest and its file,
    which `cache` holds under its digest once read. The manifest is the one the
    answer embeds, else the derived manifest route's, and the file comes from
    the digest route with the one, else from the frame file route. The Dataset
    names each column by the role word `chain`, the recipe that made it, named
    it by, and keeps the roots the analysis summed and the freshness it
    stated."""
    member, deadline = answer.member, answer.deadline
    path = f"/datasets/derived/{member.spec.spec_id}/{member.content_version}"
    digest = member.digest
    manifest, trace_id = answer.manifest, answer.trace_id
    file_route, file_query = f"{path}/files/{digest}", None
    if manifest is None:
        response = await transport.request("GET", path, deadline=deadline)
        manifest = response_json(response)
        trace_id = trace_id_of(response, manifest)
        if not isinstance(manifest, Mapping):
            raise client_error(
                CONTRACT_VIOLATION,
                f"GET {path} answered a manifest that is not an object",
                trace_id=trace_id,
            )
        file_route, file_query = f"{path}/file", FRAME_FILE
    async with holding(transport, cache, digest, deadline=deadline):
        data = None if cache is None else await async_offload(cache.get_bytes, digest)
        from_cache = cache is not None and data is not None
        if from_cache:
            fetched_at = await async_offload(cache.fetched_at, digest)
        else:
            data = await download(
                transport, file_route, digest, params=file_query, deadline=deadline
            )
            fetched_at = fetch_time()
            if cache is not None:
                await async_offload(
                    cache.put_bytes, digest, data, fetched_at=fetched_at
                )
    recipe_object = manifest.get("recipe")
    tree = recipe_object.get("tree") if isinstance(recipe_object, Mapping) else None
    roles = (
        column_roles(chain, tree)
        if chain is not None and isinstance(tree, Mapping)
        else None
    )
    with describing(trace_id):
        dataset = await async_offload(
            derived_dataset,
            member,
            manifest,
            data,
            cache=cache,
            caller=transport.caller,
            roles=roles,
            fetched_at=fetched_at,
            from_cache=from_cache,
            stat_vars_summed=answer.summed,
        )
    if answer.freshness is not None:
        dataset = replace(dataset, freshness=answer.freshness)
    if dataset.left_out or not dataset._left_out_complete:
        _left_out(dataset, strict=strict)
    return dataset


def _left_out(dataset: Dataset, *, strict: bool) -> None:
    """Issue the one warning that the recipe dropped series, or raise it. The
    list can be empty when DFO says it is incomplete."""
    count = len(dataset.left_out)
    if count == 0:
        text = "Series were left out for missing data, and the Dataset's left_out lists none"
    else:
        least = "" if dataset._left_out_complete else "at least "
        steps = ", ".join(
            dict.fromkeys(series.step.verb for series in dataset.left_out)
        )
        text = (
            f"{least}{count:,} series left out for missing data by {steps}; the "
            "Dataset's left_out lists each with its step and reason"
        )
    warning = client_warning(SERIES_LEFT_OUT, text)
    if strict:
        raise warning
    warn(warning)


class AsyncAnalysis:
    """DFO's operations, each run at once on DFO as a recipe of one step.

    Each call takes a `Spec`, `DatasetRef`, `Dataset` or `Recipe` and returns a
    derived `Dataset`; `dfo.analysis.recipe` describes a longer chain to fetch
    in one request. Each takes `strict` and `timeout` as `fetch` does: `strict`
    raises the `SeriesLeftOutWarning` instead of issuing it, and `timeout` is
    the longest the call takes, in seconds, the read included, while None waits
    as long as the readings take to build. Left out, `timeout` is the client's.
    """

    def __init__(self, transport: AsyncTransport, cache: Cache | None = None) -> None:
        """Run through `transport`, reading frames through `cache`."""
        self._transport = transport
        self._cache = cache

    def __repr__(self) -> str:
        return (
            f"<{type(self).__name__}: filter, aggregate, growth, rank, quotient_of, "
            "share_of, join, sum_of, compare>"
        )

    async def _run(
        self, chain: Recipe, *, strict: bool, timeout: CallTimeout
    ) -> Dataset:
        return await run_recipe(
            self._transport,
            chain,
            strict=strict,
            timeout=self._transport.call_timeout(timeout),
            cache=self._cache,
        )

    async def filter(
        self,
        data: Start,
        /,
        *,
        keep: Mapping[str, str | Sequence[str]],
        strict: bool = False,
        timeout: CallTimeout = CLIENT_TIMEOUT,
    ) -> Dataset:
        """Keep the rows whose role or column holds one of the values, as
        `keep={"destination": ["country/KEN"]}`.

        Raises:
            InvalidRequestError: `keep` is malformed, and no request is sent
                (`invalid_argument`); or DFO refused the step.
            DfoTimeoutError: `timeout` passed (`deadline_exceeded`).
        """
        chain = recipe(data).filter(keep=keep)
        return await self._run(chain, strict=strict, timeout=timeout)

    async def aggregate(
        self,
        data: Start,
        /,
        *,
        by: Columns = (),
        how: Aggregation = "sum",
        allow_sparse_breakdowns: bool = False,
        strict: bool = False,
        timeout: CallTimeout = CLIENT_TIMEOUT,
    ) -> Dataset:
        """Totals or averages the rows of each year, keeping the members of `by`
        apart.

        Args:
            data: The reading.
            by: The roles whose members stay apart, such as `"origin"`; none
                totals every row of each year.
            how: `sum`, `mean`, `max` or `min`.
            allow_sparse_breakdowns: Count a group as present when any of its
                breakdown cells, such as `crsPurpose`, holds a row.
            strict: Raise the `SeriesLeftOutWarning` instead of issuing it.
            timeout: The longest the call takes, in seconds. None waits. Left
                out, the client's `timeout` applies.
        """
        chain = recipe(data).aggregate(
            by=by, how=how, allow_sparse_breakdowns=allow_sparse_breakdowns
        )
        return await self._run(chain, strict=strict, timeout=timeout)

    async def growth(
        self,
        data: Start,
        /,
        *,
        by: Columns = (),
        window: tuple[Year, Year],
        change: GrowthChange = "relative",
        strict: bool = False,
        timeout: CallTimeout = CLIENT_TIMEOUT,
    ) -> Dataset:
        """Change from the first to the last year of `window`, for each member of
        `by`: with `relative`, the change divided by the first year's value, a
        fraction where 0.25 is a 25% rise; with `difference`, the last year's
        value minus the first's, in the data's unit."""
        chain = recipe(data).growth(by=by, window=window, change=change)
        return await self._run(chain, strict=strict, timeout=timeout)

    async def rank(
        self,
        data: Start,
        /,
        *,
        by: Columns,
        per: Columns | None = None,
        window: tuple[Year, Year] | None = None,
        how: Aggregation | None = None,
        limit: int | None = None,
        allow_sparse_breakdowns: bool = False,
        strict: bool = False,
        timeout: CallTimeout = CLIENT_TIMEOUT,
    ) -> Dataset:
        """Order the members of `by`, largest first, and keep the top `limit`.

        Args:
            data: The reading.
            by: The roles whose members are ranked.
            per: The roles that split the ranking, such as `"destination"`,
                each group ranked on its own with its own `limit`.
            window: The years ranked over, such as
                `(latest_year(), latest_year())`; None ranks every year.
            how: How each member's rows reduce to one value first.
            limit: The most members kept, from 1 to 1000, in each group.
            allow_sparse_breakdowns: Count a member as present in a year when
                any of its breakdown cells holds a row.
            strict: Raise the `SeriesLeftOutWarning` instead of issuing it.
            timeout: The longest the call takes, in seconds. None waits. Left
                out, the client's `timeout` applies.
        """
        chain = recipe(data).rank(
            by=by,
            per=per,
            window=window,
            how=how,
            limit=limit,
            allow_sparse_breakdowns=allow_sparse_breakdowns,
        )
        return await self._run(chain, strict=strict, timeout=timeout)

    async def quotient_of(
        self,
        data: Start,
        other: Start,
        /,
        *,
        on: Pairing | None = None,
        strict: bool = False,
        timeout: CallTimeout = CLIENT_TIMEOUT,
    ) -> Dataset:
        """Divide one reading by another, pairing roles through `on`, such as
        aid per person with `on={"destination": "place"}`."""
        chain = recipe(data).quotient_of(other, on=on)
        return await self._run(chain, strict=strict, timeout=timeout)

    async def share_of(
        self,
        data: Start,
        total: Start | None = None,
        /,
        *,
        by: Columns | None = None,
        on: Pairing | None = None,
        strict: bool = False,
        timeout: CallTimeout = CLIENT_TIMEOUT,
    ) -> Dataset:
        """Each value as a percentage of the matching row of `total`, from 0 to
        100 when each value is part of its total, so 25.0 is a quarter; or of
        the total across all members of `by` in the same year."""
        chain = recipe(data).share_of(total, by=by, on=on)
        return await self._run(chain, strict=strict, timeout=timeout)

    async def join(
        self,
        data: Start,
        other: Start,
        /,
        *,
        on: Pairing | None = None,
        strict: bool = False,
        timeout: CallTimeout = CLIENT_TIMEOUT,
    ) -> Dataset:
        """Both readings' matched rows in long format, told apart by
        `stat_var`."""
        chain = recipe(data).join(other, on=on)
        return await self._run(chain, strict=strict, timeout=timeout)

    async def sum_of(
        self,
        data: Start,
        other: Start,
        /,
        *,
        on: Pairing | None = None,
        strict: bool = False,
        timeout: CallTimeout = CLIENT_TIMEOUT,
    ) -> Dataset:
        """The matching rows of two readings added over the years both hold."""
        chain = recipe(data).sum_of(other, on=on)
        return await self._run(chain, strict=strict, timeout=timeout)

    async def compare(
        self,
        data: Start,
        other: Start,
        /,
        *,
        on: Pairing | None = None,
        strict: bool = False,
        timeout: CallTimeout = CLIENT_TIMEOUT,
    ) -> Dataset:
        """`data` minus `other` for each matching member over the years both
        hold. DFO refuses two different units."""
        chain = recipe(data).compare(other, on=on)
        return await self._run(chain, strict=strict, timeout=timeout)
