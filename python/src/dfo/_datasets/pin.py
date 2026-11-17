"""Pinning: keeping a Dataset's exact versions fetchable with no time limit.

`pin` posts each member's artifact digest to
`POST /datasets/{spec_id}/{content_version}/pin`, `{schema_version: 1,
artifact_digest}`, one member after another. DFO keeps the artifact and a frame
that serves its version in the pinned tier, so every format of the version stays
fetchable by its ref. Pinning cannot be undone, and each new pin counts against a
daily allowance per caller, which answers 429 `allowance_exhausted` once spent.
A call that fails part-way leaves the members before the failing one pinned, and
its error names their versions in `pinned` and in its message.

The pin route takes dataset versions alone, so a derived Dataset, whose members
name `ops_` frames, is refused before any request.

`file_url` gives a pinned member's file as a link a pipeline can commit and read
with any HTTP client: the file selector, `GET
/datasets/{spec_id}/{content_version}/file`, under the client's base URL, with
the query of the rendering the member was built in, so it serves the same
table. It reads the version's manifest first and refuses a version that is not
pinned, since DFO holds an unpinned version for 30 days and a committed link to
it breaks after that.
"""

from collections.abc import Mapping
from dataclasses import replace

import httpx2

from dfo._core.codes import CONTRACT_VIOLATION, INVALID_ARGUMENT, VERSION_NOT_PINNED
from dfo._core.errors import DfoError, client_error, with_hint
from dfo._core.refs import (
    DerivedMember,
    DerivedRefMember,
    Member,
    RefMember,
)
from dfo._core.refusals import trace_id_of
from dfo._datasets.build import file_params, read_held_until, response_json
from dfo._datasets.dataset import Dataset, day_text
from dfo._datasets.resolve import selector_path, stored_manifest
from dfo._http.transport import AsyncTransport


async def pin(transport: AsyncTransport, data: Dataset) -> Dataset:
    """Keep `data`'s versions fetchable with no time limit, and return it pinned.

    Raises:
        InvalidRequestError: `data` is not a Dataset, names no version, or holds
            frames DFO computed (`invalid_argument`); no request is sent.
        QuotaExceededError: The caller's daily pin allowance is spent
            (`allowance_exhausted`).
        ContractError: DFO answered for another version or artifact
            (`contract_violation`).
        DfoError: Whatever the failing pin raised, with `pinned` naming the
            versions pinned before it, which stay pinned.
    """
    members = _dataset_members(data, transport.caller)
    deadline = transport.deadline(transport.timeout)
    for index, member in enumerate(members):
        try:
            await _pin_member(transport, member, deadline=deadline)
        except DfoError as error:
            if index == 0:
                raise
            raise _part_way(error, members[:index]) from error
    return replace(
        data,
        members=tuple(
            replace(member, pinned=True, held_until=None) for member in data.members
        ),
    )


def _part_way(error: DfoError, pinned: tuple[Member, ...]) -> DfoError:
    """`error`, naming the members a pin pinned before it failed."""
    named = ", ".join(f"{m.spec.spec_id} at {m.content_version}" for m in pinned)
    hinted = with_hint(error, f"Pinned before it failed, and still pinned: {named}.")
    hinted.pinned = tuple(member.content_version for member in pinned)
    return hinted


def _dataset_members(data: object, caller: str) -> tuple[Member, ...]:
    if not isinstance(data, Dataset):
        raise client_error(
            INVALID_ARGUMENT,
            f"pin takes a Dataset, such as {caller}.fetch(spec), not "
            f"{type(data).__name__}",
        )
    if not data.members:
        raise client_error(
            INVALID_ARGUMENT,
            "A website bundle opened from a folder names no version to pin; fetch "
            "the dataset, then pin it",
        )
    derived = next((m for m in data.members if isinstance(m, DerivedMember)), None)
    if derived is not None:
        raise client_error(
            INVALID_ARGUMENT,
            f"pin keeps dataset versions, and {derived.spec.spec_id} at "
            f"{derived.content_version} is a frame DFO computed, which the pin route "
            "does not take. data.save(path) keeps its rows, and "
            f"{caller}.fetch(data.ref, latest=True) computes it again",
        )
    return tuple(member for member in data.members if isinstance(member, Member))


async def _pin_member(
    transport: AsyncTransport, member: Member, *, deadline: float | None
) -> None:
    """Pin one member's artifact by `deadline`, the clock reading the client's
    `timeout` sets for the whole pin.

    Raises:
        ContractError: The answer names another version or artifact
            (`contract_violation`).
    """
    path = f"/datasets/{member.spec.spec_id}/{member.content_version}/pin"
    response = await transport.request(
        "POST",
        path,
        json={"schema_version": 1, "artifact_digest": member.digest},
        deadline=deadline,
    )
    body = response_json(response)
    pinned = body.get("pinned") if isinstance(body, Mapping) else None
    named = (
        (pinned.get("content_version"), pinned.get("artifact_digest"))
        if isinstance(pinned, Mapping)
        else None
    )
    if named != (member.content_version, member.digest):
        raise client_error(
            CONTRACT_VIOLATION,
            f"POST {path} answered no pin of {member.content_version} at "
            f"{member.digest}",
            trace_id=trace_id_of(response, body),
        )


async def file_url(transport: AsyncTransport, member: object) -> str:
    """The URL of a pinned member's file, in the rendering it was built in.

    Raises:
        VersionNotPinnedError: The version is not pinned (`version_not_pinned`),
            with `held_until` naming the date DFO stops guaranteeing it.
        InvalidRequestError: `member` is not a Member or RefMember, or names a
            frame DFO computed (`invalid_argument`), and no request is sent.
        DfoError: Whatever reading the version's manifest raised, such as
            `NotFoundError` for a version DFO never stored.
    """
    reading = _reading(member, transport.caller)
    spec_id, content_version = reading.spec.spec_id, reading.content_version
    manifest, trace_id = await stored_manifest(
        transport,
        spec_id,
        content_version,
        deadline=transport.deadline(transport.timeout),
    )
    retention = manifest.get("retention")
    if not isinstance(retention, Mapping):
        retention = {}
    if retention.get("pinned") is not True:
        held_until = read_held_until(retention.get("held_until"))
        held = f", held until {day_text(held_until)}" if held_until else ""
        error = client_error(
            VERSION_NOT_PINNED,
            f"{spec_id} at {content_version} is not pinned{held}, so a link to "
            "it stops working once DFO drops the version. Pin the Dataset the "
            f"member came from with {transport.caller}.pin(data), then ask for "
            "the link again",
            trace_id=trace_id,
        )
        error.held_until = held_until
        raise error
    url = httpx2.URL(
        transport.base_url + selector_path(reading),
        params=file_params(reading.rendering),
    )
    return str(url)


def _reading(member: object, caller: str) -> Member | RefMember:
    """`member`, refused unless it is a dataset version's member."""
    if isinstance(member, DerivedMember | DerivedRefMember):
        raise client_error(
            INVALID_ARGUMENT,
            f"file_url links to dataset versions, and {member.spec.spec_id} at "
            f"{member.content_version} is a frame DFO computed, which has no "
            "stored file to link to. data.save(path) keeps its rows",
        )
    if not isinstance(member, Member | RefMember):
        raise client_error(
            INVALID_ARGUMENT,
            "file_url takes a member of a Dataset, such as data.members[0] or "
            f"data.ref.members[0] after data = {caller}.fetch(spec), not "
            f"{type(member).__name__}",
        )
    return member
