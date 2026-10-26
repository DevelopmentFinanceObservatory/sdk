"""The module functions `dfo.search`, `dfo.fetch` and `dfo.configure`, and the
lookups of `dfo.lookup`, over a default client.

The default client is built on first use, under a lock, so importing `dfo` reads
neither the environment nor the network. `configure` replaces it. An answer from
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

from dfo._config.keys import ApiKeyArgument
from dfo._core.refs import DatasetRef
from dfo._core.types import Layout, Node, Spec, Window
from dfo._datasets.dataset import Dataset
from dfo._generated.wire import (
    CatalogueResponse,
    CodeRegistryEntry,
    ResolveKind,
    ResolveResponse,
)
from dfo._http.hooks import HeaderProvider
from dfo._search.answer import SEARCH_TIMEOUT
from dfo._sync._client.client import Client
from dfo._sync._datasets.fetch import Session
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
    timeout: float = 30.0,
    max_retries: int = 2,
    cache_dir: str | PathLike[str] | None = None,
    cache: bool = True,
    headers: Mapping[str, str] | None = None,
    header_provider: HeaderProvider | None = None,
) -> None:
    """Replace the client `dfo.search` and `dfo.fetch` use.

    Takes `dfo.Client`'s options. Answers already returned by `dfo.search` use
    the new client for their next request. `cache=False` fetches without reading
    or writing the cache.

    Raises:
        InvalidRequestError: The base URL, passed or read from `DFO_BASE_URL`,
            is invalid (`base_url_invalid`), a
            header's name is not an HTTP token or its value not a string
            of visible ASCII, spaces and tabs (`header_invalid`), the key would
            travel over plain http to a host that is not loopback
            (`insecure_transport`), the timeout is not a finite number above 0,
            the retry count not an integer from 0 to 10, or, with `cache` on,
            `cache_dir` an empty path, one holding a NUL character, or one
            starting `~name` for a user with no home directory
            (`invalid_argument`).
        AuthenticationError: The key lookup failed.
    """
    client = _DefaultClient(
        api_key=api_key,
        base_url=base_url,
        timeout=timeout,
        max_retries=max_retries,
        cache_dir=cache_dir,
        cache=cache,
        headers=headers,
        header_provider=header_provider,
    )
    with _lock:
        _install(client)


def search(question: str, /, *, timeout: float | None = SEARCH_TIMEOUT) -> Answer:
    """Ask Search what a question means, part by part, with the default client.

    Args:
        question: The question, in your words.
        timeout: The longest the call waits, retries included, in seconds. Each
            attempt reads until then, and None waits as long as Search takes.
            In the synchronous client, platform name resolution can run past
            this bound; the asynchronous client can cancel it.

    Raises:
        InvalidRequestError: `question` is empty or only whitespace, or
            `timeout` is not None or a finite number above 0 (`invalid_argument`).
        ContractError: The answer lacks a member the client acts on.
    """
    return _search(_session, question, timeout=timeout)


def fetch(
    target: Spec | DatasetRef,
    /,
    *,
    window: Window | None = None,
    entities: Mapping[str, list[str] | tuple[str, ...] | None] | None = None,
    facets: Mapping[str, str | None] | None = None,
    layout: Layout | None = None,
    party_totals: bool | None = None,
    latest: bool = False,
    strict: bool = False,
    timeout: float | None = None,
    progress: bool | None = None,
) -> Dataset:
    """Fetch a spec's latest version, the exact versions a ref names, or with
    `latest=True` the newest versions of a ref's specs, with the default client.

    Takes `Client.fetch`'s arguments, including its timeout behavior: platform
    name resolution can run past a synchronous deadline, while the asynchronous
    client can cancel it.

    Raises:
        InvalidRequestError: The target is neither a `Spec` nor a `DatasetRef`,
            such as a spec id, and no request is sent; a ref is narrowed or
            given another layout or `party_totals`; `latest` is not a
            bool, is given a spec, or is given a ref whose members differ in
            rendering; `window`,
            `entities`, `facets` or `layout` is malformed; or `timeout` is not
            None or a finite number above 0 (`invalid_argument`).
        VersionUnavailableError: A ref's version can no longer be fetched.
        ContractError: An artifact is not Parquet (`unexpected_response`), or
            lacks a `time_period` or numeric `value` column
            (`contract_violation`); the cache drops it.
        DfoTimeoutError: `timeout` passed (`deadline_exceeded`). The build
            keeps running on the server, and the same fetch joins it.
        DfoError: The server refused a request.
    """
    return default_client().fetch(
        target,
        window=window,
        entities=entities,
        facets=facets,
        layout=layout,
        party_totals=party_totals,
        latest=latest,
        strict=strict,
        timeout=timeout,
        progress=progress,
    )


def resolve(
    *texts: str,
    kinds: Sequence[ResolveKind] | None = None,
    code_system: str | None = None,
    expand_members: bool = False,
) -> ResolveResponse:
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


def code(code: str, /) -> CodeRegistryEntry:
    """The registry entry for one code, such as `spec_not_found`, with the
    default client.

    Raises:
        InvalidRequestError: `code` is not lower-case snake case
            (`invalid_argument`); no request is sent.
        NotFoundError: The registry holds no such code.
    """
    return default_client().lookup.code(code)


def catalogue(*, place: str | None = None) -> CatalogueResponse:
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
