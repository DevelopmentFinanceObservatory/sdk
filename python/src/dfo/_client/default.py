"""The module functions `dfo.search`, `dfo.fetch`, `dfo.pin`, `dfo.share`,
`dfo.snapshot`, `dfo.unshare`, `dfo.history` and `dfo.configure`, and the lookups
of `dfo.lookup`, over a default client.

The default client is built on first use, under a lock, so importing `dfo` reads
neither the environment nor the network, and an invalid `DFO_TIMEOUT` raises at
the first call. `configure` replaces it. An answer from
`dfo.search` reads the default client when each of its requests runs, so it stays
usable after `configure`. A replaced client closes once nothing uses it, since another thread may still be in a call on it, and the default client
closes at exit.
A forked child keeps the default client, and with it the options `configure`
set. Its transport builds a fresh connection pool on the child's first request
and leaves the parent's connections untouched. The child takes a fresh lock,
since another thread may have held the parent's as the process forked. That
pool routes through the proxy settings the parent resolved. A client the child
builds for itself looks the platform's proxy settings up in the child.
"""

import os
import threading
import weakref
from collections.abc import Mapping, Sequence
from datetime import date
from os import PathLike
from typing import overload

from dfo._config.keys import ApiKeyArgument
from dfo._core.lookup_results import Catalogue, Code, Match, Node
from dfo._core.refs import DatasetRef
from dfo._core.timeouts import (
    CLIENT_TIMEOUT,
    FROM_ENVIRONMENT,
    CallTimeout,
    ClientTimeoutArgument,
    MaxRetriesArgument,
)
from dfo._core.types import Layout, Spec, Window
from dfo._datasets.build import Entities
from dfo._datasets.dataset import Dataset
from dfo._datasets.publication import Card, Moment, Served, Share, ShareTarget
from dfo._datasets.recipe import Recipe
from dfo._generated.wire import ResolveKind
from dfo._http.hooks import HeaderProvider
from dfo._sync._client.client import Client
from dfo._sync._datasets.fetch import Session
from dfo._sync._datasets.resolve import fetch as _fetch
from dfo._sync._search.answer import Answer
from dfo._sync._search.search import search as _search


class _DefaultClient(Client):
    """The client behind the module functions, whose hints name `dfo.fetch` and
    `dfo.lookup` as the calls to run."""

    _caller = "dfo"


_lock = threading.Lock()
_client: Client | None = None


def default_client() -> Client:
    """The default client, built with no options on first use."""
    client = _client
    if client is not None:
        return client
    with _lock:
        if _client is None:
            _install(_DefaultClient())
        assert _client is not None
        return _client


def _install(client: Client) -> None:
    global _client  # noqa: PLW0603  # the module holds the one default client
    _client = client
    # Close each default client when it is collected, or at exit if it never is.
    weakref.finalize(client, client._current().transport.close)


def _session() -> Session:
    client = default_client()
    session = client._current()
    return Session(session.transport, session.cache, owner=client)


# `Answer.from_json` with no client reads through the default client.
Answer._default_source = _session


def configure(
    *,
    api_key: ApiKeyArgument = None,
    base_url: str | None = None,
    timeout: ClientTimeoutArgument = FROM_ENVIRONMENT,
    attempt_timeout: float = 30.0,
    max_retries: MaxRetriesArgument = FROM_ENVIRONMENT,
    cache_dir: str | PathLike[str] | None = None,
    cache: bool = True,
    headers: Mapping[str, str] | None = None,
    header_provider: HeaderProvider | None = None,
) -> None:
    """Replace the client `dfo.search` and `dfo.fetch` use.

    Takes `dfo.Client`'s options. `timeout` bounds each whole call that passes
    no `timeout` of its own, and `attempt_timeout` each request attempt.
    `timeout` and `max_retries` left out read `DFO_TIMEOUT` and
    `DFO_MAX_RETRIES`, and `timeout=None` leaves each call its own default.
    Answers already returned by `dfo.search` use the new client for their next
    request. `cache=False` fetches without reading or writing the cache.

    Raises:
        InvalidRequestError: The base URL, passed or read from `DFO_BASE_URL`,
            is invalid (`base_url_invalid`), a
            header's name is not an HTTP token or names `X-DFO-Client`, or its
            value not a string of visible ASCII, spaces and tabs (`header_invalid`), the key would
            travel over plain http to a host that is not loopback
            (`insecure_transport`), `timeout` is not None or a finite number
            above 0, `attempt_timeout` not a finite number above 0, the retry
            count not an integer from 0 to 10, `DFO_TIMEOUT` or
            `DFO_MAX_RETRIES`, read for an argument left out, not seconds
            above 0 such as `300` or `2.5` or a count from 0 to 10 in digits,
            or, with `cache` on,
            `cache_dir` an empty path, one holding a NUL character, or one
            starting `~name` for a user with no home directory
            (`invalid_argument`).
        AuthenticationError: The key lookup failed.
    """
    client = _DefaultClient(
        api_key=api_key,
        base_url=base_url,
        timeout=timeout,
        attempt_timeout=attempt_timeout,
        max_retries=max_retries,
        cache_dir=cache_dir,
        cache=cache,
        headers=headers,
        header_provider=header_provider,
    )
    with _lock:
        _install(client)


