"""Checks on text the client sends or shows: keys, header values, URLs and messages.

A key holds visible ASCII only, 0x21 to 0x7E. A header value holds visible ASCII,
space and tab. A fault names the kind of character and its 1-based position, so
an error can say where a key or header breaks without quoting it. A path that
names an id holds no dot segment, so it stays under the API's base path. Server
text the client shows has the client's own key replaced by `[redacted]`.
"""

import re
from urllib.parse import unquote, urlsplit

# Characters that steer a terminal or reorder text: C0 controls but tab and line
# feed, DEL, C1 controls, and the Unicode bidirectional controls.
_UNPRINTABLE = re.compile(
    "[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]"
)
_OUTSIDE_KEY = re.compile(r"[^\x21-\x7e]")
_OUTSIDE_HEADER = re.compile(r"[^\t\x20-\x7e]")
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")


def printable(text: str, /) -> str:
    """Return `text` without the characters that steer a terminal or reorder text."""
    return _UNPRINTABLE.sub("", text)


def key_fault(value: str, /) -> str | None:
    """Where `value` leaves visible ASCII, such as `a line break at character 45`,
    or None when it holds visible ASCII only."""
    return _fault(_OUTSIDE_KEY.search(value))


def header_fault(value: str, /) -> str | None:
    """Where `value` leaves visible ASCII, space and tab, such as `a line break
    at character 12`, or None when it holds those only."""
    return _fault(_OUTSIDE_HEADER.search(value))


def _fault(found: re.Match[str] | None) -> str | None:
    if found is None:
        return None
    char = found[0]
    if char in "\r\n":
        kind = "a line break"
    elif char in " \t":
        kind = "whitespace"
    elif char > "\x7f":
        kind = "a non-ASCII character"
    else:
        kind = "a control character"
    return f"{kind} at character {found.start() + 1}"


def control_fault(value: str, /) -> str | None:
    """Where `value` holds a C0 or C1 control or DEL, tab included, such as
    `a line break at character 3`, or None when it holds none."""
    return _fault(_CONTROL.search(value))


def has_dot_segment(path: str, /) -> bool:
    """Whether a URL path holds a `.` or `..` segment, percent-encoded or not,
    which a server resolves to another path."""
    return any(unquote(segment) in {".", ".."} for segment in path.split("/"))


def redacted(text: str, key: str | None, /) -> str:
    """Return `text` with every copy of `key` replaced by `[redacted]`."""
    return text.replace(key, "[redacted]") if key else text


_DEFAULT_PORTS = {"http": 80, "https": 443}


def origin_of(url: str, /) -> str | None:
    """The origin `url` names, as `scheme://host[:port]`, or None.

    The scheme and host are lower case, the host loses a trailing dot, and the
    scheme's default port is dropped, so `https://Host.:443` and `https://host`
    share an origin. A URL with userinfo, no host or a port that does not parse
    names no origin the client sends to.
    """
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return None
    if "@" in parts.netloc or not parts.hostname:
        return None
    host = parts.hostname.rstrip(".")
    if ":" in host:
        host = f"[{host}]"
    scheme = parts.scheme.lower()
    if port is not None and port != _DEFAULT_PORTS.get(scheme):
        host = f"{host}:{port}"
    return f"{scheme}://{host}"
