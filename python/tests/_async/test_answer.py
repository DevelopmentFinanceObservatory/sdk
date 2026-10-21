"""Tests for search and answers: gaps, choices, the incomplete-answer error and fetch.

Bodies come from dev (`tests/data/`); the place-choice ones add the `no_data.options`
the server's next build carries. `scripts/gen_sync.py` derives
`tests/_sync/test_answer.py` from this file, so the sync answer passes the same
tests.
"""

import copy
import json
import types
import warnings
from collections.abc import Callable, Mapping
from typing import Any

import httpx2
import pytest

import dfo._answer as answer_module
from dfo._answer import AsyncAnswer
from dfo._build import Reading
from dfo._dataset import build_dataset
from dfo._errors import (
    ContractError,
    DeclinedError,
    IncompleteAnswerError,
    InvalidRequestError,
    SearchWarning,
)
from dfo._fetch import Session
from dfo._parse import parse_assumptions
from dfo._search import search
from dfo._transport import AsyncTransport
from dfo._types import Candidate, CandidatesPart, DefinitePart, Gap

from .._data import load
from .._datasets import recorded_member

pytestmark = pytest.mark.anyio

BASE = "https://api.example.org/api"
RESOLVE = f"{BASE}/search/resolve"
TWO_PARTS = "Germany's ODA and GNI from 2015 to 2022"
# The `x-dfo-trace-id` header every Search response here carries.
TRACE = "7f3c0a5be2d94e1c8a6f0b2d4e6a8c10"


class Server:
    """Serves queued JSON bodies and records the JSON each request posted."""

    def __init__(self, *bodies: object) -> None:
        self.bodies = list(bodies)
        self.posted: list[Any] = []
        self.urls: list[str] = []
        self.read_timeouts: list[float | None] = []

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.posted.append(json.loads(request.content))
        self.urls.append(str(request.url))
        self.read_timeouts.append(request.extensions["timeout"]["read"])
        return httpx2.Response(
            200, json=self.bodies.pop(0), headers={"x-dfo-trace-id": TRACE}
        )


def transport(server: Server) -> AsyncTransport:
    return AsyncTransport(
        base_url=BASE, api_key=False, http_transport=httpx2.MockTransport(server)
    )


async def ask(question: str, *bodies: object) -> tuple[AsyncAnswer, Server]:
    server = Server(*bodies)
    client = transport(server)
    return await search(lambda: Session(client), question), server


def with_options(part: dict[str, Any]) -> dict[str, Any]:
    """An entity_ambiguous part with the options the server's next build carries."""
    part = copy.deepcopy(part)
    no_data = part["no_data"]
    base = no_data.pop("data_query")
    options = []
    for group in no_data["ambiguous_entities"]:
        for candidate in group["candidates"]:
            query = copy.deepcopy(base)
            for entity in query["parts"][0]["entities"]:
                if entity["text"] == group["text"]:
                    entity["dcid"] = candidate["ref"]
            options.append(
                {
                    "mentions": [group["text"]],
                    "label": candidate["label"],
                    "data_query": query,
                }
            )
    no_data["options"] = options
    return part


def summary(answer: AsyncAnswer) -> dict[str, Any]:
    """The answer as a contract scenario's `expect.answer` states it."""
    return {
        "kind": answer.kind,
        "status": answer.status,
        "complete": answer.complete,
        "specs": len(answer.specs),
        "gaps": [(g.part_index, g.kind, len(g.options)) for g in answer.gaps],
    }