def search(question: str, /, *, timeout: CallTimeout = CLIENT_TIMEOUT) -> Answer:
    """Ask Search what a question means, part by part, with the default client.

    Args:
        question: The question, in your words.
        timeout: The longest the call waits, retries included, in seconds. Each
            attempt reads until then, and None waits as long as Search takes.
            Left out, the `timeout` given to `dfo.configure` applies, else 60
            seconds. In the synchronous client, platform name resolution can
            run past this bound; the asynchronous client can cancel it.

    Raises:
        InvalidRequestError: `question` is empty or only whitespace, or
            `timeout` is not None or a finite number above 0 (`invalid_argument`).
        ContractError: The answer lacks a member the client acts on.
    """
    return _search(_session, question, timeout=timeout)


@overload
def fetch(
    target: Spec,
    /,
    *,
    window: Window | None = None,
    entities: Entities | None = None,
    facets: Mapping[str, str | None] | None = None,
    layout: Layout | None = None,
    party_totals: bool | None = None,
    strict: bool = False,
    timeout: CallTimeout = CLIENT_TIMEOUT,
    progress: bool | None = None,
) -> Dataset: ...


@overload
def fetch(
    target: DatasetRef,
    /,
    *,
    latest: bool = False,
    strict: bool = False,
    timeout: CallTimeout = CLIENT_TIMEOUT,
    progress: bool | None = None,
) -> Dataset: ...


@overload
def fetch(
    target: Recipe,
    /,
    *,
    latest: bool = False,
    strict: bool = False,
    timeout: CallTimeout = CLIENT_TIMEOUT,
) -> Dataset: ...


@overload
def fetch(
    target: ShareTarget,
    /,
    *,
    as_of: Moment | None = None,
    slot: int | None = None,
    strict: bool = False,
    timeout: CallTimeout = CLIENT_TIMEOUT,
    progress: bool | None = None,
) -> Dataset: ...


# A target typed as a union takes the options every target takes.
@overload
def fetch(
    target: Spec | DatasetRef | Recipe | ShareTarget,
    /,
    *,
    strict: bool = False,
    timeout: CallTimeout = CLIENT_TIMEOUT,
) -> Dataset: ...


def fetch(
    target: Spec | DatasetRef | Recipe | ShareTarget,
    /,
    *,
    as_of: Moment | None = None,
    slot: int | None = None,
    window: Window | None = None,
    entities: Entities | None = None,
    facets: Mapping[str, str | None] | None = None,
    layout: Layout | None = None,
    party_totals: bool | None = None,
    latest: bool = False,
    strict: bool = False,
    timeout: CallTimeout = CLIENT_TIMEOUT,
    progress: bool | None = None,
) -> Dataset:
    """Fetch a spec's latest version, the exact versions a ref names, or with
    `latest=True` the newest versions of a ref's specs; run a recipe on DFO; or
    fetch the exact version a share's slot shows, with the default client.

    Takes `Client.fetch`'s arguments, including its timeout behavior: left out,
    `timeout` is the one given to `dfo.configure`, else None, which waits as
    long as the build takes. Platform name resolution can run past a
    synchronous deadline, while the asynchronous client can cancel it.

    Raises:
        InvalidRequestError: The target is not a `Spec`, a `DatasetRef`, a
            `Recipe`, or a `Share` or its URL, such as a spec id, and no request
            is sent; a ref is narrowed or given another layout or
            `party_totals`; `latest` is not a bool, is given a spec, or is
            given a ref whose members differ in rendering; a share is given a
            narrowing, `party_totals`, `latest=True` or a layout other than
            `frame`, `slot` is 0, or `as_of` is malformed, all before any
            request; a share of several slots is given no `slot`, or one past
            its last; `as_of` is before the slot first served data; `window`,
            `entities`, `facets` or `layout` is malformed; `entities` holds a
            match that did not resolve, or names a role the spec does not
            declare; or `timeout` is not None or a finite number above 0
            (`invalid_argument`). A type checker rejects an option the target
            does not take.
        VersionUnavailableError: A ref's version can no longer be fetched.
        ContractError: An artifact is not Parquet (`unexpected_response`), or
            lacks a `time_period` or numeric `value` column
            (`contract_violation`); the cache drops it.
        DfoTimeoutError: `timeout` passed (`deadline_exceeded`). The build
            keeps running on the server, and the same fetch joins it.
        DfoError: The server refused a request.
    """
    # The session holds the default client open until the fetch returns.
    session = _session()
    return _fetch(
        session.transport,
        target,
        as_of=as_of,
        slot=slot,
        window=window,
        entities=entities,
        facets=facets,
        layout=layout,
        party_totals=party_totals,
        latest=latest,
        strict=strict,
        timeout=timeout,
        progress=progress,
        cache=session.cache,
    )


