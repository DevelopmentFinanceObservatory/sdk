"""Answers: what Search understood a question to ask, part by part.

An answer holds readings. `fetch` builds the dataset when every part has
a reading, and raises `IncompleteAnswerError` before any build when one does not.
`choose` settles a part that awaits a choice and returns a new answer.

Every choice makes one Search request, and the new answer is Search's response.
A choice of place or source in a one-part answer posts the option's `data_query`
unchanged, a parsed input that Search binds again. Any other choice posts a
`dataset_resubmit` with one entry per part, so Search composes the sentence and
folds the parts again; a pick in a one-part answer posts one entry:

- a definite part posts its spec's identity and entity groups;
- the chosen candidate posts its identity, and the chosen option its one parsed part;
- a candidates part left alone posts its candidate set in the server's order;
- any other part posts its `restatement`, which Search resolves again and so keeps
  its message and its choices; a part without one is restated as a placeholder.

Each identity echoes its reading's assumptions: a definite part's `assumptions`,
and a candidate's entry in its part's `reading_assumptions`. Search then states
the assumptions that still hold, and the new sentence carries them. An identity
whose part carries no list posts none, and Search computes them afresh. A member
an entry echoes with another JSON type than the wire's reads as absent: a
restatement that is not an object, and `operations` or `assumptions` that are not
lists. Each list posts the items the client reads, in the read forms
`dfo._core.parse.read_requested_operation` and `read_assumption` give, so an item whose
required members are not strings, and an optional member of another type, are
left out.
"""

from __future__ import annotations

import json
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, ClassVar, Never, NoReturn, override

from dfo._core.codes import (
    ANSWER_DECLINED,
    ANSWER_INCOMPLETE,
    CHOICE_INVALID,
    CONTRACT_VIOLATION,
    INVALID_ARGUMENT,
)
from dfo._core.errors import (
    IncompleteAnswerError,
    InvalidRequestError,
    SearchWarning,
    client_error,
    warn,
)
from dfo._core.nearest import nearest
from dfo._core.parse import (
    parse_notices,
    parse_parts,
    read_assumption,
    read_items,
    read_requested_operation,
)
from dfo._core.refusals import describing, trace_id_of
from dfo._core.text import cited
from dfo._core.types import (
    Candidate,
    CandidatesPart,
    DefinitePart,
    Gap,
    Layout,
    NoDataPart,
    Notice,
    Option,
    Part,
    Spec,
    UnsupportedPart,
)
from dfo._datasets.build import Reading, check_strict, response_json
from dfo._datasets.dataset import Dataset
from dfo._datasets.fetch import SessionSource, fetch_members
from dfo._generated import strict as _strict
from dfo._generated.error_map import GAP_KINDS
from dfo._generated.wire import DeclinedReason
from dfo._search import display as _display
from dfo._search.answer_json import answer_json, read_answer_json

