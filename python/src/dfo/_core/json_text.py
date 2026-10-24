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
from itertools import accumulate
from typing import Any

# The deepest response body recorded under contract/scenarios nests 14 levels, so
# 256 leaves over 18 times that as headroom, and stays far inside the C stack and
# the interpreter's default recursion limit of 1000.
JSON_MAX_DEPTH = 256

# The scan drops every escape, then every byte but quotes and brackets, which
# leaves each string as the brackets it holds between two quotes. Two adjacent
# quotes enclose nothing, so dropping them first leaves the strings to remove
# few. A string with no closing quote runs to the end of the text. Each step is
# one pass over its input, so the scan is linear on any text.
_ESCAPE = re.compile(rb"\\.", re.DOTALL)
_NOT_QUOTE_OR_BRACKET = bytes(range(256)).translate(None, b'"[]{}')
_STRING = re.compile(rb'"[^"]*"?')
_STEP = {ord("["): 1, ord("{"): 1, ord("]"): -1, ord("}"): -1}


def too_deep(text: str | bytes, /) -> bool:
    """Whether `text` opens more than `JSON_MAX_DEPTH` arrays or objects at once."""
    if len(text) <= JSON_MAX_DEPTH:
        return False
    data = text.encode(errors="surrogatepass") if isinstance(text, str) else text
    quoted = _ESCAPE.sub(b"", data).translate(None, _NOT_QUOTE_OR_BRACKET)
    brackets = _STRING.sub(b"", quoted.replace(b'""', b""))
    return max(accumulate(map(_STEP.__getitem__, brackets)), default=0) > JSON_MAX_DEPTH


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
