"""Running recipes on DFO and reading the frames they store.

`run_recipe` posts a recipe's tree to `POST /datasets/analysis`. The runner
answers 200 with the format 2 ref of the frame it stored, or 202 `pending` while
a root's dataset is still building, which the client posts again after the
answer's `Retry-After`, else its `retry_after_s`, held between 1 and 60 seconds,
until the call's deadline. The post is idempotent: the same tree on the same
roots stores nothing new. A refusal raises as the class its code maps to, with
the problem document's `fix` on `error.problem`.

A derived frame reads in two requests, both derived from the ref member: the
manifest at `GET /datasets/derived/{ops_id}/{ocv}`, which carries the
retention, citation, recipe and the series the recipe left out, and the rows at
`.../file?format=parquet&bundle=false&layout=frame`. That file is the stored
frame's bytes, checked against the ref's artifact digest as a dataset version's
file is: bytes that hash to another digest are asked for once more, then raise
`digest_mismatch`. The cache keeps the file under its digest, so a second read
of the frame asks for the manifest alone, and concurrent reads download it once.

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
from typing import Any

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
from dfo._core.types import FormatError
from dfo._datasets.build import (
    BUILD_READ_TIMEOUT,
    Cache,
    check_strict,
    response_json,
)
from dfo._datasets.dataset import Dataset, derived_dataset
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
    latest: bool = False,
    strict: bool = False,
    timeout: float | None = None,
    cache: Cache | None = None,
) -> Dataset:
    """Run `target` on DFO and read the frame it stores.

    Args:
        transport: The transport requests go through.
        target: The recipe.
        latest: Read every root at its dataset's newest version, in place of
            the versions a ref or Dataset root names.
        strict: Raise `SeriesLeftOutWarning` instead of issuing it.
        timeout: The longest the run takes, in seconds, the read included; None
            waits as long as the roots take to build.
        cache: The local cache, or None to fetch without one.

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
    tree = target.tree()
    deadline = transport.deadline(timeout)
    member = await _analyse(
        transport, {"tree": tree, "latest": latest}, deadline=deadline, timeout=timeout
    )
    return await _read(
        transport,
        member,
        strict=strict,
        deadline=deadline,
        cache=cache,
        chain=target,
    )