@pytest.fixture
def fetched(monkeypatch: pytest.MonkeyPatch) -> list[tuple[Any, Any, Any]]:
    """Calls to a fake `fetch_members`, which returns the string "dataset"."""
    calls: list[tuple[Any, Any, Any]] = []

    async def fetch_members(transport: object, members: object, **options: Any) -> str:
        calls.append((transport, members, options))
        return "dataset"

    monkeypatch.setattr(answer_module, "fetch_members", fetch_members)
    return calls


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        (
            "search-1.json",
            {
                "kind": "resolution",
                "status": "definite",
                "complete": True,
                "specs": 1,
                "gaps": [],
            },
        ),
        (
            "search-2.json",
            {
                "kind": "resolution",
                "status": "candidates",
                "complete": False,
                "specs": 0,
                "gaps": [(0, "choice", 3)],
            },
        ),
        (
            "search-3.json",
            {
                "kind": "resolution",
                "status": "no_data",
                "complete": False,
                "specs": 0,
                "gaps": [(0, "choice", 0)],
            },
        ),
        (
            "search-4.json",
            {
                "kind": "resolution",
                "status": "mixed",
                "complete": False,
                "specs": 1,
                "gaps": [(1, "not_understood", 0)],
            },
        ),
        (
            "search-two-parts-candidates.json",
            {
                "kind": "resolution",
                "status": "mixed",
                "complete": False,
                "specs": 1,
                "gaps": [(1, "choice", 3)],
            },
        ),
        (
            "search-two-places.json",
            {
                "kind": "resolution",
                "status": "no_data",
                "complete": False,
                "specs": 0,
                "gaps": [(0, "choice", 0), (1, "choice", 0)],
            },
        ),
        (
            "search-declined.json",
            {
                "kind": "declined",
                "status": "declined",
                "complete": False,
                "specs": 0,
                "gaps": [],
            },
        ),
        (
            "search-catalogue.json",
            {
                "kind": "catalogue",
                "status": "catalogue",
                "complete": False,
                "specs": 0,
                "gaps": [],
            },
        ),
    ],
)
async def test_search_posts_the_question_and_reads_the_answer(
    body: str, expected: dict[str, Any]
) -> None:
    wire = load(body)
    question = wire["query_echo"]["raw_query"]
    answer, server = await ask(question, wire)
    assert server.urls == [RESOLVE]
    assert server.posted == [
        {"schema_version": 1, "input": {"kind": "raw_text", "query": question}}
    ]
    assert summary(answer) == expected
    assert answer.question == question
    if wire["kind"] == "resolution":
        assert answer.sentence == wire["rendered_sentence"]


@pytest.mark.parametrize(
    ("timeout", "read"), [(None, None), (60.0, 60.0), (90.0, 90.0)]
)
async def test_a_search_attempt_reads_until_the_search_deadline(
    timeout: float | None, read: float | None
) -> None:
    server = Server(load("search-1.json"))
    client = transport(server)
    await search(lambda: Session(client), "ODA", timeout=timeout)
    assert server.read_timeouts == [pytest.approx(read) if read else None]


async def test_a_candidates_gap_offers_its_candidates_as_options() -> None:
    answer, _ = await ask("GNI", load("search-2.json"))
    (gap,) = answer.gaps
    assert isinstance(gap.part, CandidatesPart)
    assert gap.options == gap.part.candidates
    assert all(a is b for a, b in zip(gap.options, gap.part.candidates, strict=True))


async def test_specs_hold_one_spec_per_distinct_spec_id() -> None:
    wire = load("search-two-parts-candidates.json")
    folded = copy.deepcopy(wire["parts"][0])
    folded["variable_text"] = "aid"
    wire["parts"][1] = folded
    answer, _ = await ask(TWO_PARTS, wire)
    assert [spec.spec_id for spec in answer.specs] == [
        wire["parts"][0]["spec"]["spec_id"]
    ]


async def test_a_timed_out_answer_makes_every_no_data_part_a_timed_out_gap() -> None:
    wire = load("search-4.json")
    wire["diagnostics"]["timed_out"] = True
    answer, _ = await ask("debt", wire)
    assert [(gap.part_index, gap.kind) for gap in answer.gaps] == [(1, "timed_out")]
    assert answer.timed_out


async def test_unknown_and_unsupported_parts_are_gaps() -> None:
    wire = load("search-4.json")
    wire["parts"][0]["status"] = "partly_definite"
    wire["parts"][1] = {
        **wire["parts"][1],
        "status": "unsupported",
        "unsupported": {"code": "unit_request_unsupported", "detail": "No per-capita."},
    }
    answer, _ = await ask("debt", wire)
    assert [(gap.kind, gap.message) for gap in answer.gaps] == [
        (
            "unknown",
            "Search answered this part with status 'partly_definite', which this "
            "client does not know; upgrade development-finance.",
        ),
        ("unsupported", "No per-capita."),
    ]
    assert answer.specs == ()


