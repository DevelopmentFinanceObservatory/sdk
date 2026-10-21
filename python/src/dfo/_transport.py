"""The HTTP transport every DFO client call goes through.

The transport owns the base URL, the key, retries, deadlines and the reading of
problem documents. A path resolves under the base URL and a root-relative URL
the server returns resolves against the base URL's origin. The key travels only
to that origin; a signed storage URL is fetched by `download` with a bare
request. Under `DFO_OFFLINE=1` every request raises `offline` before it is sent.
"""

import copy
import os
from collections.abc import Mapping
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Any, Self
from urllib.parse import urljoin, urlsplit

import httpx2

from dfo._error_map import (
    DEADLINE_EXCEEDED,
    DOWNLOAD_FAILED,
    NETWORK_ERROR,
    OFFLINE,
)
from dfo._errors import (
    DfoDeprecationWarning,
    DfoError,
    DfoWarning,
    client_error,
    warn_once,
)
from dfo._hooks import AsyncHeaderProvider, AsyncSleep, Clock, async_sleep, monotonic
from dfo._keys import ApiKeyArgument, KeyState, ResolvedKey
from dfo._refusals import problem_error
from dfo._version import __version__

DEFAULT_BASE_URL = "https://developmentfinance.org/api/v1"
USER_AGENT = f"dfo-python/{__version__}"

_BACKOFF_FIRST = 0.5
_BACKOFF_CAP = 8.0


def offline() -> bool:
    """Whether `DFO_OFFLINE=1` limits the client to its local cache."""
    return os.environ.get("DFO_OFFLINE") == "1"


def _refuse_offline(request: str) -> None:
    """Raise `offline` before `request` when `DFO_OFFLINE=1` forbids the network."""
    if offline():
        raise client_error(
            OFFLINE, f"DFO_OFFLINE=1 is set, and {request} needs the network"
        )


def _split_base_url(base_url: str) -> tuple[str, str]:
    parts = urlsplit(base_url)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        raise ValueError(f"The base URL must be an http or https URL: {base_url!r}")
    origin = f"{parts.scheme}://{parts.netloc}".lower()
    return origin + parts.path.rstrip("/"), origin


def retry_after(response: httpx2.Response) -> float | None:
    """Return the wait a `Retry-After` header asks for, or None."""
    value = response.headers.get("retry-after")
    if not value:
        return None
    if value.strip().isdigit():
        return float(value)
    try:
        moment = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return max(0.0, (moment - datetime.now(UTC)).total_seconds())


def _json_body(response: httpx2.Response) -> object:
    if not response.content or "json" not in response.headers.get("content-type", ""):
        return None
    try:
        return response.json()
    except ValueError:
        return None