async def fetch_derived(
    transport: AsyncTransport,
    ref: DatasetRef,
    *,
    latest: bool = False,
    strict: bool = False,
    timeout: float | None = None,
    cache: Cache | None = None,
) -> Dataset:
    """The derived frame a ref names, or with `latest=True` its recipe computed
    again on its datasets' newest versions.

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
        member = await _analyse(
            transport,
            {"tree": root, "latest": True},
            deadline=deadline,
            timeout=timeout,
        )
        return await _read(
            transport, member, strict=strict, deadline=deadline, cache=cache
        )
    try:
        return await _read(
            transport, member, strict=strict, deadline=deadline, cache=cache
        )
    except DfoError as error:
        if error.code != _EXPIRED:
            raise
        expired = error
    try:
        again = await _analyse(
            transport,
            {"tree": root, "latest": False},
            deadline=deadline,
            timeout=timeout,
        )
    except DfoError as error:
        if error.code not in _ROOTS_UNREADABLE:
            raise
        raise _unavailable(member, error, transport.caller) from error
    if again.content_version != member.content_version:
        raise _unavailable(member, expired, transport.caller)
    if again.digest != member.digest:
        warn(_digest_changed(member, again.digest))
    return await _read(transport, again, strict=strict, deadline=deadline, cache=cache)


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
    member = await _analyse(
        transport,
        {
            "tree": {"spec_id": spec_id, "content_version": content_version},
            "latest": False,
        },
        deadline=deadline,
        timeout=timeout,
    )
    if member.content_version != content_version:
        raise client_error(
            VERSION_UNAVAILABLE,
            f"{spec_id} at {content_version} can no longer be fetched, and DFO "
            f"computed {member.content_version} on the versions it read",
        )
    return await _read(transport, member, strict=strict, deadline=deadline, cache=cache)


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


async def _analyse(
    transport: AsyncTransport,
    body: Mapping[str, Any],
    *,
    deadline: float | None,
    timeout: float | None,
) -> DerivedRefMember:
    """Post a recipe tree until DFO answers its stored frame's ref member.

    Raises:
        DfoTimeoutError: The deadline passed while a root was building
            (`deadline_exceeded`).
        ContractError: DFO answered another status than 200 or 202
            (`unexpected_response`), or a ref this client cannot read
            (`contract_violation`).
    """
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
                    return _ready_member(answer)
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
                after = "" if timeout is None else f" after {timeout:g} s"
                raise client_error(
                    DEADLINE_EXCEEDED,
                    f"DFO is still building the data the recipe reads{after}. "
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


def _violation(pointer: str) -> ContractError:
    error = client_error(
        CONTRACT_VIOLATION,
        f"POST {ANALYSIS_PATH} answered a ref whose {pointer} this client cannot read",
    )
    error.pointer = pointer
    return error


async def _read(
    transport: AsyncTransport,
    member: DerivedRefMember,
    *,
    strict: bool,
    deadline: float | None,
    cache: Cache | None,
    chain: Recipe | None = None,
) -> Dataset:
    """The derived frame `member` names, from its manifest and its file, which
    `cache` holds under its digest once read. The Dataset names each column by
    the role word `chain`, the recipe that made it, named it by."""
    path = f"/datasets/derived/{member.spec.spec_id}/{member.content_version}"
    response = await transport.request("GET", path, deadline=deadline)
    manifest = response_json(response)
    trace_id = trace_id_of(response, manifest)
    if not isinstance(manifest, Mapping):
        raise client_error(
            CONTRACT_VIOLATION,
            f"GET {path} answered a manifest that is not an object",
            trace_id=trace_id,
        )
    digest = member.digest
    async with holding(transport, cache, digest, deadline=deadline):
        data = None if cache is None else await async_offload(cache.get_bytes, digest)
        if data is None:
            data = await download(
                transport, f"{path}/file", digest, params=FRAME_FILE, deadline=deadline
            )
            if cache is not None:
                await async_offload(cache.put_bytes, digest, data)
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
        )
    if dataset.left_out:
        _left_out(dataset, strict=strict)
    return dataset


def _left_out(dataset: Dataset, *, strict: bool) -> None:
    """Issue the one warning that the recipe dropped series, or raise it."""
    count = len(dataset.left_out)
    least = "" if dataset._left_out_complete else "at least "
    steps = ", ".join(dict.fromkeys(series.step.verb for series in dataset.left_out))
    warning = client_warning(
        SERIES_LEFT_OUT,
        f"{least}{count:,} series left out for missing data by {steps}; the "
        "Dataset's left_out lists each with its step and reason",
    )
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
    as long as the readings take to build.
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
        self, chain: Recipe, *, strict: bool, timeout: float | None
    ) -> Dataset:
        return await run_recipe(
            self._transport, chain, strict=strict, timeout=timeout, cache=self._cache
        )

    async def filter(
        self,
        data: Start,
        /,
        *,
        keep: Mapping[str, str | Sequence[str]],
        strict: bool = False,
        timeout: float | None = None,
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
        strict: bool = False,
        timeout: float | None = None,
    ) -> Dataset:
        """Totals or averages the rows of each year, keeping the members of `by`
        apart.

        Args:
            data: The reading.
            by: The roles whose members stay apart, such as `"origin"`; none
                totals every row of each year.
            how: `sum`, `mean`, `max` or `min`.
            strict: Raise the `SeriesLeftOutWarning` instead of issuing it.
            timeout: The longest the call takes, in seconds; None waits.
        """
        chain = recipe(data).aggregate(by=by, how=how)
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
        timeout: float | None = None,
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
        window: tuple[Year, Year] | None = None,
        how: Aggregation | None = None,
        limit: int | None = None,
        strict: bool = False,
        timeout: float | None = None,
    ) -> Dataset:
        """Order the members of `by`, largest first, and keep the top `limit`.

        Args:
            data: The reading.
            by: The roles whose members are ranked.
            window: The years ranked over, such as
                `(latest_year(), latest_year())`; None ranks every year.
            how: How each member's rows reduce to one value first.
            limit: The most members kept, from 1 to 1000.
            strict: Raise the `SeriesLeftOutWarning` instead of issuing it.
            timeout: The longest the call takes, in seconds; None waits.
        """
        chain = recipe(data).rank(by=by, window=window, how=how, limit=limit)
        return await self._run(chain, strict=strict, timeout=timeout)

    async def quotient_of(
        self,
        data: Start,
        other: Start,
        /,
        *,
        on: Pairing | None = None,
        strict: bool = False,
        timeout: float | None = None,
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
        timeout: float | None = None,
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
        timeout: float | None = None,
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
        timeout: float | None = None,
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
        timeout: float | None = None,
    ) -> Dataset:
        """`data` minus `other` for each matching member over the years both
        hold. DFO refuses two different units."""
        chain = recipe(data).compare(other, on=on)
        return await self._run(chain, strict=strict, timeout=timeout)