async def test_an_unknown_answer_kind_raises_contract_error() -> None:
    wire = load("search-1.json")
    wire["kind"] = "essay"
    wire["trace_id"] = "body-trace"
    with pytest.raises(ContractError) as caught:
        await ask("ODA", wire)
    assert (caught.value.code, caught.value.pointer) == ("contract_violation", None)
    # The body's trace id outranks the header's.
    assert caught.value.trace_id == "body-trace"


async def test_a_part_without_its_payload_names_the_member_missing() -> None:
    wire = load("search-two-parts-candidates.json")
    del wire["parts"][1]["candidates"]["specs"][2]["definition"]
    with pytest.raises(ContractError) as caught:
        await ask(TWO_PARTS, wire)
    assert (caught.value.code, caught.value.pointer) == (
        "contract_violation",
        "/parts/1/candidates/specs/2/definition",
    )
    assert caught.value.trace_id == TRACE


AID_TYPE = {
    "kind": "declared_default",
    "binding_ref": "how:dac2aAidType",
    "text": "official development assistance",
    "refs": ["DAC2aAidType206"],
}


def picked(part: Mapping[str, Any], index: int) -> dict[str, Any]:
    """Search's answer to a pick of candidate `index`: that reading, definite,
    with a sentence of its own."""
    spec = copy.deepcopy(part["candidates"]["specs"][index])
    sentence = spec["resolved"]["rendered_sentence"] + " Assumed: one reading."
    spec["resolved"]["rendered_sentence"] = sentence
    return {
        "kind": "resolution",
        "status": "definite",
        "rendered_sentence": sentence,
        "parts": [
            {
                "status": "definite",
                "variable_text": part["variable_text"],
                "spec": spec,
                "assumptions": [AID_TYPE],
            }
        ],
        "diagnostics": {},
    }


def identity_entry(
    part: Mapping[str, Any], index: int, **echoed: Any
) -> dict[str, Any]:
    """The dataset_resubmit entry a pick of candidate `index` posts."""
    spec = part["candidates"]["specs"][index]
    return {
        "entry_kind": "identity",
        "identity": spec["definition"]["identity"],
        "variable_text": part["variable_text"],
        **echoed,
    }


@pytest.mark.parametrize(
    ("reading_assumptions", "echoed"),
    [
        (None, {}),
        ({}, {}),
        ({1: [AID_TYPE]}, {"assumptions": [AID_TYPE]}),
        ({1: []}, {"assumptions": []}),
    ],
)
async def test_a_pick_in_a_one_part_answer_asks_search_for_the_reading(
    reading_assumptions: dict[int, Any] | None, echoed: dict[str, Any]
) -> None:
    wire = load("search-2.json")
    part = wire["parts"][0]
    specs = part["candidates"]["specs"]
    if reading_assumptions is not None:
        part["reading_assumptions"] = {
            specs[index]["spec_id"]: items
            for index, items in reading_assumptions.items()
        }
    answer, server = await ask(
        "GNI of Germany from 2015 to 2022", wire, picked(part, 1), picked(part, 1)
    )
    assert answer.parts[0].candidates[1].assumptions == tuple(
        parse_assumptions(echoed.get("assumptions"))
    )
    chosen = await answer.choose(1)
    by_label = await answer.choose(answer.parts[0].candidates[1].label)
    request = {
        "schema_version": 1,
        "input": {
            "kind": "dataset_resubmit",
            "entries": [identity_entry(part, 1, **echoed)],
        },
    }
    assert server.posted[1:] == [request, request]
    assert chosen == by_label
    assert summary(chosen) == {
        "kind": "resolution",
        "status": "definite",
        "complete": True,
        "specs": 1,
        "gaps": [],
    }
    assert chosen.sentence == picked(part, 1)["rendered_sentence"]
    (definite,) = chosen.parts
    assert isinstance(definite, DefinitePart)
    assert definite.spec.spec_id == specs[1]["spec_id"]
    assert definite.assumptions == parse_assumptions([AID_TYPE])