class AsyncTransport:
    """One HTTP client with the DFO API's base URL, key, retries and deadlines.

    A transport is built once per client. `with_options` makes copies that share
    its connection pool and key; only the transport that built the pool closes it.
    """

    def __init__(
        self,
        *,
        base_url: str | None = None,
        api_key: ApiKeyArgument = None,
        timeout: float = 30.0,
        max_retries: int = 2,
        default_headers: Mapping[str, str] | None = None,
        header_provider: AsyncHeaderProvider | None = None,
        http_transport: httpx2.AsyncBaseTransport | None = None,
        sleep: AsyncSleep = async_sleep,
        clock: Clock = monotonic,
    ) -> None:
        """Build the transport and resolve its key.

        Args:
            base_url: The API's base URL; paths resolve under it.
            api_key: The key, an `ApiKey`, a callable returning one, False for
                anonymous use, or None to look one up.
            timeout: The longest one attempt waits, in seconds.
            max_retries: Further attempts after a retryable failure.
            default_headers: Headers sent with every API request.
            header_provider: Called before every API request for more headers,
                such as an identity token.
            http_transport: The httpx2 transport, for tests and proxies.
            sleep: Waits between attempts.
            clock: A monotonic clock, in seconds, for deadlines.

        Raises:
            ValueError: The base URL, timeout or retry count is invalid.
            AuthenticationError: The key lookup failed.
        """
        if timeout <= 0:
            raise ValueError(f"timeout must be positive, not {timeout}")
        if max_retries < 0:
            raise ValueError(f"max_retries cannot be negative, not {max_retries}")
        self._base_url, self._origin = _split_base_url(base_url or DEFAULT_BASE_URL)
        self._keys = KeyState(api_key)
        self._timeout = timeout
        self._max_retries = max_retries
        self._default_headers = dict(default_headers or {})
        self._header_provider = header_provider
        self._sleep = sleep
        self._clock = clock
        self._http = httpx2.AsyncClient(
            transport=http_transport, follow_redirects=False
        )
        self._owner = True

    @property
    def base_url(self) -> str:
        """The base URL, without a trailing slash."""
        return self._base_url

    @property
    def origin(self) -> str:
        """The base URL's scheme and host."""
        return self._origin

    @property
    def key(self) -> ResolvedKey:
        """The key the transport sends, and the source it came from."""
        return self._keys.resolved

    @property
    def timeout(self) -> float:
        """The longest one attempt waits, in seconds."""
        return self._timeout

    @property
    def max_retries(self) -> int:
        """Further attempts after a retryable failure."""
        return self._max_retries

    def with_options(
        self, *, timeout: float | None = None, max_retries: int | None = None
    ) -> Self:
        """Return a copy with other limits that shares the pool and the key."""
        clone = copy.copy(self)
        clone._owner = False
        if timeout is not None:
            if timeout <= 0:
                raise ValueError(f"timeout must be positive, not {timeout}")
            clone._timeout = timeout
        if max_retries is not None:
            if max_retries < 0:
                raise ValueError(f"max_retries cannot be negative, not {max_retries}")
            clone._max_retries = max_retries
        return clone

    def now(self) -> float:
        """Return the transport's clock reading, in seconds."""
        return self._clock()

    def deadline(self, seconds: float | None) -> float | None:
        """Return the clock reading `seconds` from now, or None for no deadline."""
        return None if seconds is None else self._clock() + seconds

    async def sleep(self, seconds: float) -> None:
        """Wait `seconds` through the transport's sleep."""
        await self._sleep(seconds)

    def origin_url(self, reference: str) -> str:
        """Resolve a URL the server returned against the base URL's origin."""
        return urljoin(self._origin + "/", reference)

    def _url(self, target: str) -> str:
        parts = urlsplit(target)
        if parts.scheme or parts.netloc:
            if f"{parts.scheme}://{parts.netloc}".lower() != self._origin:
                raise ValueError(
                    f"{target} is outside the API at {self._origin}; "
                    "fetch a signed URL with download()"
                )
            return target
        if not target.startswith("/"):
            raise ValueError(f"A request path starts with '/': {target!r}")
        return self._base_url + target

    def _attempt_timeout(self, timeout: float | None, deadline: float | None) -> float:
        limit = self._timeout if timeout is None else timeout
        if deadline is None:
            return limit
        remaining = deadline - self._clock()
        if remaining <= 0:
            raise client_error(
                DEADLINE_EXCEEDED, "The call's deadline passed before it finished"
            )
        return min(limit, remaining)

    async def _headers(self, extra: Mapping[str, str] | None) -> httpx2.Headers:
        headers = httpx2.Headers(
            {"User-Agent": USER_AGENT, "Accept": "application/json"}
        )
        headers.update(self._default_headers)
        if self._header_provider is not None:
            headers.update(await self._header_provider())
        if extra:
            headers.update(extra)
        if (key := self._keys.resolved.key) is not None:
            headers["Authorization"] = f"Bearer {key.reveal()}"
        return headers

    def _note_headers(self, method: str, response: httpx2.Response) -> None:
        deprecation = response.headers.get("deprecation")
        sunset = response.headers.get("sunset")
        if deprecation or sunset:
            route = f"{method} {response.request.url.path}"
            marks = ", ".join(
                f"{name}: {value}"
                for name, value in (("Deprecation", deprecation), ("Sunset", sunset))
                if value
            )
            warn_once(
                ("deprecation", deprecation, sunset),
                DfoDeprecationWarning(
                    f"The DFO API marked {route} for removal ({marks}). "
                    "Upgrade development-finance."
                ),
            )
        if notice := response.headers.get("x-dfo-warning"):
            warn_once(("x-dfo-warning", notice), DfoWarning(notice))

    def _retry_wait(
        self, error: DfoError, attempt: int, retries: int, deadline: float | None
    ) -> float | None:
        if not error.retryable or attempt >= retries:
            return None
        wait = error.retry_after
        if wait is None:
            wait = min(_BACKOFF_FIRST * 2**attempt, _BACKOFF_CAP)
        if deadline is not None and self._clock() + wait >= deadline:
            return None
        return wait

    async def request(
        self,
        method: str,
        target: str,
        *,
        params: Mapping[str, Any] | None = None,
        json: Any = None,
        headers: Mapping[str, str] | None = None,
        timeout: float | None = None,
        deadline: float | None = None,
        max_retries: int | None = None,
    ) -> httpx2.Response:
        """Send one API request, retrying what can succeed later.

        A 2xx or 3xx response returns as it is; a redirect is never followed.
        A refusal retries when its problem document says `retryable` (or, with
        no such member, when its status is one that clears), waiting for
        `Retry-After` or backing off from 0.5 to 8 seconds. A 401 resolves the
        key again and, when the key changed, sends once more.

        Args:
            method: The HTTP method.
            target: A path under the base URL, or an absolute URL on its origin.
            params: Query parameters.
            json: The JSON body.
            headers: Headers for this request only.
            timeout: The longest one attempt waits; defaults to the transport's.
            deadline: A clock reading the whole call, waits included, must
                finish by; each attempt's timeout is clamped to it.
            max_retries: Further attempts; defaults to the transport's.

        Raises:
            DfoError: The class the refusal maps to, once retries are spent.
            NetworkError: The connection failed on every attempt, or
                `DFO_OFFLINE=1` is set (`offline`).
            DfoTimeoutError: An attempt timed out with no retry left, or the
                deadline passed.
            ValueError: `target` is neither a path nor a URL on the API's origin.
        """
        url = self._url(target)
        _refuse_offline(f"{method} {url}")
        retries = self._max_retries if max_retries is None else max_retries
        attempt = 0
        rekeyed = False
        while True:
            request = self._http.build_request(
                method,
                url,
                params=params,
                json=json,
                headers=await self._headers(headers),
                timeout=self._attempt_timeout(timeout, deadline),
            )
            try:
                response = await self._http.send(request)
            except httpx2.TimeoutException as exc:
                error: DfoError = client_error(
                    DEADLINE_EXCEEDED, f"{method} {url} timed out", retryable=True
                )
                error.__cause__ = exc
            except httpx2.TransportError as exc:
                error = client_error(
                    NETWORK_ERROR, f"{method} {url} failed: {exc}", retryable=True
                )
                error.__cause__ = exc
            else:
                self._note_headers(method, response)
                if response.status_code < 400:
                    return response
                if response.status_code == 401 and not rekeyed and self._keys.refresh():
                    rekeyed = True
                    continue
                error = problem_error(
                    response.status_code,
                    _json_body(response),
                    reason=response.reason_phrase,
                    origin=self._origin,
                    retry_after=retry_after(response),
                )
            wait = self._retry_wait(error, attempt, retries, deadline)
            if wait is None:
                raise error
            await self._sleep(wait)
            attempt += 1

    async def download(
        self, url: str, *, timeout: float | None = None, deadline: float | None = None
    ) -> bytes:
        """Fetch a signed storage URL with a bare request, once.

        The request carries no client header, no key and nothing from the header
        provider. A failed fetch is not retried: a signed URL can expire, so the
        caller asks the files route for a fresh one.

        Raises:
            ServerError: The storage host answered anything but 200.
            NetworkError: The connection failed, or `DFO_OFFLINE=1` is set
                (`offline`).
            DfoTimeoutError: The fetch timed out or the deadline passed.
        """
        _refuse_offline("the signed download")
        request = self._http.build_request(
            "GET", url, timeout=self._attempt_timeout(timeout, deadline)
        )
        try:
            response = await self._http.send(request)
        except httpx2.TimeoutException as exc:
            raise client_error(
                DEADLINE_EXCEEDED, "The signed download timed out", retryable=True
            ) from exc
        except httpx2.TransportError as exc:
            raise client_error(
                NETWORK_ERROR, f"The signed download failed: {exc}", retryable=True
            ) from exc
        if response.status_code != 200:
            raise client_error(
                DOWNLOAD_FAILED,
                f"The signed download answered HTTP {response.status_code}",
                status=response.status_code,
                retryable=True,
            )
        return response.content

    async def aclose(self) -> None:
        """Close the connection pool, when this transport built it."""
        if self._owner:
            await self._http.aclose()

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.aclose()