def pin(data: Dataset, /) -> Dataset:
    """Keep `data`'s exact versions fetchable by its ref with no time limit, with
    the default client, and return the same Dataset, now pinned.

    Takes `Client.pin`'s argument.

    Raises:
        InvalidRequestError: `data` is not a Dataset, names no version, or holds
            a frame DFO computed, which the pin route does not take
            (`invalid_argument`); no request is sent.
        QuotaExceededError: The daily pin allowance is spent (`allowance_exhausted`).
    """
    return default_client().pin(data)


def share(
    cards: Card | Sequence[Card],
    /,
    *,
    latest: bool,
    replace: ShareTarget | None = None,
    write_token: str | None = None,
) -> Share:
    """Publish cards as a link, or give a live share new cards under the same
    URLs, with the default client.

    Takes `Client.share`'s arguments. `latest` has no default: True follows new
    data, False keeps today's versions for good.

    Raises:
        InvalidRequestError: An argument is malformed (`invalid_argument`), and
            no request is sent; DFO refused a replace without a token
            (`write_token_required`) or of a snapshot (`share_not_replaceable`).
        PermissionDeniedError: The token is not the share's (`write_token_invalid`).
        QuotaExceededError: The daily share allowance is spent (`allowance_exhausted`).
    """
    return default_client().share(
        cards, latest=latest, replace=replace, write_token=write_token
    )


def snapshot(share: ShareTarget, /, *, write_token: str | None = None) -> Share:
    """Fix a live share as a snapshot under the same URLs, with the default
    client.

    Takes `Client.snapshot`'s arguments.

    Raises:
        InvalidRequestError: `share` is not a Share or a share URL
            (`invalid_argument`); or no token was given (`write_token_required`).
        PermissionDeniedError: The token is not the share's (`write_token_invalid`).
    """
    return default_client().snapshot(share, write_token=write_token)


def unshare(share: ShareTarget, /, *, write_token: str | None = None) -> None:
    """Take a share's link down, with the default client. Taking it down again
    with its token succeeds, so a retry is safe.

    Takes `Client.unshare`'s arguments: a share given as a URL needs
    `write_token=share.write_token`, from the `Share` that `dfo.share` returned.

    Raises:
        InvalidRequestError: `share` is not a Share or a share URL
            (`invalid_argument`); or no token was given (`write_token_required`).
        PermissionDeniedError: The token is not the share's (`write_token_invalid`).
        NotFoundError: No share has that id (`not_found`).
    """
    default_client().unshare(share, write_token=write_token)


def history(share: ShareTarget, /) -> tuple[Served, ...]:
    """What each card of a share served, newest first, with the default client.

    Raises:
        InvalidRequestError: `share` is not a Share or a share URL
            (`invalid_argument`).
        NotFoundError: No share has that id, or it was taken down (`not_found`).
    """
    return default_client().history(share)


def resolve(
    *texts: str,
    kinds: Sequence[ResolveKind] | None = None,
    code_system: str | None = None,
    expand_members: bool = False,
) -> list[Match]:
    """Resolve names, such as "Nigeria" or "Sahel", to graph nodes, with the
    default client.

    Takes `client.lookup.resolve`'s arguments.

    Raises:
        InvalidRequestError: The server refused the names or kinds.
    """
    return default_client().lookup.resolve(
        *texts, kinds=kinds, code_system=code_system, expand_members=expand_members
    )


def node(dcid: str, /, *, as_of: date | None = None) -> Node:
    """One graph node by its dcid, such as `country/NGA`, with the default client.

    Takes `client.lookup.node`'s arguments.

    Raises:
        InvalidRequestError: `dcid` is empty or holds a `.` or `..` segment, a
            `?`, a `#` or a control character (`invalid_argument`); no request
            is sent.
        NotFoundError: The graph holds no node with that dcid.
    """
    return default_client().lookup.node(dcid, as_of=as_of)


def code(code: str, /) -> Code:
    """The registry entry for one code, such as `spec_not_found`, with the
    default client.

    Raises:
        InvalidRequestError: `code` is not lower-case snake case
            (`invalid_argument`); no request is sent.
        NotFoundError: The registry holds no such code.
    """
    return default_client().lookup.code(code)


def catalogue(*, place: str | None = None) -> Catalogue:
    """What Search holds data on, counts and example questions, with the default
    client.

    Args:
        place: A country dcid, such as `country/NGA`, to scope the counts and
            examples to that country.
    """
    return default_client().lookup.catalogue(place=place)


def _reset_after_fork() -> None:
    global _lock  # noqa: PLW0603  # a child cannot release a lock another thread held
    _lock = threading.Lock()


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_reset_after_fork)
