"""Tests for the proxy mounts the transport reads from the environment."""

import pytest

from dfo._http.proxies import environment_proxies

PROXY = "http://proxy.example.net:3128"


@pytest.mark.parametrize(
    ("no_proxy", "pattern"),
    [
        (".example.org", "all://*.example.org"),
        ("example.org", "all://*example.org"),
        ("192.168.1.10", "all://192.168.1.10"),
        ("10.0.0.0/8", "all://10.0.0.0/8"),
        ("::1", "all://[::1]"),
        ("fd00::/8", "all://[fd00::]/8"),
        ("[::1]", "all://[::1]"),
        ("localhost", "all://localhost"),
        ("LOCALHOST", "all://LOCALHOST"),
        ("https://internal.example.org", "https://internal.example.org"),
        # Entries httpx2 cannot read as a pattern, and blanks, mount nothing.
        ("10.0.0.0/99", None),
        ("proxy.example.org:port", None),
        ("example.org/path", None),
        (" ", None),
    ],
)
def test_each_no_proxy_entry_mounts_its_pattern(
    no_proxy: str, pattern: str | None
) -> None:
    mounts = environment_proxies({"http": PROXY, "no": f"{no_proxy},"})
    expected = (
        {"http://": PROXY} if pattern is None else {"http://": PROXY, pattern: None}
    )
    assert mounts == expected


def test_no_proxy_star_turns_every_proxy_off() -> None:
    proxies = {"http": PROXY, "https": PROXY, "no": "example.org, *"}
    assert environment_proxies(proxies) == {}


def test_each_scheme_mounts_its_proxy_with_http_when_it_names_none() -> None:
    proxies = {"http": "proxy:3128", "https": PROXY, "all": "socks5://s:1080"}
    assert environment_proxies(proxies) == {
        "http://": "http://proxy:3128",
        "https://": PROXY,
        "all://": "socks5://s:1080",
    }
