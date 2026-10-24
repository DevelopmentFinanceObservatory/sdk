"""Decode JSON text with a nesting bound of the client's own.

`json.loads` recurses once per level of nesting, and where it gives up depends on
the platform's C stack. On some builds a body nested 100,000 levels deep raises
`RecursionError`, and on others it parses. `loads` refuses text nested deeper than
`JSON_MAX_DEPTH` before the parser sees it, so every platform refuses the same
text with a `ValueError`, which each caller already reads as text that is not
JSON.
"""

import json
import re
from collections.abc import Callable
from typing import Any

# The deepest response body recorded under contract/scenarios nests 14 levels, so
# 256 leaves over 18 times that as headroom, and stays far inside the C stack and
# the interpreter's default recursion limit of 1000.
JSON_MAX_DEPTH = 256

# A whole string, escapes included, or one bracket. A string is consumed in one
# match, so a bracket inside it is never counted.
_TOKENS = re.compile(rb'"(?:[^"\\]|\\.)*"|[\[\]{}]', re.DOTALL)
_OPENERS = frozenset({b"[", b"{"})


def too_deep(text: str | bytes, /) -> bool:
    """Whether `text` opens more than `JSON_MAX_DEPTH` arrays or objects at once."""
    if len(text) <= JSON_MAX_DEPTH:
        return False
    data = text.encode(errors="surrogatepass") if isinstance(text, str) else text
    depth = 0
    for match in _TOKENS.finditer(data):
        token = match.group()
        if token in _OPENERS:
            depth += 1
            if depth > JSON_MAX_DEPTH:
                return True
        elif len(token) == 1:
            depth -= 1
    return False


def loads(
    text: str | bytes,
    /,
    *,
    parse_constant: Callable[[str], Any] | None = None,
) -> Any:
    """`json.loads(text)`, refusing text nested deeper than `JSON_MAX_DEPTH`.

    Raises:
        ValueError: The text is not JSON, is nested too deeply, or is bytes that
            are not UTF-8.
    """
    if too_deep(text):
        raise ValueError(f"nested deeper than {JSON_MAX_DEPTH} levels")
    return json.loads(text, parse_constant=parse_constant)