if TYPE_CHECKING:
    # The client module reads answers, so the import is for types only.
    from dfo._client.client import AsyncClient

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
        trace_id: The Search response's trace id, to quote when reporting it.
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
    reason: DeclinedReason | str | None = None
    warnings: tuple[Notice, ...] = ()
    timed_out: bool = False
    trace_id: str | None = field(default=None, compare=False)
    raw: Mapping[str, Any] = field(default_factory=dict, compare=False)
    _source: SessionSource = field(compare=False)
    # The session `from_json` reads through when it names no client: the
    # default client's, which `dfo._client.default` sets, since this layer
    # cannot import the client layer.
    _default_source: ClassVar[SessionSource | None] = None

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

    def to_json(self) -> str:
        """The answer as JSON, read back by `from_json` in this or another DFO client.

        The JSON holds the question and Search's response cut to the members the
        client reads, so a web page can hold an answer and post it back with the
        reader's choice.
        """
        return json.dumps(
            answer_json(self.question, self.raw, self.trace_id), ensure_ascii=False
        )

    @classmethod
    def from_json(cls, text: str | bytes, /, *, client: AsyncClient) -> AsyncAnswer:
        """Read an answer that `to_json` wrote, to choose and fetch through `client`.

        The answer reads as a fresh Search response does, with the same checks,
        and holds no more than the JSON does: `choose` posts back each part's
        spec and identity and a place option's `data_query` as the JSON gives
        them. JSON from a web page can therefore send any spec or parsed input to
        Search and the build route through the client's key. With a public-tier
        key that costs quota, so rate-limit the routes per visitor; with a key
        beyond the public tier, keep the JSON on the server, under a random id
        the page sends back, or sign it before it leaves.

        Args:
            text: JSON that `to_json` wrote.
            client: The client the answer's requests go through. The
                synchronous `Answer` takes the default client when it is None.

        Raises:
            FormatError: The text is not JSON in the answer format
                (`format_invalid`).
            ContractError: The answer lacks a member the client acts on.
            InvalidRequestError: `client` is None and no default client is
                set (`invalid_argument`).
        """
        question, body, trace_id = read_answer_json(text)
        if client is not None:
            source = client._current
        elif cls._default_source is not None:
            source = cls._default_source
        else:
            raise client_error(
                INVALID_ARGUMENT,
                f"{cls.__name__}.from_json needs the client its requests go "
                f"through: {cls.__name__}.from_json(text, client=client)",
            )
        with describing(trace_id):
            return answer_from_body(
                body, question=question, source=source, trace_id=trace_id
            )

    async def choose(
        self, option: int | str, /, *old_form: Never, part: int | str | None = None
    ) -> AsyncAnswer:
        """Settle a part that awaits a choice, and return Search's new answer.

        The choice makes one Search request. The new answer, its sentence and
        its assumptions are Search's response.

        `choose(option)` picks in the only part that awaits a choice;
        `choose(option, part=part)` names the part. A part is named by its
        index, its variable text, or a word of the question one of its options
        settles. An option is named by its index or its label.

        Raises:
            TypeError: A second positional argument, as the earlier
                `choose(part, option)` took; the message names the call in
                this form.
            InvalidRequestError: No part, or more than one when `part` is None,
                awaits a choice; a key is not an index or a label, or names no
                part or option; the part offers no options; or a part cannot be
                posted back (`choice_invalid`).
            ContractError: The chosen option's `data_query` is not a parsed
                input of one part; it carries the answer's trace id.
        """
        # A caller without a type checker can still pass the earlier form.
        if old_form:  # ty: ignore[redundant-condition]
            raise TypeError(
                "answer.choose takes the option first and the part as a keyword: "
                f"answer.choose({cited(old_form[0])}, part={cited(option)})."
            )
        with describing(self.trace_id):
            request = self._choice_input(option, part)
        return await resolve(
            self._source, request, question=self.question, timeout=SEARCH_TIMEOUT
        )

    def _choice_input(
        self, option: int | str, part: int | str | None
    ) -> Mapping[str, Any]:
        """The Search input a choice posts, from `choose`'s option and part."""
        for key in (option,) if part is None else (option, part):
            # A bool is an int, and a caller without a type checker can pass anything.
            if isinstance(key, bool) or not isinstance(key, int | str):
                raise client_error(
                    CHOICE_INVALID, f"{key!r} is not an index or a label."
                )
        gap = self._only_choice() if part is None else self._gap_named(part)
        chosen = _pick(gap, option, mention=part)
        if len(self.parts) == 1 and isinstance(chosen, Option):
            _option_part(chosen)
            return chosen.data_query
        entries = [
            _entry(each, chosen if index == gap.part_index else None)
            for index, each in enumerate(self.parts)
        ]
        return {"kind": "dataset_resubmit", "entries": entries}

    async def fetch(
        self,
        *,
        partial: bool = False,
        strict: bool = False,
        layout: Layout = "long",
        without_party_totals: bool = False,
        timeout: float | None = None,
        progress: bool | None = None,
    ) -> Dataset:
        """Build the dataset for the answer's readings.

        Each distinct spec builds once; several readings stack into one long table
        with a `part` column. Departures, skipped computations and Search's `warn`
        and `degraded` warnings arrive as one `SearchWarning`.

        Args:
            partial: Build the parts that have a reading when others do not. The
                dataset then lists the gaps in `missing`.
            strict: Raise the `SearchWarning`, and the datasets surface's
                warnings, instead of issuing them.
            layout: `long`, or `frame` for one reading's pipeline frame.
            without_party_totals: Leave out the rows of parties the code index
                declares totals, such as the DAC total beside its members, on
                each party role a reading leaves open.
            timeout: The longest the whole build waits, in seconds. None, the
                default, waits as long as the build takes, which the server
                always ends. In the synchronous client, platform name
                resolution can run past this bound; the asynchronous client
                can cancel it.
            progress: Show progress; None shows it in a terminal or notebook.

        Raises:
            DeclinedError: Search declined the question or answered with the
                catalogue.
            IncompleteAnswerError: A part has no reading and `partial` is False,
                or no part has one.
            SearchWarning: `strict` is True and the reading differs from the
                question.
            DataWarning: `strict` is True and a manifest carries a warning
                above `info`.
            InvalidRequestError: `layout="frame"` with several readings, or
                `strict` is not a bool or `progress` neither a bool nor None
                (`invalid_argument`).
            DfoTimeoutError: `timeout` passed (`deadline_exceeded`). The build
                keeps running on the server, and the same fetch joins it.
            DfoError: The server refused a request.
        """
        if self.kind != _strict.RESOLUTION_KIND:
            raise client_error(
                ANSWER_DECLINED,
                _display.declined_text(self.kind, self.reason),
                detail=self.reason or self.kind,
                trace_id=self.trace_id,
            )
        # `fetch_members` checks `strict` too. This check runs first so a bad
        # value raises before the incomplete-answer error or the warning.
        check_strict(strict)
        members = _members(self.parts)
        if self.gaps and (not partial or not members):
            raise self._incomplete_error()
        if (hint := _search_warning(self)) is not None:
            if strict:
                raise hint
            warn(hint)
        session = self._source()
        return await fetch_members(
            session.transport,
            members,
            layout=layout,
            without_party_totals=without_party_totals,
            strict=strict,
            timeout=timeout,
            progress=progress,
            cache=session.cache,
            missing=self.gaps,
        )

    def _incomplete_error(self) -> IncompleteAnswerError:
        error = client_error(
            ANSWER_INCOMPLETE,
            _display.incomplete_message(self),
            trace_id=self.trace_id,
        )
        error.answer = self
        error.gaps = self.gaps
        return error

    def _only_choice(self) -> Gap:
        waiting = _display.waiting(self.gaps)
        if len(waiting) == 1:
            return waiting[0]
        if not waiting:
            raise client_error(
                CHOICE_INVALID, "No part of this answer awaits a choice."
            )
        raise client_error(
            CHOICE_INVALID,
            f"{len(waiting)} parts of this answer await a choice; name the part: "
            "answer.choose(option, part=part).",
        )

    def _gap_named(self, key: int | str) -> Gap:
        index = _part_index(self.parts, self.gaps, key)
        gap = next((gap for gap in self.gaps if gap.part_index == index), None)
        if gap is None:
            raise client_error(CHOICE_INVALID, f"Part {key!r} already has a reading.")
        return gap


