"""How an answer reads: its text, its notebook HTML and its incomplete-answer message.

The functions read an answer's public members, so the async and sync answers share
them. Every server string in the HTML is escaped.
"""

import html
import importlib
import json
import os
import sys
from collections.abc import Generator, Sequence
from contextlib import contextmanager
from typing import Any, Protocol

from dfo._types import Candidate, CandidatesPart, DefinitePart, Gap, Notice, Part

_SHOWN_SEVERITIES = frozenset({"warn", "degraded"})

_DECLINED_REASONS = {
    "out_of_scope": (
        "Search declined the question: it asks for no published statistic about a "
        "place, a population or a financial flow."
    ),
    "requires_analysis": (
        "Search declined the question: it asks for an argument and names no data "
        "to show."
    ),
}
_CATALOGUE = (
    "Search answered with the catalogue: the question asks what DFO holds and names "
    "no indicator."
)


class AnswerView(Protocol):
    """The members of an answer the display reads."""

    @property
    def kind(self) -> str: ...
    @property
    def sentence(self) -> str | None: ...
    @property
    def reason(self) -> str | None: ...
    @property
    def parts(self) -> tuple[Part, ...]: ...
    @property
    def gaps(self) -> tuple[Gap, ...]: ...
    @property
    def complete(self) -> bool: ...
    @property
    def warnings(self) -> tuple[Notice, ...]: ...


def hints(answer: AnswerView, /, *, departures: bool) -> list[tuple[str, str]]:
    """How the answered parts differ from the question, as `(code, line)` pairs.

    Lists each computation Search did not run, each `warn` and `degraded` warning
    of the answer and its answered parts and, with `departures`, each departure.
    Search's sentence already closes with the departures, so the display leaves
    them out. `info` warnings stay hidden.
    """
    found: dict[str, str] = {}
    for part in answer.parts:
        if not isinstance(part, DefinitePart):
            continue
        for operation in part.operations:
            found.setdefault(
                f"Not done: {operation.verb} ({_quote(operation.phrase)})",
                operation.verb,
            )
        if departures:
            for departure in part.departures:
                found.setdefault(departure.text, departure.code)
        _add_notices(found, part.warnings)
    _add_notices(found, answer.warnings)
    return [(code, line) for line, code in found.items()]


def answer_text(answer: AnswerView, /) -> str:
    """The answer as a reader sees it: the sentence, or what is missing."""
    if answer.kind != "resolution":
        return declined_text(answer.kind, answer.reason)
    if answer.complete:
        lines = [line for _, line in hints(answer, departures=False)]
        return "\n".join([answer.sentence or "", *(f"  {line}" for line in lines)])
    return "\n".join([_answered(answer, lead="Answered"), *_gap_lines(answer)])


def answer_html(answer: AnswerView, /) -> str:
    """The answer for a notebook, with every server string escaped."""
    head, _, rest = answer_text(answer).partition("\n")
    body = f"<pre>{html.escape(rest)}</pre>" if rest else ""
    return f'<div class="dfo-answer"><p>{html.escape(head)}</p>{body}</div>'


def declined_text(kind: str, reason: str | None, /) -> str:
    """Why Search gave a declined or catalogue answer instead of readings."""
    if kind == "catalogue":
        return _CATALOGUE
    if kind == "declined":
        return _DECLINED_REASONS.get(
            reason or "",
            f"Search declined the question ({reason or 'no reason given'}).",
        )
    return f"Search answered with kind {kind!r}, which holds no readings."


def incomplete_message(answer: AnswerView, /) -> str:
    """The `IncompleteAnswerError` message: every gap and the line that settles it."""
    return "\n".join([_answered(answer, lead="Search answered"), *_gap_lines(answer)])


@contextmanager
def search_status(question: str, /) -> Generator[None]:
    """Show one status line while Search runs in a notebook, and clear it after.

    Outside a notebook, or with `DFO_PROGRESS=0`, it shows nothing.
    """
    display = _notebook_display()
    if display is None:
        yield
        return
    handle = display(
        {"text/plain": f"Searching DFO: {question}"}, raw=True, display_id=True
    )
    try:
        yield
    finally:
        handle.update({"text/plain": ""}, raw=True)


