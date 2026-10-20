"""Answers: what Search understood a question to ask, part by part.

An answer holds readings, not data. `fetch` builds the dataset when every part has
a reading, and raises `IncompleteAnswerError` before any build when one does not.
`choose` settles a part that awaits a choice and returns a new answer.

A choice in a one-part answer among candidates needs no request. A choice of place
or source in a one-part answer posts the option's `data_query` unchanged. A choice
in an answer of several parts posts a `dataset_resubmit` with one entry per part, so
Search composes the joined sentence and folds the parts again:

- a definite part posts its spec's identity and entity groups;
- the chosen candidate posts its identity, and the chosen option its one parsed part;
- a candidates part left alone posts its candidate set in the server's order;
- any other part posts its `restatement`, which Search resolves again and so keeps
  its message and its choices; a part without one is restated as a placeholder.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal, NoReturn, overload, override

from dfo import _display, _strict
from dfo._error_map import GAP_KINDS
from dfo._errors import (
    ContractError,
    DeclinedError,
    IncompleteAnswerError,
    InvalidRequestError,
    SearchWarning,
    warn,
)
from dfo._parse import parse_notices, parse_parts
from dfo._transport import AsyncTransport
from dfo._types import (
    Candidate,
    CandidatesPart,
    DefinitePart,
    Gap,
    NoDataPart,
    Notice,
    Option,
    Part,
    Spec,
    UnsupportedPart,
)

if TYPE_CHECKING:
    # The dataset class ships beside the fetch code.
    from dfo._dataset import Dataset  # ty: ignore[unresolved-import]

type TransportSource = Callable[[], AsyncTransport]
"""Returns the transport an answer's requests go through, read when each one runs."""

type Layout = Literal["long", "frame"]

RESOLVE_PATH = "/search/resolve"
SCHEMA_VERSION = 1

# Longer than Search's 45-second soft deadline, so a slow answer arrives whole.
SEARCH_TIMEOUT = 60.0

_TIMED_OUT = (
    "Search reached its time limit before this part resolved; search again, or ask "
    "for less at once."
)
_DATA_METHODS = frozenset(
    {"to_pandas", "to_polars", "to_arrow", "to_rows", "save", "__arrow_c_stream__"}
)