async def test_a_candidate_choice_beside_a_definite_part_posts_dataset_resubmit() -> (
    None
):
    answer, server = await ask(
        TWO_PARTS,
        load("search-two-parts-candidates.json"),
        load("probe-resubmit-candidate-chosen.json"),
    )
    chosen = await answer.choose("gross national income", 0)
    recorded = load("probe-resubmit-candidate-chosen.request.json")
    del recorded["input"]["raw_query"]  # echo only; the client posts none
    assert server.posted[1] == recorded
    assert summary(chosen) == {
        "kind": "resolution",
        "status": "definite",
        "complete": True,
        "specs": 2,
        "gaps": [],
    }
    assert chosen.specs[1] == answer.parts[1].candidates[0].spec


async def test_a_candidate_fetches_as_the_answer_that_chooses_it(
    fetched: list[tuple[Any, Any, Any]],
) -> None:
    wire = load("search-2.json")
    part = wire["parts"][0]
    answer, server = await ask(
        "GNI of Germany from 2015 to 2022", wire, picked(part, 1), picked(part, 1)
    )
    (candidates,) = answer.parts
    assert isinstance(candidates, CandidatesPart)
    assert await candidates.candidates[1].fetch(layout="long", timeout=10.0) == (
        "dataset"
    )
    assert await (await answer.choose(1)).fetch(layout="long", timeout=10.0) == (
        "dataset"
    )
    assert server.posted[1] == server.posted[2]
    (_, by_candidate, options), (_, by_choice, chosen_options) = fetched
    assert by_candidate == by_choice
    assert options == chosen_options
    assert [(m.spec, m.sentence) for m in by_candidate] == [
        (candidates.candidates[1].spec, picked(part, 1)["rendered_sentence"])
    ]


async def test_a_candidate_beside_a_definite_part_fetches_only_its_reading(
    fetched: list[tuple[Any, Any, Any]],
) -> None:
    wire = load("search-two-parts-candidates.json")
    part = wire["parts"][1]
    answer, server = await ask(TWO_PARTS, wire, picked(part, 0))
    candidates = answer.parts[1]
    assert isinstance(candidates, CandidatesPart)
    candidate = candidates.candidates[0]
    assert await candidate.fetch(layout="frame") == "dataset"
    assert server.posted[1]["input"] == {
        "kind": "dataset_resubmit",
        "entries": [identity_entry(part, 0)],
    }
    ((_, members, options),) = fetched
    assert [(m.parts, m.spec) for m in members] == [
        (("gross national income",), candidate.spec)
    ]
    assert (options["layout"], options["missing"]) == ("frame", ())
    assert answer.gaps[0].part.candidates == candidates.candidates


async def test_a_place_choice_in_a_one_part_answer_posts_the_option_unchanged() -> None:
    wire = load("search-3.json")
    wire["parts"][0] = with_options(wire["parts"][0])
    answer, server = await ask(
        "ODA disbursements from Germany to Congo",
        wire,
        load("probe-option-posted.json"),
    )
    assert summary(answer)["gaps"] == [(0, "choice", 2)]
    chosen = await answer.choose("Congo", "Congo [DRC]")
    assert server.posted[1] == load("probe-option-posted.request.json")
    assert summary(chosen)["status"] == "definite"
    assert chosen.complete


@pytest.mark.parametrize("data_query", [None, {"parts": []}])
async def test_a_place_option_without_a_one_part_query_raises_before_posting(
    data_query: dict[str, Any] | None,
) -> None:
    wire = load("search-3.json")
    wire["parts"][0] = with_options(wire["parts"][0])
    option = wire["parts"][0]["no_data"]["options"][0]
    if data_query is None:
        del option["data_query"]
    else:
        option["data_query"] = data_query
    answer, server = await ask("ODA disbursements from Germany to Congo", wire)
    with pytest.raises(ContractError) as caught:
        await answer.choose(0)
    assert caught.value.code == "contract_violation"
    # The option belongs to the answer, so the error carries its response's trace.
    assert caught.value.trace_id == TRACE
    assert len(server.posted) == 1


async def test_a_place_choice_beside_a_definite_part_posts_its_parsed_part() -> None:
    wire = load("search-1.json")
    wire["parts"].append(with_options(load("search-3.json")["parts"][0]))
    wire["status"] = "mixed"
    answer, server = await ask("ODA", wire, load("probe-resubmit-option-chosen.json"))
    chosen = await answer.choose("Congo", 0)
    assert server.posted[1] == load("probe-resubmit-option-chosen.request.json")
    assert summary(chosen) == {
        "kind": "resolution",
        "status": "definite",
        "complete": True,
        "specs": 2,
        "gaps": [],
    }