def _notebook_display() -> Any:
    if os.environ.get("DFO_PROGRESS") == "0" or "ipykernel" not in sys.modules:
        return None
    ipython = sys.modules.get("IPython")
    shell = ipython.get_ipython() if ipython is not None else None
    if shell is None or not hasattr(shell, "kernel"):
        return None
    return importlib.import_module("IPython.display").display


def _add_notices(found: dict[str, str], notices: Sequence[Notice]) -> None:
    for notice in notices:
        if notice.severity in _SHOWN_SEVERITIES and notice.message:
            found.setdefault(f"Note: {notice.message}", notice.code)


def _quote(text: str | None) -> str:
    return json.dumps(text or "", ensure_ascii=False)


def _plural(count: int, noun: str) -> str:
    return f"{count} {noun}" if count == 1 else f"{count} {noun}s"


def _answered(answer: AnswerView, *, lead: str) -> str:
    answered = sum(isinstance(part, DefinitePart) for part in answer.parts)
    return (
        f"{lead} {answered} of {_plural(len(answer.parts), 'part')} of your question."
    )


def _gap_lines(answer: AnswerView) -> list[str]:
    gaps = {gap.part_index: gap for gap in answer.gaps}
    lines: list[str] = []
    for index, part in enumerate(answer.parts):
        name = _quote(part.variable_text)
        gap = gaps.get(index)
        if gap is None:
            lines.append(f"  answered {name}: {part.sentence or ''}".rstrip())
            continue
        lines.append(f"  missing  {name}: {gap.message}")
        if isinstance(part, CandidatesPart):
            lines.extend(
                f"    [{number}] {_candidate_line(candidate)}"
                for number, candidate in enumerate(part.candidates)
            )
        lines.extend(
            f"    [{number}] {option.label}"
            for number, option in enumerate(gap.options)
        )
    lines.extend(
        f"  Choose: {call}.fetch()"
        for gap in answer.gaps
        if (call := _choose_call(answer, gap)) is not None
    )
    answered = sum(isinstance(part, DefinitePart) for part in answer.parts)
    if answered:
        noun = "part" if answered == 1 else "parts"
        lines.append(f"  Or take the answered {noun}: answer.fetch(partial=True)")
    return lines


def _candidate_line(candidate: Candidate) -> str:
    label = (candidate.label or candidate.sentence or "").rstrip(".")
    return " · ".join(
        text for text in (label, candidate.source, candidate.unit) if text
    )


def _choose_call(answer: AnswerView, gap: Gap) -> str | None:
    """The call that settles a gap with its first choice, or None when none can."""
    if isinstance(gap.part, CandidatesPart):
        if not gap.part.candidates:
            return None
        if len(answer.parts) == 1:
            return "answer.choose(0)"
        return f"answer.choose({_part_key(answer, gap)}, 0)"
    if not gap.options:
        return None
    option = gap.options[0]
    return f"answer.choose({_option_key(answer, gap)}, {_quote(option.label)})"


def _part_key(answer: AnswerView, gap: Gap) -> str:
    """The part's words when they name it alone, else its index."""
    text = gap.part.variable_text
    named = [part for part in answer.parts if part.variable_text == text]
    return _quote(text) if text and len(named) == 1 else str(gap.part_index)


def _option_key(answer: AnswerView, gap: Gap) -> str:
    """The word the first option settles when it names the part alone, else the
    part's key."""
    mentions = gap.options[0].mentions
    if mentions:
        mention = mentions[0]
        elsewhere = any(part.variable_text == mention for part in answer.parts) or any(
            mention in option.mentions
            for other in answer.gaps
            if other.part_index != gap.part_index
            for option in other.options
        )
        if not elsewhere:
            return _quote(mention)
    return _part_key(answer, gap)