@dataclass(frozen=True, slots=True, kw_only=True, repr=False)
class AsyncAnswer:
    """What Search understood a question to ask, as one reading per part.

    Attributes:
        kind: `resolution`, `catalogue` or `declined`.
        status: The parts' shared status (`definite`, `candidates`, `no_data`,
            `unsupported`), `mixed` when they differ, or the kind for a declined or
            catalogue answer.
        sentence: Search's sentence for the whole answer; None for a declined or
            catalogue answer, which Search gives none.
        parts: One part per variable asked, in query order.
        specs: The readings, one per distinct spec, in query order.
        complete: Whether every part has a reading.
        gaps: The parts that stop a complete dataset, in query order.
        question: The question asked, when the answer came from one.
        reason: Why Search declined, for a declined answer.
        warnings: Search's warnings for the whole answer.
        timed_out: Whether Search stopped at its time limit.
        raw: The decoded response body, untouched.
    """

    kind: str
    status: str
    sentence: str | None
    parts: tuple[Part, ...] = ()
    specs: tuple[Spec, ...] = ()
    complete: bool = False
    gaps: tuple[Gap, ...] = ()
    question: str | None = None
    reason: str | None = None
    warnings: tuple[Notice, ...] = ()
    timed_out: bool = False
    raw: Mapping[str, Any] = field(default_factory=dict, compare=False)
    _source: TransportSource = field(compare=False)

    @override
    def __repr__(self) -> str:
        return _display.answer_text(self)

    def _repr_html_(self) -> str:
        return _display.answer_html(self)

    def __getattr__(self, name: str) -> NoReturn:
        if name in _DATA_METHODS:
            raise AttributeError(
                "an Answer holds readings, not data; call answer.fetch()", name=name
            )
        raise AttributeError(
            f"{type(self).__name__!r} object has no attribute {name!r}", name=name
        )

    @overload
    async def choose(self, option: int | str, /) -> AsyncAnswer: ...
    @overload
    async def choose(self, part: int | str, option: int | str, /) -> AsyncAnswer: ...
    async def choose(
        self, first: int | str, second: int | str | None = None, /
    ) -> AsyncAnswer:
        """Settle a part that awaits a choice, and return the new answer.

        `choose(option)` picks in the only part that awaits a choice;
        `choose(part, option)` names the part. A part is named by its index, its
        variable text, or a word of the question one of its options settles. An
        option is named by its index or its label.

        Raises:
            InvalidRequestError: No part, or more than one, awaits a choice; the
                part or option is unknown; or the part offers no options.
        """
        if second is None:
            gap = self._only_choice()
            option = first
        else:
            gap = self._gap_named(first)
            option = second
        chosen = _pick(gap, option, mention=first if second is not None else None)
        if len(self.parts) == 1:
            if isinstance(chosen, Candidate):
                return self._with_candidate(gap.part, chosen)
            return await self._resolve(chosen.data_query)
        entries = [
            _entry(part, chosen if index == gap.part_index else None)
            for index, part in enumerate(self.parts)
        ]
        return await self._resolve({"kind": "dataset_resubmit", "entries": entries})

    async def fetch(
        self,
        *,
        partial: bool = False,
        strict: bool = False,
        layout: Layout = "long",
        timeout: float | None = 1800.0,
        progress: bool | None = None,
    ) -> Dataset:
        """Build the dataset for the answer's readings.

        Each distinct spec builds once; several readings stack into one long table
        with a `part` column. Departures, skipped computations and Search's `warn`
        and `degraded` warnings arrive as one `SearchWarning`.

        Args:
            partial: Build the parts that have a reading when others do not; the
                dataset then lists the gaps in `missing`.
            strict: Raise the `SearchWarning`, and the datasets surface's
                warnings, instead of issuing them.
            layout: `long`, or `frame` for one reading's pipeline frame.
            timeout: The longest the whole build waits, in seconds.
            progress: Show progress; None shows it in a terminal or notebook.

        Raises:
            DeclinedError: Search declined the question or answered with the
                catalogue.
            IncompleteAnswerError: A part has no reading and `partial` is False,
                or no part has one.
            SearchWarning: `strict` is True and the reading differs from the
                question.
        """
        if self.kind != _strict.RESOLUTION_KIND:
            raise DeclinedError(
                _display.declined_text(self.kind, self.reason),
                detail=self.reason or self.kind,
            )
        members = _members(self.parts)
        if self.gaps and (not partial or not members):
            raise self.incomplete_error()
        if (hint := _search_warning(self)) is not None:
            if strict:
                raise hint
            warn(hint)
        # The build code loads on the first fetch.
        from dfo._fetch import fetch_members  # noqa: PLC0415  # ty: ignore[unresolved-import]

        return await fetch_members(
            self._source(),
            members,
            layout=layout,
            strict=strict,
            timeout=timeout,
            progress=progress,
            missing=self.gaps,
        )

    def incomplete_error(self) -> IncompleteAnswerError:
        """The error `fetch` raises for this answer's gaps."""
        error = IncompleteAnswerError(_display.incomplete_message(self))
        error.answer = self
        error.gaps = self.gaps
        return error

    def _only_choice(self) -> Gap:
        waiting = [gap for gap in self.gaps if gap.kind == "choice" or gap.options]
        if len(waiting) == 1:
            return waiting[0]
        if not waiting:
            raise InvalidRequestError("No part of this answer awaits a choice.")
        raise InvalidRequestError(
            f"{len(waiting)} parts of this answer await a choice; name the part: "
            "answer.choose(part, option)."
        )

    def _gap_named(self, key: int | str) -> Gap:
        index = _part_index(self.parts, self.gaps, key)
        gap = next((gap for gap in self.gaps if gap.part_index == index), None)
        if gap is None:
            raise InvalidRequestError(f"Part {key!r} already has a reading.")
        return gap

    def _with_candidate(self, part: Part, candidate: Candidate) -> AsyncAnswer:
        definite = DefinitePart(
            status=_strict.DEFINITE_PART_STATUS,
            variable_text=part.variable_text,
            sentence=candidate.sentence,
            separate=part.separate,
            warnings=part.warnings,
            departures=part.departures,
            operations=part.operations,
            raw={
                **{
                    key: value for key, value in part.raw.items() if key != "candidates"
                },
                "status": _strict.DEFINITE_PART_STATUS,
                "spec": candidate.raw,
            },
            spec=candidate.spec,
        )
        return AsyncAnswer(
            kind=self.kind,
            status=_strict.DEFINITE_PART_STATUS,
            sentence=candidate.sentence or self.sentence,
            parts=(definite,),
            specs=(candidate.spec,),
            complete=True,
            question=self.question,
            warnings=self.warnings,
            raw=self.raw,
            _source=self._source,
        )

    async def _resolve(self, request: Mapping[str, Any]) -> AsyncAnswer:
        return await resolve(
            self._source, request, question=self.question, timeout=SEARCH_TIMEOUT
        )


