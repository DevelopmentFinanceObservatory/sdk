"""The module functions `dfo.search`, `dfo.fetch`, `dfo.configure`,
`dfo.disable_cache` and `dfo.enable_cache`, over a default client.

The default client is built on first use, under a lock, so importing `dfo` reads
neither the environment nor the network. `configure` replaces it. An answer from
`dfo.search` reads the default client when each of its requests runs, so it stays
usable after `configure`. `disable_cache` and `enable_cache` switch the cache of the
client in place, so its other settings stay. A replaced client closes once nothing
uses it, since another thread may still be in a call on it, and the default client
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
from os import PathLike

from dfo._config.keys import ApiKeyArgument
from dfo._core.refs import DatasetRef
from dfo._core.types import Layout, Spec, Window
from dfo._datasets.cache import Cache
from dfo._datasets.dataset import Dataset
from dfo._http.hooks import HeaderProvider
from dfo._search.answer import SEARCH_TIMEOUT
from dfo._sync._client.client import Client
from dfo._sync._datasets.fetch import Session
from dfo._sync._search.answer import Answer
from dfo._sync._search.search import search as _search

_lock = threading.Lock()
_client: Client | None = None


def default_client() -> Client:
    """The default client, built with no options on first use."""
    client = _client
    if client is not None:
        return client
    with _lock:
        if _client is None:
            _install(Client())
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


def configure(
    *,
    api_key: ApiKeyArgument = None,
    base_url: str | None = None,
    timeout: float = 30.0,
    max_retries: int = 2,
    cache_dir: str | PathLike[str] | None = None,
    cache: bool = True,
    default_headers: Mapping[str, str] | None = None,
    header_provider: HeaderProvider | None = None,
) -> None:
    """Replace the client `dfo.search` and `dfo.fetch` use.

    Takes `dfo.Client`'s options. Answers already returned by `dfo.search` use
    the new client for their next request.

    Raises:
        InvalidRequestError: The base URL is invalid (`base_url_invalid`), a
            default header's name is not an HTTP token or its value not a string
            of visible ASCII, spaces and tabs (`header_invalid`), the key would
            travel over plain http to a host that is not loopback
            (`insecure_transport`), the timeout is not a finite number above 0,
            the retry count not an integer from 0 to 10, or, with `cache` on,
            `cache_dir` an empty path, one holding a NUL character, or one
            starting `~name` for a user with no home directory
            (`invalid_argument`).
        AuthenticationError: The key lookup failed.
    """
    client = Client(
        api_key=api_key,
        base_url=base_url,
        timeout=timeout,
        max_retries=max_retries,
        cache_dir=cache_dir,
        cache=cache,
        default_headers=default_headers,
        header_provider=header_provider,
    )
    with _lock:
        _install(client)


def _set_cache_enabled(enabled: bool) -> None:
    cache = default_client()._current().cache
    if isinstance(cache, Cache):
        cache.enabled = enabled


def disable_cache() -> None:
    """Make the default client fetch without reading or writing the cache."""
    _set_cache_enabled(False)


def enable_cache() -> None:
    """Make the default client read and write the cache again.

    A default client configured with `cache=False` resolves its cache directory
    now.

    Raises:
        InvalidRequestError: That directory is an empty path, holds a NUL
            character, or starts `~name` for a user with no home directory
            (`invalid_argument`).
    """
    _set_cache_enabled(True)


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
    entities: Mapping[str, Sequence[str] | None] | None = None,
    facets: Mapping[str, str | None] | None = None,
    layout: Layout | None = None,
    without_party_totals: bool | None = None,
    strict: bool = False,
    timeout: float | None = 1800.0,
    progress: bool | None = None,
) -> Dataset:
    """Fetch a spec's latest version, or the exact versions a ref names, with the
    default client.

    Takes `Client.fetch`'s arguments, including its timeout behavior: platform
    name resolution can run past a synchronous deadline, while the asynchronous
    client can cancel it.

    Raises:
        InvalidRequestError: The target is neither a `Spec` nor a `DatasetRef`,
            such as a spec id, and no request is sent; a ref is narrowed or
            given another layout or `without_party_totals`; `window`,
            `entities`, `facets` or `layout` is malformed; or `timeout` is not
            None or a finite number above 0 (`invalid_argument`).
        VersionUnavailableError: A ref's version can no longer be fetched.
        ContractError: An artifact is not Parquet (`unexpected_response`), or
            lacks a `time_period` or numeric `value` column
            (`contract_violation`); the cache drops it.
        DfoTimeoutError: The deadline passed. A long build's message names the
            call that resumes it.
        DfoError: The server refused a request.
    """
    return default_client().fetch(
        target,
        window=window,
        entities=entities,
        facets=facets,
        layout=layout,
        without_party_totals=without_party_totals,
        strict=strict,
        timeout=timeout,
        progress=progress,
    )


def _reset_after_fork() -> None:
    global _lock  # noqa: PLW0603  # a child cannot release a lock another thread held
    _lock = threading.Lock()


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_reset_after_fork)
