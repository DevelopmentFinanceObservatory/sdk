"""The client: one connection to the DFO API, its key and its cache.

A client asks Search what a question means (`search`), builds datasets (`fetch`),
runs DFO's operations (`analysis`, and `fetch` of a recipe), pins versions
(`pin`), stores cards DFO draws (`cards`), publishes them as links (`share`,
`snapshot`, `unshare`, `history`), and looks up names, codes and Search's
catalogue (`lookup`). `request`
reaches any route the client does not wrap. The client
owns its connection pool: `with_options` returns a copy that shares the pool and
the cache, and only the client that built the pool closes it.
"""

from collections.abc import Mapping, Sequence
from os import PathLike
from typing import Any, ClassVar, Self

from dfo._config.keys import ApiKeyArgument
from dfo._core.codes import INVALID_ARGUMENT
from dfo._core.errors import DfoError, client_error
from dfo._core.refs import DatasetRef
from dfo._core.refusals import caller_refusal
from dfo._core.types import Layout, RawResponse, Spec, Window
from dfo._datasets.analysis import AsyncAnalysis
from dfo._datasets.cache import Cache
from dfo._datasets.cards import AsyncCards
from dfo._datasets.dataset import Dataset
from dfo._datasets.fetch import Session
from dfo._datasets.pin import pin as pin_versions
from dfo._datasets.publication import Card, Moment, Served, Share, ShareTarget
from dfo._datasets.recipe import Recipe
from dfo._datasets.resolve import fetch
from dfo._datasets.shares import history as share_history
from dfo._datasets.shares import share as publish
from dfo._datasets.shares import snapshot as fix_share
from dfo._datasets.shares import unshare as take_down
from dfo._http.hooks import AsyncHeaderProvider
from dfo._http.transport import AsyncTransport
from dfo._search.answer import SEARCH_TIMEOUT, AsyncAnswer
from dfo._search.lookups import AsyncLookup
from dfo._search.search import search