async def resolve(
    source: TransportSource,
    request: Mapping[str, Any],
    /,
    *,
    question: str | None,
    timeout: float | None,
) -> AsyncAnswer:
    """Post one Search input and read the answer.

    Args:
        source: Returns the transport to post through.
        request: The `input` member: a raw text, parsed or `dataset_resubmit`
            input.
        question: The question the answer stands for, kept on it.
        timeout: The longest the call waits, retries included, in seconds.

    Raises:
        ContractError: The answer's kind is unknown, or a member the client acts
            on is missing.
    """
    transport = source()
    response = await transport.request(
        "POST",
        RESOLVE_PATH,
        json={"schema_version": SCHEMA_VERSION, "input": request},
        timeout=timeout or SEARCH_TIMEOUT,
        deadline=transport.deadline(timeout),
    )
    return answer_from_body(response.json(), question=question, source=source)


def answer_from_body(
    body: object, /, *, question: str | None, source: TransportSource
) -> AsyncAnswer:
    """Read a decoded Search response into an answer.

    Raises:
        ContractError: The body is not an object, its kind is unknown, or a member
            the client acts on is missing.
    """
    if not isinstance(body, Mapping):
        raise ContractError("The Search response is not an object")
    diagnostics = body.get("diagnostics")
    diagnostics = diagnostics if isinstance(diagnostics, Mapping) else {}
    warnings = parse_notices(diagnostics.get("warnings"))
    kind = body.get("kind")
    if kind in (_strict.DECLINED_ANSWER_KIND, _strict.CATALOGUE_ANSWER_KIND):
        reason = body.get("reason") if kind == _strict.DECLINED_ANSWER_KIND else None
        reason = reason if isinstance(reason, str) else None
        return AsyncAnswer(
            kind=kind,
            status=kind,
            sentence=None,
            question=question,
            reason=reason,
            warnings=warnings,
            raw=body,
            _source=source,
        )
    if kind != _strict.RESOLUTION_KIND:
        raise ContractError(
            f"Search answered with kind {kind!r}, which this client does not know; "
            "upgrade development-finance"
        )
    parts = parse_parts(body)
    timed_out = diagnostics.get("timed_out") is True
    gaps = tuple(
        gap
        for index, part in enumerate(parts)
        if (gap := _gap(index, part, timed_out=timed_out)) is not None
    )
    status = body.get("status")
    sentence = body.get("rendered_sentence")
    return AsyncAnswer(
        kind=kind,
        status=status if isinstance(status, str) else _status(parts),
        sentence=sentence
        if isinstance(sentence, str) and sentence
        else " ".join(part.sentence for part in parts if part.sentence),
        parts=parts,
        specs=tuple(dict.fromkeys(spec for _, spec in _readings(parts))),
        complete=not gaps,
        gaps=gaps,
        question=question,
        warnings=warnings,
        timed_out=timed_out,
        raw=body,
        _source=source,
    )


