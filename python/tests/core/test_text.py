"""Redaction of quoted server values, and the artifact-URL rule shared by file
routes and docs pages."""

import pytest

from dfo._core.text import quoted, same_origin_url

KEY = "dfo_k_4f8Kq2ZtR7mWx1NcB9vLp3YhD6sGa0Ue2wanxe"
ORIGIN = "https://api.example.org"


def test_a_quoted_value_has_the_key_redacted_before_repr_escapes_it() -> None:
    # `repr` writes the zero-width space as an escape, which would hide the key.
    split = KEY[:12] + "\u200b" + KEY[12:]
    assert quoted({"status": [split]}, KEY) == "{'status': ['[redacted]']}"


@pytest.mark.parametrize(
    ("reference", "resolved"),
    [
        ("/api/x", f"{ORIGIN}/api/x"),
        ("/", f"{ORIGIN}/"),
        ("/api/x?a=../..", f"{ORIGIN}/api/x?a=../.."),
        ("/api/x#/../..", f"{ORIGIN}/api/x#/../.."),
        ("https://api.example.org/api/x", f"{ORIGIN}/api/x"),
        ("HTTPS://API.Example.ORG/api/x", f"{ORIGIN}/api/x"),
        ("https://api.example.org:443/api/x", f"{ORIGIN}/api/x"),
        ("https://api.example.org:0443/api/x", f"{ORIGIN}/api/x"),
        ("https://api.example.org:/api/x", f"{ORIGIN}/api/x"),
        ("https://api.example.org", f"{ORIGIN}/"),
        ("https://api.example.org?x=1", f"{ORIGIN}/?x=1"),
        ("https://api.example.org//evil.example/x", f"{ORIGIN}//evil.example/x"),
        ("https://u:p@api.example.org/x", None),
        ("https://@api.example.org/x", None),
        ("https://api%2Eexample.org/x", None),
        ("https://api.example.org\\@evil.example/x", None),
        ("https://api.example.org./x", None),
        ("https://\uff41pi.example.org/x", None),
        ("https://api.example.org:8443/x", None),
        ("https://api.example.org:99999/x", None),
        ("https://api.example.org:44a/x", None),
        ("http://api.example.org/x", None),
        ("https://files.example.net/x", None),
        ("//api.example.org/x", None),
        ("/\\evil.example/x", None),
        ("\\\\evil.example/x", None),
        ("https:x", None),
        ("https:/x", None),
        ("https:../admin", None),
        ("x/y", None),
        ("../x", None),
        ("javascript:alert(1)", None),
        ("/api/../../admin/x", None),
        ("/api/./x", None),
        ("/api/%2e%2e/x", None),
        ("/api/.%2E/x", None),
        ("/api\\..\\x", None),
        ("/api/%2e%2e%2f/x", None),
        ("/api/..%2Fx", None),
        ("/api/..%5cx", None),
        ("/api/.%5Cx", None),
        ("https://api.example.org/api/../x", None),
        ("/api/x\r\nHost: evil", None),
        ("/api/\x1b[2J", None),
    ],
    ids=[
        "path",
        "root",
        "dots-in-query",
        "dots-in-fragment",
        "absolute",
        "upper-case",
        "default-port",
        "default-port-leading-zero",
        "empty-port",
        "empty-path",
        "query-only",
        "double-slash-path",
        "userinfo",
        "empty-userinfo",
        "percent-in-host",
        "backslash-in-authority",
        "trailing-dot-host",
        "fullwidth-host",
        "other-port",
        "port-out-of-range",
        "port-not-a-number",
        "other-scheme",
        "other-host",
        "scheme-relative",
        "slash-backslash",
        "backslashes",
        "scheme-colon-path",
        "scheme-colon-slash",
        "scheme-colon-dots",
        "relative",
        "relative-dots",
        "javascript",
        "dot-segments",
        "dot-segment",
        "encoded-dot-segment",
        "mixed-encoded-dot-segment",
        "backslash-dot-segment",
        "encoded-slash-after-dots",
        "upper-encoded-slash",
        "encoded-backslash",
        "upper-encoded-backslash",
        "absolute-dot-segment",
        "line-break",
        "escape",
    ],
)
def test_a_server_url_resolves_on_the_api_origin_by_one_rule(
    reference: str, resolved: str | None
) -> None:
    assert same_origin_url(reference, ORIGIN) == resolved


def test_a_port_the_origin_names_is_part_of_it() -> None:
    origin = "http://localhost:8080"
    assert same_origin_url("http://LOCALHOST:8080/x", origin) == f"{origin}/x"
    assert same_origin_url("http://localhost/x", origin) is None
    loopback = "http://[::1]:8080"
    assert same_origin_url("http://[0:0::1]:8080/x", loopback) == f"{loopback}/x"
    assert same_origin_url("http://[::2]:8080/x", loopback) is None
    assert same_origin_url("http://[::1/x", loopback) is None