async def test_parts_left_alone_post_their_restatement_or_a_placeholder() -> None:
    wire = load("search-4.json")
    wire["parts"][0] = with_options(load("search-3.json")["parts"][0])
    answer, server = await ask("debt", wire, load("search-3.json"))
    await answer.choose(0, "Congo [Republic]")
    entries = server.posted[1]["input"]["entries"]
    assert entries[0]["entry_kind"] == "parsed"
    assert entries[0]["part"]["entities"][1]["dcid"] == "country/COG"
    assert entries[1] == {
        "entry_kind": "placeholder",
        "status": "no_data",
        "reason": "variable_not_resolved",
        "variable_text": "price of tea",
    }

    places = load("search-two-places.json")
    places["parts"][1] = with_options(places["parts"][1])
    answer, server = await ask("places", places, load("search-3.json"))
    await answer.choose(1, 0)
    first = server.posted[1]["input"]["entries"][0]
    assert first == {"entry_kind": "parsed", "part": places["parts"][0]["restatement"]}


def beside_a_candidates_part(part: dict[str, Any]) -> dict[str, Any]:
    """search-2.json's candidates part, with `part` after it."""
    wire = load("search-2.json")
    wire["parts"].append(part)
    wire["status"] = "mixed"
    return wire


def without_variable_text() -> dict[str, Any]:
    part = load("search-4.json")["parts"][1]
    del part["variable_text"]
    return beside_a_candidates_part(part)


def unknown_without_restatement() -> dict[str, Any]:
    return beside_a_candidates_part({"status": "pondering", "variable_text": "tea"})


def options_sharing_a_label() -> dict[str, Any]:
    wire = load("search-3.json")
    wire["parts"][0] = with_options(wire["parts"][0])
    options = wire["parts"][0]["no_data"]["options"]
    options[1]["label"] = options[0]["label"]
    return wire


@pytest.mark.parametrize(
    ("body", "call"),
    [
        (lambda: load("search-1.json"), (0,)),
        (lambda: load("search-two-places.json"), (0,)),
        (lambda: load("search-3.json"), (0,)),
        (lambda: load("search-2.json"), (3,)),
        (lambda: load("search-2.json"), ("GNI", "nope")),
        (lambda: load("search-4.json"), (0, 0)),
        (lambda: load("search-4.json"), ("tea", 0)),
        (lambda: load("search-4.json"), (5, 0)),
        (without_variable_text, (0, 0)),
        (unknown_without_restatement, (0, 0)),
        (options_sharing_a_label, (0, "Congo [DRC]")),
    ],
    ids=[
        "no-gap",
        "several-gaps-unnamed",
        "no-choice-offered",
        "option-out-of-range",
        "no-such-label",
        "part-has-a-reading",
        "no-such-part-name",
        "part-out-of-range",
        "part-without-variable-text",
        "unknown-status-without-restatement",
        "options-share-a-label",
    ],
)
async def test_a_choice_that_cannot_be_made_raises_invalid_request(
    body: Callable[[], dict[str, Any]], call: tuple[Any, ...]
) -> None:
    answer, server = await ask("q", body())
    with pytest.raises(InvalidRequestError) as caught:
        await answer.choose(*call)
    assert caught.value.code == "choice_invalid"
    # A choice the caller cannot make describes the caller's input.
    assert caught.value.trace_id is None
    assert len(server.posted) == 1


async def test_a_resubmit_echoes_a_parts_separate_flag_and_operations() -> None:
    definite = load("search-1.json")["parts"][0]
    definite["separate"] = True
    operations = [{"verb": "share", "phrase": "as a share of GNI"}]
    definite["operations"] = operations
    answer, server = await ask(
        "q", beside_a_candidates_part(definite), load("search-1.json")
    )
    await answer.choose(0, 0)
    entry = server.posted[1]["input"]["entries"][1]
    assert (entry["entry_kind"], entry["separate"], entry["operations"]) == (
        "identity",
        True,
        operations,
    )