def _status(parts: Sequence[Part]) -> str:
    statuses = {part.status for part in parts}
    return statuses.pop() if len(statuses) == 1 else "mixed"


def _gap(index: int, part: Part, *, timed_out: bool) -> Gap | None:
    """The gap a part leaves, or None when it has a reading."""
    match part:
        case DefinitePart():
            return None
        case CandidatesPart(candidates):
            return Gap(index, part, "choice", f"{len(candidates)} readings")
        case NoDataPart(reason) if timed_out:
            return Gap(index, part, "timed_out", _TIMED_OUT)
        case NoDataPart(reason):
            return Gap(
                index,
                part,
                GAP_KINDS.get(reason, "no_data"),
                part.message or reason,
                part.options,
            )
        case UnsupportedPart(reason):
            return Gap(index, part, "unsupported", part.message or reason)
        case _:
            return Gap(
                index,
                part,
                "unknown",
                f"Search answered this part with status {part.status!r}, which this "
                "client does not know; upgrade development-finance.",
            )


def _readings(parts: Sequence[Part]) -> list[tuple[Part, Spec]]:
    return [(part, part.spec) for part in parts if isinstance(part, DefinitePart)]


def _members(parts: Sequence[Part]) -> list[tuple[tuple[str, ...], Spec, str]]:
    """One `(parts, spec, sentence)` per distinct spec, in query order.

    Parts folded onto one spec share its member, which names each of them.
    """
    grouped: dict[Spec, list[str]] = {}
    for part, spec in _readings(parts):
        grouped.setdefault(spec, []).append(
            part.variable_text or spec.sentence or spec.spec_id
        )
    return [
        (tuple(names), spec, spec.sentence or "") for spec, names in grouped.items()
    ]


def _part_index(parts: Sequence[Part], gaps: Sequence[Gap], key: int | str) -> int:
    if isinstance(key, int):
        if 0 <= key < len(parts):
            return key
        raise InvalidRequestError(
            f"Part {key} is out of range; the answer has {len(parts)} parts."
        )
    named = [index for index, part in enumerate(parts) if part.variable_text == key]
    if not named:
        named = [
            gap.part_index
            for gap in gaps
            if any(key in option.mentions for option in gap.options)
        ]
    if len(named) == 1:
        return named[0]
    if not named:
        raise InvalidRequestError(
            f"No part is named {key!r}; name a part by its index or its words."
        )
    raise InvalidRequestError(f"{len(named)} parts are named {key!r}; use an index.")


def _pick(gap: Gap, key: int | str, *, mention: int | str | None) -> Candidate | Option:
    """The candidate or option `key` names in a gap."""
    part = gap.part
    choices: Sequence[Candidate | Option]
    if isinstance(part, CandidatesPart):
        choices = part.candidates
        labels = [candidate.label for candidate in part.candidates]
    elif gap.options:
        choices = gap.options
        labels = [option.label for option in gap.options]
    else:
        raise InvalidRequestError(
            f"Part {gap.part_index} offers no choice: {gap.message}"
        )
    if isinstance(key, int):
        if 0 <= key < len(choices):
            return choices[key]
        raise InvalidRequestError(
            f"Option {key} is out of range; part {gap.part_index} offers "
            f"{len(choices)}."
        )
    # A part named by a word its options settle offers only those options' labels.
    scope = mention if isinstance(mention, str) and mention in _mentions(gap) else None
    found = [
        choice
        for choice, label in zip(choices, labels, strict=True)
        if label == key
        and (
            scope is None or not isinstance(choice, Option) or scope in choice.mentions
        )
    ]
    if len(found) == 1:
        return found[0]
    if not found:
        raise InvalidRequestError(
            f"Part {gap.part_index} has no option labelled {key!r}; name it by "
            "index or label."
        )
    raise InvalidRequestError(
        f"{len(found)} options of part {gap.part_index} are labelled {key!r}; use "
        "an index."
    )