class AsyncClient:
    """A connection to the DFO API, with its key and cache, used as a context manager.

    Attributes:
        lookup: Names to graph nodes, a node by its dcid, a code's registry
            entry, and Search's catalogue.
        analysis: DFO's operations, each run at once on DFO.
        cards: Cards DFO stores and draws from a Dataset: line, bar, table,
            stat and source.
    """

    lookup: AsyncLookup
    analysis: AsyncAnalysis
    cards: AsyncCards
    # What the client's hints name the owner of a call they suggest, as in
    # `client.fetch(spec)`; the default client behind `dfo.fetch` names `dfo`.
    _caller: ClassVar[str] = "client"

    def __init__(
        self,
        *,
        api_key: ApiKeyArgument = None,
        base_url: str | None = None,
        timeout: float = 30.0,
        max_retries: int = 2,
        cache_dir: str | PathLike[str] | None = None,
        cache: bool = True,
        headers: Mapping[str, str] | None = None,
        header_provider: AsyncHeaderProvider | None = None,
    ) -> None:
        """Build the client and resolve its key.

        Args:
            api_key: The key: a string, an `ApiKey`, or a callable returning one;
                False for anonymous use; None to look one up in `DFO_API_KEY`,
                the credentials file, then a Colab secret.
            base_url: The API's base URL; None reads `DFO_BASE_URL`, and
                with that unset or empty takes the public API. The repr names
                `DFO_BASE_URL` when the URL came from it.
            timeout: The longest one request attempt waits, in seconds. A
                search attempt and a download read until their call's
                deadline instead, and a build request for up to 150 seconds.
                In the synchronous client, platform name resolution can run
                past this bound; the asynchronous client can cancel it.
            max_retries: Further attempts after a failure that can clear.
            cache_dir: The cache's root directory; None follows `DFO_CACHE_DIR`,
                then the platform's cache directory. A relative path resolves
                against the working directory when the client is built.
            cache: False fetches without reading or writing the cache.
            headers: Headers sent with every API request.
            header_provider: Called before every API request for more headers,
                such as an identity token.

        Raises:
            InvalidRequestError: The base URL, passed or read from
                `DFO_BASE_URL`, is invalid (`base_url_invalid`), a
                header's name is not an HTTP token or names `X-DFO-Client`, or its
                value not a string of visible ASCII, spaces and tabs (`header_invalid`), the
                key would travel over plain http to a host that is not loopback
                (`insecure_transport`), the timeout is not a finite number above
                0, the retry count not an integer from 0 to 10, or, with `cache`
                on, `cache_dir` an empty path, one holding a NUL character, or
                one starting `~name` for a user with no home directory
                (`invalid_argument`).
            AuthenticationError: The key lookup failed.
        """
        local = Cache(cache_dir, enabled=cache)
        transport = AsyncTransport(
            base_url=base_url,
            api_key=api_key,
            timeout=timeout,
            max_retries=max_retries,
            headers=headers,
            header_provider=header_provider,
            caller=self._caller,
        )
        self._attach(Session(transport, local))

    @classmethod
    def _over(cls, session: Session, /) -> Self:
        """A client over an existing transport and cache, for tests and replays."""
        client = cls.__new__(cls)
        client._attach(session)
        return client

    def _attach(self, session: Session) -> None:
        self._session = session
        self.lookup = AsyncLookup(session.transport)
        self.analysis = AsyncAnalysis(session.transport, session.cache)
        self.cards = AsyncCards(session.transport)

    def _current(self) -> Session:
        return self._session

    @property
    def base_url(self) -> str:
        """The API's base URL, without a trailing slash."""
        return self._session.transport.base_url

    def __repr__(self) -> str:
        transport = self._session.transport
        source = transport.base_url_source
        origin = " (from DFO_BASE_URL)" if source == "environment" else ""
        return f"<{type(self).__name__} {transport.base_url}{origin}>"

    def with_options(
        self, *, timeout: float | None = None, max_retries: int | None = None
    ) -> Self:
        """A copy with other limits, sharing this client's connections and cache.

        Closing the copy leaves the connections open. Close this client to close them.

        Raises:
            InvalidRequestError: The timeout is not a finite number above 0, or
                the retry count not an integer from 0 to 10 (`invalid_argument`).
        """
        transport = self._session.transport.with_options(
            timeout=timeout, max_retries=max_retries
        )
        return type(self)._over(Session(transport, self._session.cache))

    async def search(
        self, question: str, /, *, timeout: float | None = SEARCH_TIMEOUT
    ) -> AsyncAnswer:
        """Ask Search what a question means, part by part.

        Args:
            question: The question, in your words.
            timeout: The longest the call waits, retries included, in seconds.
                Each attempt reads until then, and None waits as long as Search
                takes. In the synchronous client, platform name resolution can
                run past this bound; the asynchronous client can cancel it.

        Raises:
            InvalidRequestError: `question` is not text, is empty or only
                whitespace, or holds a lone surrogate; or `timeout` is not None
                or a finite number above 0 (`invalid_argument`).
            ContractError: The answer lacks a member the client acts on.
        """
        return await search(self._current, question, timeout=timeout)

    async def fetch(
        self,
        target: Spec | DatasetRef | Recipe | ShareTarget,
        /,
        *,
        as_of: Moment | None = None,
        slot: int | None = None,
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
        `latest=True` the newest versions of a ref's specs; run a recipe on DFO
        in one request; or fetch the exact version a share's slot shows.

        A ref of a frame DFO computed reads that frame, and with `latest=True`
        DFO computes its recipe again on the newest versions of its datasets. A
        recipe or a computed frame takes `latest`, `strict` and `timeout`, and
        refuses `progress`, which DFO does not report while it computes, and the
        options that narrow or render a spec. A fetch that left
        series out for missing data issues one `SeriesLeftOutWarning`.

        A share reads the frame its slot shows now, or with `as_of` the one it
        showed then, in the frame layout, and the Dataset's repr names the
        share, slot, card title and day. It takes `as_of`, `slot`, `strict`,
        `timeout` and `progress`, and refuses the options that narrow or render
        a spec and `latest=True`; `history(share)` lists what each slot showed.

        A cancelled or interrupted fetch leaves its build running on the server,
        and the same fetch joins it. Ctrl-C in the synchronous client adds a
        note saying so to the `KeyboardInterrupt`.

        Args:
            target: A `Spec` to build, a `DatasetRef` to read back, a
                `Recipe` from `dfo.analysis.recipe` to run, or a `Share` or the
                URL of its page or embed, such as
                `https://developmentfinance.org/s/k3Qx8vTa`.
            as_of: For a share, a date, a datetime with its time zone, a date
                such as `"2026-10-28"` or an RFC 3339 date-time such as
                `"2026-10-28T10:00:00Z"`: the newest version the slot first
                served on or before it, compared to the millisecond. A date
                reads as the last millisecond of that day in UTC. None reads
                what the slot shows now.
            slot: For a share, the slot to read, numbered from 1 as the share's
                data URLs are. None reads a share of one slot, and a share of
                several refuses it.
            window: Narrow a spec to `"all"`, `"latest"` or
                `(start_year, end_year)`.
            entities: Rebind the named roles of a spec to dcids, such as
                `{"destination": ["country/NGA"]}`; `spec.roles` lists the
                keys. None drops a role. The spec's other roles keep their
                binding, and an empty map narrows nothing.
            facets: Bind a spec's provenance, measurement method or unit. An
                empty map narrows nothing.
            layout: `long` or `frame`; None builds a spec in `long` and reads a
                ref in the layout it holds.
            party_totals: Keep the rows of parties the code index declares
                totals, such as the DAC total beside its members, on each party
                role the spec leaves open. None, the default, leaves them out of
                a spec, so a sum over the table counts each party once, and
                reads a ref as it was fetched. A role the spec binds keeps what
                it binds.
            latest: Build the newest version of each of a ref's specs, in the
                rendering the ref holds, in place of the exact versions it
                names, as `fetch(old.ref, latest=True)`. A spec always fetches
                its newest version and refuses it.
            strict: Raise the first dataset warning, or the
                `SeriesLeftOutWarning`, instead of issuing it.
            timeout: The longest the fetch takes, in seconds, downloads
                included. None, the default, waits as long as the build takes,
                which the server always ends. In the synchronous client,
                platform name resolution can run past this bound; the
                asynchronous client can cancel it.
            progress: Show long-build progress; None shows it unless
                `DFO_PROGRESS=0`.

        Raises:
            InvalidRequestError: The target is not a `Spec`, a `DatasetRef`, a
                `Recipe`, or a `Share` or its URL, such as a spec id, and no
                request is sent; a ref is narrowed or given another layout or
                `party_totals`; `latest` is not a bool, is given a spec, or is
                given a ref whose members differ in rendering; a recipe or a
                computed frame is given `progress`; a share is given
                a narrowing, `party_totals`, `latest=True` or a layout other
                than `frame`, `slot` is 0, or `as_of` is malformed, all before
                any request; a share of several slots is given no `slot`, or
                one past its last; `as_of` is before the slot first served
                data; `window`, `entities`,
                `facets` or `layout` is malformed; `entities` names a role the
                spec does not declare; or
                `timeout` is not None or a finite number above 0
                (`invalid_argument`).
            NotFoundError: A share is unknown, its slot is empty, or with
                `as_of` the slot showed no card then (`not_found`).
            VersionUnavailableError: A ref's version can no longer be fetched.
            ContractError: An artifact is not Parquet (`unexpected_response`),
                or lacks a `time_period` or numeric `value` column
                (`contract_violation`); the cache drops it.
            DfoTimeoutError: `timeout` passed (`deadline_exceeded`). The build
                keeps running on the server, and the same fetch joins it.
            DfoError: The server refused a request.
        """
        return await fetch(
            self._session.transport,
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
            cache=self._session.cache,
        )

    async def pin(self, data: Dataset, /) -> Dataset:
        """Keep `data`'s exact versions fetchable by its ref with no time limit,
        and return the same Dataset, now pinned.

        Pinning cannot be undone, and each new pin counts against a daily
        allowance per network address. `data.save(path)` keeps the rows on your
        disk instead.

        Raises:
            InvalidRequestError: `data` is not a Dataset, names no version, or
                holds a frame DFO computed, which the pin route does not take
                (`invalid_argument`); no request is sent.
            QuotaExceededError: The daily pin allowance is spent
                (`allowance_exhausted`); `retry_after` says when it resets.
        """
        return await pin_versions(self._session.transport, data)

    async def share(
        self,
        cards: Card | Sequence[Card],
        /,
        *,
        latest: bool,
        replace: ShareTarget | None = None,
        write_token: str | None = None,
    ) -> Share:
        """Publish cards as a link, or give a live share new cards under the
        same URLs.

        Each card sits in a numbered slot. A share pins the versions its cards
        draw, and each new share counts against a daily allowance per network
        address. The `Share` carries the write token that changes or removes it,
        and prints without it. DFO returns the token only here and the client
        saves it nowhere else, so keep `share.write_token` with the share's URL
        and pass both to `unshare` or `snapshot` later. The client mints that
        token, so a create retried after a lost reply answers the first share
        and spends no allowance.

        Args:
            cards: A card from `cards`, or a list of them in slot order.
            latest: True for a live share, which follows new data and takes new
                cards; False for a snapshot, which keeps today's versions for
                good. It has no default, since the two answer different
                questions under a public URL.
            replace: A live share, or its URL, to give these cards. Every slot
                keeps its embed and data URLs, and slots past the last card
                stay empty.
            write_token: The share's write token, for a `replace` given as a URL;
                a `Share` carries its own.

        Raises:
            InvalidRequestError: `cards` is not a Card or a non-empty list of
                them, `latest` is not a bool, `replace` is given with
                `latest=False`, or `replace` is not a Share or a share URL
                (`invalid_argument`), and no request is sent; DFO refused a
                replace without a token (`write_token_required`) or of a
                snapshot (`share_not_replaceable`).
            PermissionDeniedError: The token is not the share's
                (`write_token_invalid`).
            QuotaExceededError: The daily share allowance is spent
                (`allowance_exhausted`); `retry_after` says when it resets.
        """
        return await publish(
            self._session.transport,
            cards,
            latest=latest,
            replace=replace,
            write_token=write_token,
        )

    async def snapshot(
        self, share: ShareTarget, /, *, write_token: str | None = None
    ) -> Share:
        """Fix a live share as a snapshot under the same URLs, each slot keeping
        the version it shows now. A snapshot stays fixed for good.

        Args:
            share: The share, or its URL.
            write_token: The share's write token, for a share given as a URL.

        Raises:
            InvalidRequestError: `share` is not a Share or a share URL
                (`invalid_argument`), and no request is sent; or no token was
                given (`write_token_required`).
            PermissionDeniedError: The token is not the share's
                (`write_token_invalid`).
        """
        return await fix_share(self._session.transport, share, write_token=write_token)

    async def unshare(
        self, share: ShareTarget, /, *, write_token: str | None = None
    ) -> None:
        """Take a share's link down. Taking it down again with its token
        succeeds, so a retry after a lost reply is safe.

        Args:
            share: The share, or its URL.
            write_token: The share's write token, `share.write_token` of the
                `Share` that `share` returned, for a share given as a URL.

        Raises:
            InvalidRequestError: `share` is not a Share or a share URL
                (`invalid_argument`), and no request is sent; or no token was
                given (`write_token_required`), and the message says to pass
                `write_token=`.
            PermissionDeniedError: The token is not the share's
                (`write_token_invalid`).
            NotFoundError: No share has that id (`not_found`).
        """
        await take_down(self._session.transport, share, write_token=write_token)

    async def history(self, share: ShareTarget, /) -> tuple[Served, ...]:
        """What each card of a share served, newest first, with whether each
        frame can still be fetched. `fetch(share, slot=n, as_of=day)` reads one.
        An entry with `card_id` None marks a replace that left the slot without
        a card.

        Args:
            share: The share, or its URL.

        Raises:
            InvalidRequestError: `share` is not a Share or a share URL
                (`invalid_argument`), and no request is sent.
            NotFoundError: No share has that id, or it was taken down
                (`not_found`).
        """
        return await share_history(self._session.transport, share)

    async def request(
        self,
        method: str,
        path: str,
        /,
        *,
        params: Mapping[str, Any] | None = None,
        json: Any = None,
    ) -> RawResponse:
        """Send a request to a route the client does not wrap.

        The request carries the client's key and headers and retries as every
        call does. A redirect comes back as the response.

        Args:
            method: The HTTP method.
            path: A path under the base URL, such as `/datasets/capabilities`.
            params: Query parameters.
            json: The JSON body.

        Raises:
            DfoError: The class the refusal maps to.
            InvalidRequestError: `path` does not start with `/`, starts with
                `//`, or holds a `.` or `..` segment or a control character;
                `method` is not one the API serves, or `json` is not JSON or
                goes with a GET or HEAD (`invalid_argument`); or the server
                refused the method (`method_not_allowed`), which on a route the
                client wraps is a `ContractError`.
            ServerError: The decoded body passed 16 MiB (`response_too_large`).
        """
        if not path.startswith("/") or path.startswith("//"):
            raise client_error(
                INVALID_ARGUMENT,
                f"request takes a path under the base URL, such as "
                f"'/datasets/capabilities', not {path!r}",
            )
        try:
            response = await self._session.transport.request(
                method, path, params=params, json=json
            )
        except DfoError as error:
            if (refusal := caller_refusal(error)) is error:
                raise
            raise refusal from error
        return RawResponse(
            status_code=response.status_code,
            headers=dict(response.headers),
            content=response.content,
        )

    async def aclose(self) -> None:
        """Close the client's connections, when this client opened them.

        A call through a closed client, or through a copy of it, raises
        `InvalidRequestError` (`invalid_argument`).
        """
        await self._session.transport.aclose()

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.aclose()