async def test_fetch_builds_one_member_per_distinct_spec(
    fetched: list[tuple[Any, Any, Any]],
) -> None:
    wire = load("probe-resubmit-candidate-chosen.json")
    folded = copy.deepcopy(wire["parts"][0])
    folded["variable_text"] = "aid"
    wire["parts"].append(folded)
    unnamed = copy.deepcopy(folded)
    unnamed["variable_text"] = ""
    wire["parts"].append(unnamed)
    answer, _ = await ask(TWO_PARTS, wire)
    assert await answer.fetch(layout="long", timeout=10.0) == "dataset"
    ((transport_used, members, options),) = fetched
    oda, gni = wire["parts"][0]["spec"], wire["parts"][1]["spec"]
    assert [(m.parts, m.spec.spec_id, m.sentence) for m in members] == [
        (
            # The part without variable text names nothing.
            ("official development assistance", "aid"),
            oda["spec_id"],
            oda["resolved"]["rendered_sentence"],
        ),
        (
            ("gross national income",),
            gni["spec_id"],
            gni["resolved"]["rendered_sentence"],
        ),
    ]
    assert options == {
        "layout": "long",
        "strict": False,
        "timeout": 10.0,
        "progress": None,
        "cache": None,
        "missing": (),
    }
    assert isinstance(transport_used, AsyncTransport)
    assert [len(m.answer_parts) for m in members] == [3, 1]
    assert all(isinstance(m, Reading) for m in members)


async def test_fetch_reads_the_transport_when_it_runs(
    fetched: list[tuple[Any, Any, Any]],
) -> None:
    clients = [transport(Server(load("search-1.json")))]
    answer = await search(lambda: Session(clients[-1]), "ODA")
    clients.append(transport(Server()))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", SearchWarning)
        await answer.fetch()
    assert fetched[0][0] is clients[1]


async def test_fetch_of_an_incomplete_answer_raises_before_any_build(
    fetched: list[tuple[Any, Any, Any]],
) -> None:
    answer, _ = await ask(TWO_PARTS, load("search-two-parts-candidates.json"))
    with pytest.raises(IncompleteAnswerError) as caught:
        await answer.fetch()
    assert str(caught.value) == "\n".join(
        [
            "Search answered 1 of 2 parts of your question.",
            '  answered "official development assistance": Germany\'s gross '
            "disbursements for official development assistance, 2015 to 2022. "
            "Current US dollars · OECD DAC1.",
            '  missing  "gross national income": 3 readings',
            "    [0] Germany's primary income for gross of fixed capital "
            "consumption, 2015 to 2022 · OECD DAC1 · Current US dollars",
            "    [1] Germany's gross national income based on purchasing power "
            "parity in international dollars, 2015 to 2022 · World Development "
            "Indicators",
            "    [2] Germany's gross national income based on purchasing power "
            "parity per capita in international dollars, 2015 to 2022 · World "
            "Development Indicators",
            '  Choose: answer.choose("gross national income", 0).fetch()',
            "  Or take the answered part: answer.fetch(partial=True)",
        ]
    )
    assert caught.value.answer is answer
    assert_unbound(caught.value.gaps, answer.gaps)
    assert caught.value.code == "answer_incomplete"
    assert fetched == []


async def test_a_partial_fetch_builds_the_answered_parts_and_names_the_gaps(
    fetched: list[tuple[Any, Any, Any]],
) -> None:
    answer, _ = await ask("debt", load("search-4.json"))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", SearchWarning)
        await answer.fetch(partial=True)
    ((_, members, options),) = fetched
    assert [m.parts for m in members] == [("debt service",)]
    assert options["missing"] == answer.gaps

    nothing, _ = await ask("tea", load("search-3.json"))
    with pytest.raises(IncompleteAnswerError):
        await nothing.fetch(partial=True)
    assert len(fetched) == 1


