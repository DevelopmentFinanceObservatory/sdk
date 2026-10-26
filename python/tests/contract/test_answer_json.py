"""The answer format: `answer.to_json()` and `Answer.from_json`, on both clients.

The fixture is the TypeScript client's, read from its path, so both clients write
and read the same JSON. It is the first Search response of the
`choose-candidate-two-parts` scenario in the answer format, and the replays here
serve that scenario's exchanges.
"""

import asyncio
import json
import warnings
from collections.abc import Callable
from typing import Any

import pytest

from dfo._client import default as _default
from dfo._client.client import AsyncClient
from dfo._core.errors import (
    ContractError,
    DfoError,
    DfoWarning,
    IncompleteAnswerError,
)
from dfo._core.types import FormatError
from dfo._search.answer import AsyncAnswer
from dfo._sync._client.client import Client
from dfo._sync._search.answer import Answer
from tests._data import CONTRACT
from tests.contract.test_replay import (
    BASE_URLS,
    SCENARIOS,
    Clock,
    Exchanges,
    Pollers,
    _client,
    _settle,
)

FIXTURE = (
    CONTRACT.parent / "typescript/test/data/answer-choose-candidate-two-parts.json"
).read_text()
RECORD = SCENARIOS["choose-candidate-two-parts"]
FLAVOURS = ["async", "sync"]


def answer_class(flavour: str) -> type[AsyncAnswer] | type[Answer]:
    return AsyncAnswer if flavour == "async" else Answer


def serving(
    flavour: str, monkeypatch: pytest.MonkeyPatch, start: int, stop: int | None = None
) -> tuple[AsyncClient | Client, Exchanges]:
    """A client that the scenario's exchanges from `start` to `stop` answer."""
    record = {**RECORD, "exchanges": RECORD["exchanges"][start:stop]}
    exchanges = Exchanges(record, BASE_URLS["api-path"])
    clock = Clock(Pollers(monkeypatch).poll_waits)
    return _client(flavour, BASE_URLS["api-path"], exchanges, clock), exchanges


def searched(flavour: str, monkeypatch: pytest.MonkeyPatch) -> Any:
    """The scenario's answer, read from its recorded Search response."""
    client, _ = serving(flavour, monkeypatch, 0, 1)
    question = RECORD["call"][0]["question"]
    return asyncio.run(_settle(client.search(question)))


def revive(flavour: str, text: str, client: AsyncClient | Client) -> Any:
    return answer_class(flavour).from_json(text, client=client)  # ty: ignore[invalid-argument-type]


async def choose_and_fetch(answer: Any) -> Any:
    step = RECORD["call"][1]
    chosen = await _settle(answer.choose(step["option"], part=step["part"]))
    # The recorded reading differs from the question and its coverage falls short.
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DfoWarning)
        return await _settle(chosen.fetch())


def content_versions(data: Any) -> list[str]:
    return [member.content_version for member in data.members]


EXPECTED_VERSIONS = [
    member["content_version"] for member in RECORD["expect"][2]["dataset"]["members"]
]


@pytest.mark.parametrize("flavour", FLAVOURS)
def test_the_recorded_answer_writes_the_fixture_and_the_fixture_reads_back(
    flavour: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    answer = searched(flavour, monkeypatch)
    assert json.loads(answer.to_json()) == json.loads(FIXTURE)
    client, _ = serving(flavour, monkeypatch, 1)
    assert json.loads(revive(flavour, FIXTURE, client).to_json()) == json.loads(FIXTURE)


@pytest.mark.parametrize("flavour", FLAVOURS)
def test_a_revived_fixture_chooses_and_fetches_as_the_recorded_answer(
    flavour: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, exchanges = serving(flavour, monkeypatch, 1)
    data = asyncio.run(choose_and_fetch(revive(flavour, FIXTURE, client)))
    assert exchanges.pending == []
    assert content_versions(data) == EXPECTED_VERSIONS


def test_a_sync_answer_revived_without_a_client_goes_through_the_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, exchanges = serving("sync", monkeypatch, 1)
    monkeypatch.setattr(_default, "_client", client)
    data = asyncio.run(choose_and_fetch(Answer.from_json(FIXTURE)))
    assert exchanges.pending == []
    assert content_versions(data) == EXPECTED_VERSIONS


@pytest.mark.parametrize("flavour", FLAVOURS)
def test_a_revived_answer_keeps_its_question_text_gaps_and_trace_id(
    flavour: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    answer = searched(flavour, monkeypatch)
    client, exchanges = serving(flavour, monkeypatch, 1)
    revived = revive(flavour, answer.to_json(), client)
    assert revived.question == answer.question
    assert revived.sentence == answer.sentence
    assert repr(revived) == repr(answer)
    assert revived.gaps == answer.gaps
    # This response carries its trace id in a header, which the JSON keeps.
    assert answer.trace_id is not None
    assert revived.trace_id == answer.trace_id
    with pytest.raises(IncompleteAnswerError) as caught:
        asyncio.run(_settle(revived.fetch()))
    assert caught.value.trace_id == answer.trace_id
    assert len(exchanges.pending) == len(RECORD["exchanges"]) - 1


def edited(change: Callable[[dict[str, Any]], object]) -> str:
    value = json.loads(FIXTURE)
    replaced = change(value)
    return json.dumps(value if replaced is None else replaced)


@pytest.mark.parametrize(
    ("text", "pointer"),
    [
        ("{", ""),
        (edited(lambda value: [value]), ""),
        (edited(lambda value: value.__delitem__("question")), "/question"),
        (edited(lambda value: value.update(extra=1)), "/extra"),
        (edited(lambda value: value.update(format_version=2)), "/format_version"),
        (edited(lambda value: value.update(format_version=True)), "/format_version"),
        (edited(lambda value: value.update(question=5)), "/question"),
        (edited(lambda value: value.update(answer=[])), "/answer"),
    ],
    ids=[
        "not-json",
        "not-an-object",
        "a-missing-member",
        "a-member-the-format-does-not-name",
        "another-format-version",
        "a-boolean-format-version",
        "a-question-that-is-not-a-string",
        "an-answer-that-is-not-an-object",
    ],
)
@pytest.mark.parametrize("flavour", FLAVOURS)
def test_text_outside_the_format_raises_format_invalid(
    flavour: str, text: str, pointer: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, _ = serving(flavour, monkeypatch, 1)
    with pytest.raises(FormatError) as caught:
        revive(flavour, text, client)
    assert (caught.value.reason, caught.value.pointer) == ("format_invalid", pointer)


@pytest.mark.parametrize("flavour", FLAVOURS)
def test_the_body_is_checked_as_a_fresh_search_response_with_its_trace_id(
    flavour: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    value = json.loads(FIXTURE)
    del value["answer"]["parts"][1]["status"]
    client, _ = serving(flavour, monkeypatch, 1)
    with pytest.raises(ContractError) as caught:
        revive(flavour, json.dumps(value), client)
    error: DfoError = caught.value
    assert (error.code, caught.value.pointer) == (
        "contract_violation",
        "/parts/1/status",
    )
    assert error.trace_id == value["answer"]["trace_id"]
