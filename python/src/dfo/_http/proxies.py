"""The parts of the HTTP transport that name no async or sync flavour.

`dfo._http.transport` is the async source that `scripts/gen_sync.py` copies into
its sync twin, and both import this module, so none of it is copied. It holds the
pool limits, the mapping from httpcore2's errors to httpx2's, the conversion of
an httpx2 URL to an httpcore2 one, and the reading of the proxy environment
into httpx2 mount patterns.
"""

import ipaddress
from collections.abc import Generator, Mapping
from contextlib import contextmanager
from urllib.request import getproxies

import httpcore2
import httpx2

# The pool limits httpx2 gives its own transport: 100 connections, 20 kept
# alive for 5 s each.
MAX_CONNECTIONS = 100
MAX_KEEPALIVE_CONNECTIONS = 20
KEEPALIVE_EXPIRY_S = 5.0

# Each httpcore2 error and the httpx2 error it raises as, the more specific
# class before the one it derives from.
HTTPCORE_ERRORS: tuple[tuple[type[Exception], type[httpx2.HTTPError]], ...] = (
    (httpcore2.ConnectTimeout, httpx2.ConnectTimeout),
    (httpcore2.ReadTimeout, httpx2.ReadTimeout),
    (httpcore2.WriteTimeout, httpx2.WriteTimeout),
    (httpcore2.PoolTimeout, httpx2.PoolTimeout),
    (httpcore2.TimeoutException, httpx2.TimeoutException),
    (httpcore2.ConnectError, httpx2.ConnectError),
    (httpcore2.ReadError, httpx2.ReadError),
    (httpcore2.WriteError, httpx2.WriteError),
    (httpcore2.NetworkError, httpx2.NetworkError),
    (httpcore2.ProxyError, httpx2.ProxyError),
    (httpcore2.UnsupportedProtocol, httpx2.UnsupportedProtocol),
    (httpcore2.LocalProtocolError, httpx2.LocalProtocolError),
    (httpcore2.RemoteProtocolError, httpx2.RemoteProtocolError),
    (httpcore2.ProtocolError, httpx2.ProtocolError),
)


@contextmanager
def httpx_errors() -> Generator[None]:
    """Raise an httpcore2 error from inside the block as its httpx2 class.

    Only `Exception` is caught, so cancellation passes through unchanged.
    """
    try:
        yield
    except Exception as exc:
        for source, target in HTTPCORE_ERRORS:
            if isinstance(exc, source):
                raise target(str(exc)) from exc
        raise


def core_url(url: httpx2.URL) -> httpcore2.URL:
    return httpcore2.URL(
        scheme=url.raw_scheme, host=url.raw_host, port=url.port, target=url.raw_path
    )


def no_proxy_pattern(host: str) -> str | None:
    """The httpx2 mount pattern that exempts the `NO_PROXY` entry `host` from the
    proxies, or None for an entry with no pattern, following httpx2's `NO_PROXY`
    mapping.

    `.example.org` maps to `all://*.example.org`, which matches the names under
    example.org but not example.org itself, and `example.org` to
    `all://*example.org`. An IPv4 or IPv6 address or network maps to itself and
    a URL pattern to itself. An entry that maps to no pattern, such as
    `example.org/path`, is skipped. An entry that maps to a pattern httpx2
    cannot read, such as `10.0.0.0/99`, is dropped by `environment_proxies`.
    """
    address, slash, prefix = host.partition("/")
    try:
        version = ipaddress.ip_address(address).version
    except ValueError:
        version = None
    if "://" in host:
        return host
    if version == 4 or host.lower() == "localhost" or host.startswith("["):
        return f"all://{host}"
    if version == 6:
        return f"all://[{address}]{slash}{prefix}"
    return f"all://*{host}" if host and "/" not in host else None


def _mountable(patterns: list[str]) -> list[str]:
    """The patterns httpx2 takes as mount patterns.

    One client built over all of them answers in the usual case. When it
    refuses, the patterns are tried one by one to find the unreadable ones.
    """

    def accepted(group: list[str]) -> bool:
        try:
            # A transport passed in keeps the client from reading the environment.
            httpx2.AsyncClient(
                transport=httpx2.AsyncBaseTransport(),
                mounts=dict.fromkeys(group),
            )
        except (httpx2.InvalidURL, ValueError):
            return False
        return True

    if accepted(patterns):
        return patterns
    return [pattern for pattern in patterns if accepted([pattern])]


def environment_proxies(
    proxies: Mapping[str, str] | None = None,
) -> dict[str, str | None]:
    """The proxy URL for each httpx2 mount pattern, None for a host `NO_PROXY`
    exempts.

    The proxies come from `proxies`, by default `urllib.request.getproxies()`:
    the `*_PROXY` variables, or on macOS and Windows the system settings. The
    http, https and all proxies mount on their scheme, with `http://` before a
    URL that names no scheme. `NO_PROXY=*` turns every proxy off, and each
    other entry mounts as `no_proxy_pattern` says. An entry httpx2 cannot read
    as a pattern is skipped, as curl and Go skip it.
    """
    found = getproxies() if proxies is None else proxies
    mounts: dict[str, str | None] = {}
    for scheme in ("http", "https", "all"):
        if url := found.get(scheme):
            mounts[f"{scheme}://"] = url if "://" in url else f"http://{url}"
    for entry in found.get("no", "").split(","):
        host = entry.strip()
        if host == "*":
            return {}
        if (pattern := no_proxy_pattern(host)) is not None:
            mounts[pattern] = None
    readable = set(_mountable(list(mounts)))
    return {pattern: url for pattern, url in mounts.items() if pattern in readable}