def assert_unbound(
    held: tuple[Gap[Candidate], ...], gaps: tuple[Gap[Any], ...]
) -> None:
    """`held` is `gaps` with every candidate bound to no answer."""
    assert [(g.part_index, g.kind, g.message) for g in held] == [
        (g.part_index, g.kind, g.message) for g in gaps
    ]
    candidates = [
        (candidate, original)
        for gap, source in zip(held, gaps, strict=True)
        if isinstance(gap.part, CandidatesPart)
        and isinstance(source.part, CandidatesPart)
        for candidate, original in zip(
            gap.part.candidates, source.part.candidates, strict=True
        )
    ]
    for gap in held:
        if isinstance(gap.part, CandidatesPart):
            assert all(
                a is b for a, b in zip(gap.options, gap.part.candidates, strict=True)
            )
            assert len(gap.options) == len(gap.part.candidates)
    assert candidates
    for candidate, original in candidates:
        assert type(candidate) is Candidate
        assert candidate.spec == original.spec
        with pytest.raises(InvalidRequestError) as caught:
            candidate.fetch()
        assert caught.value.code == "invalid_argument"


def client_references(value: object) -> list[str]:
    """The transports and functions reachable through `value`'s members and the
    closures of its functions."""
    found: list[str] = []
    seen: set[int] = set()
    pending = [value]
    while pending:
        item = pending.pop()
        if id(item) in seen:
            continue
        seen.add(id(item))
        if isinstance(item, AsyncTransport | httpx2.AsyncClient):
            found.append(type(item).__name__)
        elif isinstance(item, types.FunctionType):
            found.append("function")
            pending.extend(cell.cell_contents for cell in item.__closure__ or ())
        elif isinstance(item, Mapping):
            pending.extend(item.values())
        elif isinstance(item, tuple | list):
            pending.extend(item)
        elif hasattr(type(item), "__dataclass_fields__"):
            pending.extend(
                getattr(item, name) for name in type(item).__dataclass_fields__
            )
    return found


async def test_a_partial_fetch_holds_no_client_in_its_dataset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fetch_members(
        transport: object, members: object, **options: Any
    ) -> object:
        return build_dataset(
            [recorded_member()],
            layout="long",
            complete=False,
            missing=options["missing"],
            stale=False,
        )

    monkeypatch.setattr(answer_module, "fetch_members", fetch_members)
    answer, _ = await ask(TWO_PARTS, load("search-two-parts-candidates.json"))
    # The answer itself reaches its transport, so the walk can find one.
    assert "AsyncTransport" in client_references(answer)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", SearchWarning)
        data = await answer.fetch(partial=True)
    assert_unbound(data.missing, answer.gaps)
    assert client_references(data) == []


@pytest.mark.parametrize("body", ["search-declined.json", "search-catalogue.json"])
async def test_fetch_of_a_declined_or_catalogue_answer_raises_declined(
    body: str, fetched: list[tuple[Any, Any, Any]]
) -> None:
    answer, _ = await ask("q", load(body))
    with pytest.raises(DeclinedError) as caught:
        await answer.fetch()
    assert caught.value.detail == load(body).get("reason", "catalogue")
    assert caught.value.code == "answer_declined"
    assert str(caught.value) == repr(answer)
    assert answer.sentence is None
    assert fetched == []


async def test_differences_from_the_question_arrive_as_one_search_warning(
    fetched: list[tuple[Any, Any, Any]],
) -> None:
    answer, _ = await ask("top 5 donors to Ethiopia in 2022", load("search-top5.json"))
    with pytest.warns(SearchWarning) as caught:
        await answer.fetch()
    assert len(caught) == 1
    assert str(caught[0].message).splitlines() == [
        "Search's reading differs from your question:",
        '  Not done: rank ("top 5 donors")',
        "  You asked for a ranking. This shows the amounts behind it, because "
        "Search does not compute rankings.",
        "  Note: No aid type was named, so the answer covers official development "
        "assistance.",
        "  Note: no provider was named; the answer was resolved across every "
        "provider with data.",
    ]
    with pytest.raises(SearchWarning):
        await answer.fetch(strict=True)
    assert len(fetched) == 1


async def test_an_answer_holds_no_data_methods() -> None:
    answer, _ = await ask("ODA", load("search-1.json"))
    with pytest.raises(AttributeError, match="holds readings, not data"):
        answer.to_pandas()  # ty: ignore[unresolved-attribute]
    assert not hasattr(answer, "__arrow_c_stream__")
    assert not hasattr(answer, "anything_else")
