"""Checks on text the client sends or shows: keys, header values, URLs and messages.

A key holds visible ASCII only, 0x21 to 0x7E. A header value holds visible ASCII,
space and tab. A fault names the kind of character and its 1-based position, so
an error can say where a key or header breaks without quoting it. A path that
names an id holds no dot segment, so it stays under the API's base path. Server
text the client shows has the client's own key replaced by `[redacted]`, and a
client message quotes at most `MESSAGE_TEXT_MAX` characters of it.
"""

import ipaddress
import json
import re
import unicodedata
from typing import Any
from urllib.parse import unquote, urlsplit

# The most characters of server text a message quotes. A refusal's `detail`
# keeps the whole text.
MESSAGE_TEXT_MAX = 1000

# The only characters `printable` can drop lie outside visible ASCII, space, tab
# and line feed. Their Unicode category decides.
_MAYBE_UNPRINTABLE = re.compile(r"[^\t\n\x20-\x7e]")
# Controls (C0, DEL and C1) and format characters, such as the zero-width space,
# the byte order mark, the soft hyphen and the bidirectional controls.
_UNPRINTABLE_CATEGORIES = frozenset({"Cc", "Cf"})
_LINE_BREAKS = str.maketrans("\t\n", "  ")
# The Default_Ignorable_Code_Point ranges of DerivedCoreProperties.txt, Unicode
# 17.0, which draw nothing whatever their category, such as the combining
# grapheme joiner, the variation selectors and the Hangul fillers.
# `unicodedata` does not expose the property, so the table holds it.
_DEFAULT_IGNORABLE_RANGES = (
    (0x00AD, 0x00AD),
    (0x034F, 0x034F),
    (0x061C, 0x061C),
    (0x115F, 0x1160),
    (0x17B4, 0x17B5),
    (0x180B, 0x180F),
    (0x200B, 0x200F),
    (0x202A, 0x202E),
    (0x2060, 0x206F),
    (0x3164, 0x3164),
    (0xFE00, 0xFE0F),
    (0xFEFF, 0xFEFF),
    (0xFFA0, 0xFFA0),
    (0xFFF0, 0xFFF8),
    (0x1BCA0, 0x1BCA3),
    (0x1D173, 0x1D17A),
    (0xE0000, 0xE0FFF),
)
_DEFAULT_IGNORABLE = re.compile(
    "["
    + "".join(f"{chr(first)}-{chr(last)}" for first, last in _DEFAULT_IGNORABLE_RANGES)
    + "]"
)
_OUTSIDE_KEY = re.compile(r"[^\x21-\x7e]")
_OUTSIDE_HEADER = re.compile(r"[^\t\x20-\x7e]")
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")
# A slash or backslash, raw or percent-encoded in either case.
_SEGMENT_SEPARATOR = re.compile(r"[/\\]|%2[fF]|%5[cC]")
_TOKEN = re.compile(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+")


def printable(text: str, /) -> str:
    """Return `text` without the characters that steer a terminal, reorder text
    or draw nothing: every Unicode control but tab and line feed, every format
    character, and every default-ignorable code point."""
    return _MAYBE_UNPRINTABLE.sub(_drop_unprintable, text)


def single_line(text: str, /) -> str:
    """Return `printable(text)` with each tab and line feed turned into a space,
    for a label or a line of a repr that server text must not break or steer."""
    return printable(text).translate(_LINE_BREAKS)


def _drop_unprintable(found: re.Match[str]) -> str:
    char = found[0]
    if unicodedata.category(char) in _UNPRINTABLE_CATEGORIES:
        return ""
    return "" if _DEFAULT_IGNORABLE.fullmatch(char) else char


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
    between slashes or backslashes, raw or percent-encoded, which a server
    resolves to another path."""
    segments = _SEGMENT_SEPARATOR.split(path)
    return any(unquote(segment) in {".", ".."} for segment in segments)


def redacted(text: str, key: str | None, /) -> str:
    """Return `text` with every copy of `key` replaced by `[redacted]`.

    A copy with characters inside it that `printable` drops counts too, since
    the text shown would join it back into the key. Text holding such a copy
    comes back as `printable` gives it, with the copy replaced. Tab and line
    feed are visible whitespace that `printable` keeps, so a key split by them
    shows as two pieces and stays as it is. Redaction catches the copies the
    text would display as the key.
    """
    if not key:
        return text
    text = text.replace(key, "[redacted]")
    shown = printable(text)
    return shown.replace(key, "[redacted]") if key in shown else text


def capped(text: str, /) -> str:
    """`text` cut to `MESSAGE_TEXT_MAX` characters, marked with an ellipsis when cut."""
    if len(text) <= MESSAGE_TEXT_MAX:
        return text
    return text[:MESSAGE_TEXT_MAX] + "…"


def cited(value: object, /) -> str:
    """How a message quotes a caller's value: a string in double quotes, as JSON
    writes it, so `"congo [drc]"` reads the same in both clients; anything else as
    Python writes it, such as `(0, 3000)`."""
    return (
        json.dumps(value, ensure_ascii=False) if isinstance(value, str) else repr(value)
    )


def redacted_json(value: Any, key: str | None, /) -> Any:
    """A copy of decoded JSON `value` with `key` redacted, as `redacted` does, in
    every string and member name at any depth. `value` itself when `key` is
    None or empty."""
    if not key:
        return value
    if isinstance(value, str):
        return redacted(value, key)
    if not isinstance(value, dict | list):
        return value
    top = _redacted_copy(value, key)
    pending = [top]
    while pending:
        container = pending.pop()
        slots = (
            list(container.items())
            if isinstance(container, dict)
            else list(enumerate(container))
        )
        for slot, item in slots:
            if isinstance(item, str):
                container[slot] = redacted(item, key)
            elif isinstance(item, dict | list):
                container[slot] = inner = _redacted_copy(item, key)
                pending.append(inner)
    return top


def _redacted_copy(container: dict[Any, Any] | list[Any], key: str) -> Any:
    """A shallow copy of `container`, with `key` redacted in a dict's names."""
    if isinstance(container, dict):
        return {redacted(name, key): item for name, item in container.items()}
    return list(container)


def quoted(value: object, key: str | None, /) -> str:
    """A value the server sent, as a client message quotes it. That is its `repr`,
    with `key` redacted and cut to `MESSAGE_TEXT_MAX` characters. The value is
    redacted before `repr` escapes any of the key's characters."""
    return capped(repr(redacted_json(value, key)))


def is_token(value: str, /) -> bool:
    """Whether `value` is an HTTP token: one or more ASCII letters, digits or
    !#$%&'*+-.^_`|~, the characters a header name or a trace id holds."""
    return _TOKEN.fullmatch(value) is not None


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
        host = f"[{_ipv6(host) or host}]"
    scheme = parts.scheme.lower()
    if port is not None and port != _DEFAULT_PORTS.get(scheme):
        host = f"{host}:{port}"
    return f"{scheme}://{host}"


# An absolute http or https URL: its scheme, its authority up to the first `/`,
# `?` or `#`, and the rest.
_ABSOLUTE_URL = re.compile(r"(https?)://([^/?#]*)(.*)", re.IGNORECASE | re.DOTALL)
_PORT = re.compile(r"[0-9]*")


def same_origin_url(reference: str, origin: str, /) -> str | None:
    """The absolute URL a URL the server named resolves to on `origin`, or None.

    The rule reads the text as written. A reference holding a control character
    is refused. One that starts with exactly one `/`, not followed by `/` or
    `\\`, is a path on `origin`. An `http://` or `https://` URL is accepted
    when its authority, up to the first `/`, `?` or `#`, holds no `@`, `%` or
    `\\`, its scheme and ASCII host match `origin` in any case, with no
    trailing dot and an IPv6 address compared as an address, its port, leading
    zeros dropped, is absent, empty or the scheme's default when `origin` names
    none, and its path is empty or starts with `/`. Either form is refused when
    its path, up to `?` or `#`, holds a dot segment as `has_dot_segment` reads
    it. Any other reference is refused, a scheme-relative `//host`, a relative
    `x/y`, `https:x` and a backslash form among them.

    Args:
        reference: The URL the server named.
        origin: The API's origin, as `origin_of` gives it.
    """
    if control_fault(reference) is not None:
        return None
    if reference.startswith("/"):
        if reference[1:2] in {"/", "\\"}:
            return None
        rest = reference
    elif found := _ABSOLUTE_URL.fullmatch(reference):
        scheme, authority, rest = found.groups()
        if _authority_origin(scheme, authority) != origin:
            return None
    else:
        return None
    if has_dot_segment(re.split(r"[?#]", rest, maxsplit=1)[0]):
        return None
    return origin + (rest if rest.startswith("/") else "/" + rest)


def _authority_origin(scheme: str, authority: str) -> str | None:
    """The origin `scheme://authority` names, as `origin_of` writes one, or None
    when the authority holds `@`, `%`, `\\` or a character outside ASCII, names
    no host, or gives a port that is not a number up to 65535."""
    if not authority.isascii() or any(char in authority for char in "@%\\"):
        return None
    if authority.startswith("["):
        literal, bracket, port = authority[1:].partition("]")
        if not bracket or (port and not port.startswith(":")):
            return None
        if (address := _ipv6(literal)) is None:
            return None
        host, port = f"[{address}]", port[1:]
    else:
        host, _, port = authority.partition(":")
    if not host or not _PORT.fullmatch(port):
        return None
    scheme = scheme.lower()
    number = int(port) if port else _DEFAULT_PORTS[scheme]
    if number > 65535:
        return None
    suffix = "" if number == _DEFAULT_PORTS[scheme] else f":{number}"
    return f"{scheme}://{host.lower()}{suffix}"


def _ipv6(literal: str) -> str | None:
    """An IPv6 address in its compressed form, so that two spellings of one
    address name one origin, or None when `literal` is not one."""
    try:
        return ipaddress.IPv6Address(literal).compressed
    except ValueError:
        return None