async def resolve(
    source: SessionSource,
    request: Mapping[str, Any],
    /,
    *,
    question: str | None,
    timeout: float | None,
) -> AsyncAnswer:
    """Post one Search input and read the answer.

    Args:
        source: Returns the session to post through.
        request: The `input` member: a raw text, parsed or `dataset_resubmit`
            input.
        question: The question the answer stands for, kept on it.
        timeout: The longest the call waits, retries included, in seconds; each
            attempt reads until then. None waits without limit. In the
            synchronous client, platform name resolution can run past this bound;
            the asynchronous client can cancel it.

    Raises:
        DfoError: The response is a problem document with a string `code` but
            no `kind`, raised as the class the contract's registry maps its code to.
        ContractError: The body is not JSON (`unexpected_response`), the
            answer's kind is absent or unknown, a member the client acts on is
            missing, or a problem document's code is one the registry does not
            hold (`contract_violation`).
    """
    # The session holds its client open until the request returns.
    session = source()
    transport = session.transport
    response = await transport.request(
        "POST",
        RESOLVE_PATH,
        json={"schema_version": SCHEMA_VERSION, "input": request},
        timeout=math.inf,
        deadline=transport.deadline(timeout),
    )
    body = response_json(response)
    trace_id = trace_id_of(response, body)
    if (problem := transport.success_problem(response, body)) is not None:
        raise problem
    with describing(trace_id):
        return answer_from_body(
            body, question=question, source=source, trace_id=trace_id
        )


