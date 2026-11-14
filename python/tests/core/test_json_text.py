"""The client's own bound on JSON nesting, independent of the C stack, the UTF-8
JSON it reads, and the RFC 8785 (JCS) text it orders objects by."""

import time

import pytest

from dfo._core.json_text import JSON_MAX_DEPTH, jcs_text, loads

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


# RFC 8785's own examples, section 3.2.2.3 for numbers and 3.2.3 for member order,
# where a name outside the Basic Multilingual Plane sorts by its UTF-16 surrogates.
@pytest.mark.parametrize(
    ("value", "text"),
    [
        (0.0, "0"),
        (-0.0, "0"),
        (1e21, "1e+21"),
        (1e20, "100000000000000000000"),
        (1e-7, "1e-7"),
        (0.000001, "0.000001"),
        (4.50, "4.5"),
        (2e-3, "0.002"),
        (333333333.33333329, "333333333.3333333"),
        (-5e-324, "-5e-324"),
        (2021, "2021"),
        (
            {"\u20ac": 1, "\U0001f600": 2, "\ufb33": 3, "a": [True, None, "\n"]},
            '{"a":[true,null,"\\n"],"\u20ac":1,"\U0001f600":2,"\ufb33":3}',
        ),
    ],
)
def test_jcs_text_writes_rfc_8785_canonical_json(value: object, text: str) -> None:
    assert jcs_text(value) == text


@pytest.mark.parametrize("value", [float("nan"), float("inf"), 10**400, {1: 2}, b""])
def test_jcs_text_refuses_what_json_has_no_form_for(value: object) -> None:
    with pytest.raises(ValueError):
        jcs_text(value)