def _mentions(gap: Gap) -> set[str]:
    return {mention for option in gap.options for mention in option.mentions}


def _entry(part: Part, chosen: Candidate | Option | None) -> dict[str, Any]:
    """The `dataset_resubmit` entry for one part, settled by `chosen` when given."""
    if isinstance(chosen, Candidate):
        return _identity_entry(part, chosen.raw)
    if chosen is not None:
        return {"entry_kind": "parsed", "part": _option_part(chosen)}
    match part:
        case DefinitePart():
            return _identity_entry(part, part.raw["spec"])
        case CandidatesPart():
            return _candidates_entry(part)
    return _restated_entry(part)


def _restated_entry(part: Part) -> dict[str, Any]:
    """A part with no reading, resolved again from its restatement when it has one.

    A placeholder keeps neither the server's message nor the part's choices, so
    it serves only a part Search gave no restatement.
    """
    restatement = part.raw.get("restatement")
    if isinstance(restatement, Mapping):
        return {"entry_kind": "parsed", "part": restatement}
    match part:
        case NoDataPart(reason):
            return _echo(
                part, entry_kind="placeholder", status="no_data", reason=reason
            )
        case UnsupportedPart(reason):
            return _echo(
                part, entry_kind="placeholder", status="unsupported", code=reason
            )
    raise InvalidRequestError(
        f"Part {part.variable_text!r} has status {part.status!r}, which this client "
        "cannot post back; upgrade development-finance."
    )


def _echo(part: Part, **members: Any) -> dict[str, Any]:
    """An entry with the members every non-parsed entry echoes from its part."""
    if not part.variable_text:
        raise InvalidRequestError(
            "A part without variable text cannot be posted back; search again."
        )
    entry: dict[str, Any] = {**members, "variable_text": part.variable_text}
    if part.separate:
        entry["separate"] = True
    if operations := part.raw.get("operations"):
        entry["operations"] = operations
    return entry


def _identity(spec: Mapping[str, Any]) -> dict[str, Any]:
    """A spec's identity and entity groups, as Search takes them back."""
    item: dict[str, Any] = {"identity": spec["definition"]["identity"]}
    resolved = spec.get("resolved")
    if isinstance(resolved, Mapping) and resolved.get("entity_groups"):
        item["entity_groups"] = resolved["entity_groups"]
    return item


def _identity_entry(part: Part, spec: Mapping[str, Any]) -> dict[str, Any]:
    return _echo(part, entry_kind="identity", **_identity(spec))


def _candidates_entry(part: CandidatesPart) -> dict[str, Any]:
    candidate_set = part.raw["candidates"]
    return _echo(
        part,
        entry_kind="candidates",
        ordering=candidate_set.get("ordering"),
        truncated=part.truncated,
        candidates=[_identity(candidate.raw) for candidate in part.candidates],
    )


def _option_part(option: Option) -> Mapping[str, Any]:
    parts = option.data_query.get("parts")
    if not isinstance(parts, list) or len(parts) != 1:
        raise ContractError(
            f"The option {option.label!r} does not carry a one-part parsed input"
        )
    return parts[0]


def _search_warning(answer: AsyncAnswer) -> SearchWarning | None:
    """One warning for how the readings to build differ from the question."""
    hints = _display.hints(answer, departures=True)
    if not hints:
        return None
    return SearchWarning(
        "Search's reading differs from your question:\n  "
        + "\n  ".join(line for _, line in hints),
        code=hints[0][0] if len(hints) == 1 else None,
    )
