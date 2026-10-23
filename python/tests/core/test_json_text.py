"""The client's own bound on JSON nesting, independent of the C stack."""

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
    ],
    ids=[
        "array-at-the-bound",
        "bytes-at-the-bound",
        "object-at-the-bound",
        "brackets-in-a-string",
        "brackets-after-an-escaped-quote",
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
    ],
    ids=["array", "bytes", "object"],
)
def test_text_one_level_past_the_depth_bound_is_refused(text: str | bytes) -> None:
    with pytest.raises(ValueError):
        loads(text)