def answer_from_body(
    body: object,
    /,
    *,
    question: str | None,
    source: SessionSource,
    trace_id: str | None = None,
) -> AsyncAnswer:
    """Read a decoded Search response into an answer.

    `trace_id` is the trace id of the response the body came from.

    Raises:
        ContractError: The body is not an object, its kind is unknown, or a member
            the client acts on is missing.
    """
    if not isinstance(body, Mapping):
        raise client_error(CONTRACT_VIOLATION, "The Search response is not an object")
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
            trace_id=trace_id,
            raw=body,
            _source=source,
        )
    if kind is None:
        raise client_error(CONTRACT_VIOLATION, "The Search response names no kind")
    if kind != _strict.RESOLUTION_KIND:
        raise client_error(
            CONTRACT_VIOLATION,
            f"Search answered with kind {kind!r}, which this client does not know; "
            "upgrade development-finance",
        )
    status = body.get("status")
    sentence = body.get("rendered_sentence")
    parts = parse_parts(body)
    sentence = (
        sentence
        if isinstance(sentence, str) and sentence
        else " ".join(part.sentence for part in parts if part.sentence)
    )
    timed_out = diagnostics.get("timed_out") is True
    gaps = tuple(
        gap
        for index, part in enumerate(parts)
        if (gap := _gap(index, part, timed_out=timed_out)) is not None
    )
    return AsyncAnswer(
        kind=kind,
        status=status if isinstance(status, str) else _status(parts),
        sentence=sentence,
        parts=parts,
        specs=tuple(
            dict.fromkeys(part.spec for part in parts if isinstance(part, DefinitePart))
        ),
        complete=not gaps,
        gaps=gaps,
        question=question,
        warnings=warnings,
        timed_out=timed_out,
        trace_id=trace_id,
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
            return Gap(index, part, "choice", f"{len(candidates)} readings", candidates)
        case NoDataPart() if timed_out:
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


def _members(parts: Sequence[Part]) -> list[Reading]:
    """One reading per distinct spec, in query order.

    Parts folded onto one spec share its reading, which names each of them that
    has variable text; a part without any names nothing.
    """
    grouped: dict[Spec, list[DefinitePart]] = {}
    for part in parts:
        if isinstance(part, DefinitePart):
            grouped.setdefault(part.spec, []).append(part)
    return [
        Reading(
            tuple(part.variable_text for part in folded if part.variable_text),
            spec,
            spec.sentence,
            tuple(folded),
        )
        for spec, folded in grouped.items()
    ]


def _part_index(
    parts: Sequence[Part],
    gaps: Sequence[Gap],
    key: int | str,
) -> int:
    if isinstance(key, int):
        if 0 <= key < len(parts):
            return key
        raise client_error(
            CHOICE_INVALID,
            f"Part {key} is out of range; the answer has {len(parts)} parts.",
        )
    named = [index for index, part in enumerate(parts) if part.variable_text == key]
    if not named:
        named = [
            gap.part_index
            for gap in gaps
            if any(key in option.mentions for option in _options(gap))
        ]
    if len(named) == 1:
        return named[0]
    if not named:
        waiting = [(gap, _names_of(gap)) for gap in _display.waiting(gaps)]
        raise _unmatched(
            f"No part is named {cited(key)}",
            nearest(key, [name for _, names in waiting for name in names], _label_fold),
            "name a part by its index or its words",
            ", ".join(
                f"{gap.part_index} = {' / '.join(names)}" for gap, names in waiting
            ),
        )
    raise client_error(
        CHOICE_INVALID, f"{len(named)} parts are named {key!r}; use an index."
    )


def _pick(gap: Gap, key: int | str, *, mention: int | str | None) -> Candidate | Option:
    """The candidate or option `key` names in a gap."""
    choices = gap.options
    if not choices:
        raise client_error(
            CHOICE_INVALID, f"Part {gap.part_index} offers no choice: {gap.message}"
        )
    if isinstance(key, int):
        if 0 <= key < len(choices):
            return choices[key]
        raise client_error(
            CHOICE_INVALID,
            f"Option {key} is out of range; part {gap.part_index} offers "
            f"{len(choices)}: {_option_list(gap)}.",
        )
    # A part named by a word its options settle offers only those options' labels.
    scope = mention if isinstance(mention, str) and mention in _mentions(gap) else None
    found = [
        choice
        for choice in choices
        if choice.label == key
        and (
            scope is None or not isinstance(choice, Option) or scope in choice.mentions
        )
    ]
    if len(found) == 1:
        return found[0]
    if not found:
        labels = [choice.label for choice in choices if choice.label is not None]
        raise _unmatched(
            f"Part {gap.part_index} has no option labelled {cited(key)}",
            nearest(key, labels, _label_fold),
            "name it by index or label",
            _option_list(gap),
        )
    raise client_error(
        CHOICE_INVALID,
        f"{len(found)} options of part {gap.part_index} are labelled {key!r}; use "
        "an index.",
    )


def _names_of(gap: Gap) -> list[str]:
    """The words that name a gap's part: its variable text, then the words its
    options settle."""
    text = gap.part.variable_text
    words = ([text] if text else []) + [
        mention for option in _options(gap) for mention in option.mentions
    ]
    return list(dict.fromkeys(words))


def _unmatched(
    lead: str, near: str | None, how: str, choices: str
) -> InvalidRequestError:
    """The refusal of a key that names nothing: `lead`, then the nearest match, or
    else `how` to name one, and the valid choices on a line of their own."""
    if not choices:
        return client_error(CHOICE_INVALID, f"{lead}; {how}.")
    advice = f"{how}:" if near is None else f"did you mean {cited(near)}?"
    return client_error(CHOICE_INVALID, f"{lead}; {advice}\n  {choices}")


def _label_fold(label: str) -> str:
    """A label as it compares with a caller's: trimmed and in lower case."""
    return label.strip().lower()


def _option_list(gap: Gap) -> str:
    """A gap's options as a refusal lists them, as `0 = Congo [DRC], 1 = Congo
    [Republic]`. A candidate with no label shows its spec id."""
    return ", ".join(
        f"{index} = {_shown_label(option)}" for index, option in enumerate(gap.options)
    )


def _shown_label(option: Candidate | Option) -> str:
    if option.label is not None:
        return option.label
    return option.spec.spec_id if isinstance(option, Candidate) else ""


def _options(gap: Gap) -> list[Option]:
    """A gap's options of place or source, without its candidates."""
    return [option for option in gap.options if isinstance(option, Option)]


def _mentions(gap: Gap) -> set[str]:
    return {mention for option in _options(gap) for mention in option.mentions}


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

    A placeholder loses the server's message and the part's choices, so it
    serves only a part Search gave no restatement.
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
    raise client_error(
        CHOICE_INVALID,
        f"Part {part.variable_text!r} has status {part.status!r}, which this client "
        "cannot post back; upgrade development-finance.",
    )


def _echo(part: Part, **members: Any) -> dict[str, Any]:
    """An entry with the members every non-parsed entry echoes from its part:
    `variable_text`, `separate` when true, and `operations` in their read forms
    when any item reads."""
    if not part.variable_text:
        raise client_error(
            CHOICE_INVALID,
            "A part without variable text cannot be posted back; search again.",
        )
    entry: dict[str, Any] = {**members, "variable_text": part.variable_text}
    if part.separate:
        entry["separate"] = True
    if operations := read_items(part.raw.get("operations"), read_requested_operation):
        entry["operations"] = operations
    return entry


def _identity(part: Part, spec: Mapping[str, Any]) -> dict[str, Any]:
    """A reading of `part` as Search takes it back: the spec's identity, its
    entity groups when it has any, and the reading's assumptions when the part
    carries them."""
    item: dict[str, Any] = {"identity": spec["definition"]["identity"]}
    groups = spec["resolved"].get("entity_groups")
    if isinstance(groups, Mapping) and groups:
        item["entity_groups"] = groups
    if (assumptions := _reading_assumptions(part, spec)) is not None:
        item["assumptions"] = assumptions
    return item


def _reading_assumptions(part: Part, spec: Mapping[str, Any]) -> list[Any] | None:
    """The assumptions one reading of `part` echoes, or None when the part holds
    no list for it. The list is a candidates part's `reading_assumptions` entry
    under the spec's id, or any other part's `assumptions`, each item in its read
    form and an item that does not read left out, so a list with none read
    echoes `[]`."""
    if isinstance(part, CandidatesPart):
        by_spec = part.raw.get("reading_assumptions")
        listed = by_spec.get(spec["spec_id"]) if isinstance(by_spec, Mapping) else None
    else:
        listed = part.raw.get("assumptions")
    return read_items(listed, read_assumption) if isinstance(listed, list) else None


def _identity_entry(part: Part, spec: Mapping[str, Any]) -> dict[str, Any]:
    return _echo(part, entry_kind="identity", **_identity(part, spec))


def _candidates_entry(part: CandidatesPart) -> dict[str, Any]:
    """The part's candidate set posted back, its `ordering` and `truncated` as
    the server sent them, each left out when the set lacks it."""
    candidate_set = part.raw["candidates"]
    echoed = {
        name: candidate_set[name]
        for name in ("ordering", "truncated")
        if name in candidate_set
    }
    return _echo(
        part,
        entry_kind="candidates",
        **echoed,
        candidates=[_identity(part, candidate.raw) for candidate in part.candidates],
    )


def _option_part(option: Option) -> Mapping[str, Any]:
    parts = option.data_query.get("parts")
    if not isinstance(parts, list) or len(parts) != 1:
        raise client_error(
            CONTRACT_VIOLATION,
            f"The option {option.label!r} does not carry a one-part parsed input",
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
        trace_id=answer.trace_id,
    )
