"""The answer format: an answer as JSON, which `answer.to_json()` writes and
`Answer.from_json` reads, the same in every DFO client.

An answer to a question in words is `{"format_version": 1, "question": ...,
"answer": ...}`. An answer to a search by codes is `{"format_version": 2, ...}`
with `"codes": [...]` beside the same members, so a reader that knows only
format 1 refuses it. `question` is the question asked, or null. `answer` is the
Search response body cut to the members a client reads, which `KEPT` lists, with
the answer's trace id as its `trace_id` when it has one. `codes` holds the series
code each part was asked by, one per part in part order, read as
`search(codes=...)` reads them, so an answer read back checks each reading
against the code the caller asked for. The cut drops what no read rule names,
such as each spec's `resolved.trace` and slots, the sentence-plan tokens'
references, part timings, and the diagnostics beyond `timed_out` and `warnings`.
A member the cut keeps holds the value the response held, malformed or not, so
the body reads back as the response read.
"""

from collections.abc import Mapping, Sequence
from typing import Any, Final, Literal

from dfo._core.base_error import message_of
from dfo._core.errors import InvalidRequestError
from dfo._core.text import is_token
from dfo._core.types import FormatError, check_keys, decode, is_integer
from dfo._search.structured import checked_codes

FORMAT_VERSION: Final = 1
# The format of an answer to a search by codes, which holds `codes`.
CODES_FORMAT_VERSION: Final = 2

# The members a cut keeps under one object: True keeps the member's value whole,
# and a nested table keeps only its members, of the object the member holds or of
# each object item of the array it holds.
type Kept = Mapping[str, Literal[True] | Kept]

_SPEC: Kept = {
    "spec_id": True,
    "definition": True,
    "resolved": {
        "rendered_sentence": True,
        "entity_groups": True,
        "unit_conversion": True,
        "stat_vars": {"source_codes": True},
        "sentence_plan": {"segment": True, "kind": True, "axis": True, "text": True},
        "facets": {"provenance": {"label": True}},
    },
}

_PART: Kept = {
    "status": True,
    "variable_text": True,
    "rendered_sentence": True,
    "separate": True,
    "restatement": True,
    "operations": True,
    "assumptions": True,
    "reading_assumptions": True,
    "departures": True,
    "warnings": True,
    "spec": _SPEC,
    "candidates": {"specs": _SPEC, "ordering": True, "truncated": True},
    "no_data": {
        "reason": True,
        "message": True,
        "options": {"label": True, "mentions": True, "data_query": True},
    },
    "unsupported": {"code": True, "detail": True},
}

# The members of a Search response body that a client reads.
KEPT: Final[Kept] = {
    "kind": True,
    "status": True,
    "rendered_sentence": True,
    "reason": True,
    "parts": _PART,
    "diagnostics": {"timed_out": True, "warnings": True},
}

_MEMBERS = ("format_version", "question", "answer")
_CODES = "codes"


def cut(value: object, kept: Kept, /) -> object:
    """`value` with only the members `kept` names: an object's, or each object
    item's of an array. Any other value stays as it is."""
    if isinstance(value, list):
        return [cut(item, kept) for item in value]
    if not isinstance(value, Mapping):
        return value
    out: dict[str, Any] = {}
    for member, child in value.items():
        rule = kept.get(member)
        if rule is None:
            continue
        out[member] = child if rule is True else cut(child, rule)
    return out


def answer_json(
    question: str | None,
    body: Mapping[str, Any],
    trace_id: str | None,
    codes: Sequence[str] | None,
    /,
) -> dict[str, Any]:
    """A Search response body in the answer format, its trace id `trace_id`, and
    `codes` the series code each part was asked by, or None for a question in
    words."""
    answer = cut(body, KEPT)
    assert isinstance(answer, dict)
    if trace_id is not None:
        answer["trace_id"] = trace_id
    if codes is None:
        return {
            "format_version": FORMAT_VERSION,
            "question": question,
            "answer": answer,
        }
    return {
        "format_version": CODES_FORMAT_VERSION,
        "question": question,
        "answer": answer,
        _CODES: list(codes),
    }


def read_answer_json(
    text: str | bytes, /
) -> tuple[str | None, Mapping[str, Any], str | None, tuple[str, ...] | None]:
    """The question, the body, its trace id and the codes its parts were asked by,
    from text in the answer format. The codes are None when the text holds none.

    The body is not checked here; the caller reads it as a Search response.

    Raises:
        FormatError: The text is not JSON or not an object, lacks a member of the
            format or holds another, its `format_version` is not 1 or 2, it
            holds `codes` at format 1 or lacks them at format 2, its `question`
            is not a string or null, its `answer` is not an object, or its
            `codes` break the rule `search(codes=...)` holds them to or do not
            hold one code per part of the answer (`format_invalid`).
    """
    obj = decode(text)
    check_keys(obj, "", required=_MEMBERS, allowed=(_CODES,))
    version = obj["format_version"]
    if not is_integer(version) or version not in (FORMAT_VERSION, CODES_FORMAT_VERSION):
        raise FormatError(
            "format_invalid",
            "/format_version",
            f"not {FORMAT_VERSION} or {CODES_FORMAT_VERSION}",
        )
    if version == CODES_FORMAT_VERSION and _CODES not in obj:
        raise FormatError("format_invalid", f"/{_CODES}", "missing")
    if version == FORMAT_VERSION and _CODES in obj:
        raise FormatError(
            "format_invalid", f"/{_CODES}", f"not in format {FORMAT_VERSION}"
        )
    question = obj["question"]
    if question is not None and not isinstance(question, str):
        raise FormatError("format_invalid", "/question", "not a string or null")
    body = obj["answer"]
    if not isinstance(body, dict):
        raise FormatError("format_invalid", "/answer", "not an object")
    trace_id = body.get("trace_id")
    if not isinstance(trace_id, str) or not is_token(trace_id):
        trace_id = None
    codes = _read_codes(obj[_CODES], body) if _CODES in obj else None
    return question, body, trace_id, codes


def _read_codes(value: object, body: Mapping[str, Any]) -> tuple[str, ...]:
    """The `codes` member, read as `search(codes=...)` reads codes, one per part
    of `body`."""
    pointer = f"/{_CODES}"
    try:
        codes = checked_codes(value)
    except InvalidRequestError as error:
        raise FormatError("format_invalid", pointer, message_of(error)) from error
    parts = body.get("parts")
    count = len(parts) if isinstance(parts, list) else 0
    if count != len(codes):
        raise FormatError(
            "format_invalid",
            pointer,
            f"holds {len(codes)} codes for {count} parts; it holds one per part",
        )
    return tuple(codes)
