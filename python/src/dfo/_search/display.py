"""How an answer reads: its text, its notebook HTML and its incomplete-answer message.

The functions read an answer's public members, so the async and sync answers share
them. Each line of the text is shown without control characters, so server text
cannot break a line or steer a terminal, and every server string in the HTML is
escaped.
"""

import html
import importlib
import json
import sys
from collections.abc import Generator, Sequence
from contextlib import contextmanager
from typing import Any, Protocol

from dfo._core.text import single_line
from dfo._core.types import (
    Candidate,
    DefinitePart,
    Gap,
    Notice,
    Option,
    Part,
)
from dfo._datasets.progress import progress_mode

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
_FETCH_LINE = "  Fetch: answer.fetch()"
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
        return _text_lines(
            [answer.sentence or "", *(f"  {line}" for line in lines), _FETCH_LINE]
        )
    return _incomplete(answer, lead="Answered")


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
            single_line(
                f"Search declined the question ({reason or 'no reason given'})."
            ),
        )
    return single_line(f"Search answered with kind {kind!r}, which holds no readings.")


def incomplete_message(answer: AnswerView, /) -> str:
    """The `IncompleteAnswerError` message: every gap and the line that settles it."""
    return _incomplete(answer, lead="Search answered")


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
    """IPython's `display`, when progress would show in a notebook."""
    if progress_mode(None, stream=sys.stderr) != "notebook":
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


def _incomplete(answer: AnswerView, *, lead: str) -> str:
    """What is answered and what is missing, with the calls that settle each gap."""
    answered = sum(isinstance(part, DefinitePart) for part in answer.parts)
    gaps = {gap.part_index: gap for gap in answer.gaps}
    lines = [
        f"{lead} {answered} of {_plural(len(answer.parts), 'part')} of your question."
    ]
    for index, part in enumerate(answer.parts):
        name = _quote(part.variable_text)
        gap = gaps.get(index)
        if gap is None:
            lines.append(f"  answered {name}: {part.sentence or ''}".rstrip())
            continue
        lines.append(f"  missing  {name}: {gap.message}")
        lines.extend(
            f"    [{number}] {_choice_line(choice)}"
            for number, choice in enumerate(gap.options)
        )
    several = len(waiting(answer.gaps)) > 1
    lines.extend(
        f"  Choose: {call}.fetch()"
        for gap in answer.gaps
        if (call := _choose_call(answer, gap, several=several)) is not None
    )
    if answered:
        noun = "part" if answered == 1 else "parts"
        lines.append(f"  Or take the answered {noun}: answer.fetch(partial=True)")
    return _text_lines(lines)


def _text_lines(lines: Sequence[str]) -> str:
    """`lines` joined, each on one line without control characters."""
    return "\n".join(single_line(line) for line in lines)


def _choice_line(choice: Candidate | Option) -> str:
    if isinstance(choice, Option):
        return choice.label
    label = (choice.label or choice.sentence or "").rstrip(".")
    return " · ".join(text for text in (label, choice.source, choice.unit) if text)


def waiting(gaps: Sequence[Gap], /) -> list[Gap]:
    """The gaps that await a choice, which `choose` without `part` picks among."""
    return [gap for gap in gaps if gap.kind == "choice" or gap.options]


def _choose_call(answer: AnswerView, gap: Gap, *, several: bool) -> str | None:
    """The call that settles a gap with its first choice, or None when none can.

    The call names the part only when `several` gaps await a choice.
    """
    if not gap.options:
        return None
    first = gap.options[0]
    if isinstance(first, Option):
        option = _quote(first.label)
        part = _option_key(answer, first, gap)
    else:
        option = "0"
        part = _part_key(answer, gap)
    if not several:
        return f"answer.choose({option})"
    return f"answer.choose({option}, part={part})"


def _part_key(answer: AnswerView, gap: Gap) -> str:
    """The part's words when they name it alone, else its index."""
    text = gap.part.variable_text
    named = [part for part in answer.parts if part.variable_text == text]
    return _quote(text) if text and len(named) == 1 else str(gap.part_index)


def _option_key(answer: AnswerView, option: Option, gap: Gap) -> str:
    """The word `option` settles when it names the part alone, else the part's
    key."""
    mentions = option.mentions
    if mentions:
        mention = mentions[0]
        elsewhere = any(part.variable_text == mention for part in answer.parts) or any(
            isinstance(other_option, Option) and mention in other_option.mentions
            for other in answer.gaps
            if other.part_index != gap.part_index
            for other_option in other.options
        )
        if not elsewhere:
            return _quote(mention)
    return _part_key(answer, gap)
