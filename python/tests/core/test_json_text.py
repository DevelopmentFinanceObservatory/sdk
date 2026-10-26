"""The client's own bound on JSON nesting, independent of the C stack, and the UTF-8
JSON it reads."""

import time

import pytest

from dfo._core.json_text import JSON_MAX_DEPTH, loads

AT = JSON_MAX_DEPTH
PAST = JSON_MAX_DEPTH + 1


@pytest.mark.parametrize(
    "text",
    [
        "[" * AT + "]" * AT,
        b"[" * AT + b"]" * AT,
        '{"a":' * (AT - 1) + "{}" + "}" * (AT - 1),
        '["' + "[" * PAST + '"]',
        '["\\"' + "{" * PAST + '"]',
        b"\xef\xbb\xbf" + b"[" * AT + b"]" * AT,
    ],
    ids=[
        "array-at-the-bound",
        "bytes-at-the-bound",
        "object-at-the-bound",
        "brackets-in-a-string",
        "brackets-after-an-escaped-quote",
        "bytes-after-a-byte-order-mark",
    ],
)
def test_text_within_the_depth_bound_parses(text: str | bytes) -> None:
    loads(text)


@pytest.mark.parametrize(
    "text",
    [
        "[" * PAST + "]" * PAST,
        b"[" * PAST + b"]" * PAST,
        '{"a":' * AT + "{}" + "}" * AT,
        # In UTF-16 or UTF-32 an escaped quote would hide the brackets after it
        # from a scan of the bytes.
        ('["\\"",' + "[" * PAST + "]" * PAST + "]").encode("utf-16-le"),
        ('["\\"",' + "[" * PAST + "]" * PAST + "]").encode("utf-32"),
        "[NaN]",
        '{"a": Infinity}',
        b"[-Infinity]",
    ],
    ids=[
        "array",
        "bytes",
        "object",
        "utf-16",
        "utf-32",
        "nan",
        "infinity",
        "negative-infinity",
    ],
)
def test_text_past_the_depth_bound_or_outside_utf8_json_is_refused(
    text: str | bytes,
) -> None:
    with pytest.raises(ValueError):
        loads(text)


def test_an_unclosed_string_of_escaped_quotes_is_scanned_in_linear_time() -> None:
    # A scan that tries a string at each quote takes minutes on these 300 KB.
    text = '"' + '\\"' * 150_000
    start = time.perf_counter()
    with pytest.raises(ValueError):
        loads(text)
    assert time.perf_counter() - start < 1
