"""Tests for how an answer reads: its text, its notebook HTML and its status line."""

import sys
import types
from typing import Any

import pytest

from dfo import _display
from dfo._answer import AsyncAnswer, answer_from_body
from dfo._transport import AsyncTransport

from ._data import load


def no_transport() -> AsyncTransport:
    raise AssertionError("the display sends no request")


def read(body: str | dict[str, Any]) -> AsyncAnswer:
    wire = load(body) if isinstance(body, str) else body
    return answer_from_body(wire, question="q", source=no_transport)


def test_a_complete_answer_reads_as_its_sentence_and_what_search_did_not_do() -> None:
    wire = load("search-top5.json")
    assert repr(read(wire)).splitlines() == [
        wire["rendered_sentence"],
        '  Not done: rank ("top 5 donors")',
        "  Note: No aid type was named, so the answer covers official development "
        "assistance.",
        "  Note: no provider was named; the answer was resolved across every "
        "provider with data.",
    ]


def test_info_warnings_stay_hidden() -> None:
    wire = load("search-1.json")
    wire["parts"][0]["warnings"][0]["severity"] = "info"
    assert repr(read(wire)) == wire["rendered_sentence"]


def test_an_incomplete_answer_reads_as_what_is_answered_and_missing() -> None:
    assert repr(read("search-4.json")).splitlines() == [
        "Answered 1 of 2 parts of your question.",
        '  answered "debt service": Kenya\'s external debt service owed to all '
        "creditors, 1970 to 2024. Current US dollars · World Bank International "
        "Debt Statistics (IDS).",
        '  missing  "price of tea": Could not match "price of tea" to a supported '
        "indicator. Try a different wording or a related indicator.",
        "  Or take the answered part: answer.fetch(partial=True)",
    ]


def test_a_one_part_answer_chooses_a_candidate_by_index_alone() -> None:
    lines = repr(read("search-2.json")).splitlines()
    assert lines[0] == "Answered 0 of 1 part of your question."
    assert lines[-1] == "  Choose: answer.choose(0).fetch()"


def test_a_place_choice_names_the_word_it_settles_and_the_first_option() -> None:
    wire = load("search-3.json")
    part = wire["parts"][0]["no_data"]
    part["options"] = [
        {"mentions": ["Congo"], "label": label, "data_query": {}}
        for label in ("Congo [DRC]", "Congo [Republic]")
    ]
    assert repr(read(wire)).splitlines()[-3:] == [
        "    [0] Congo [DRC]",
        "    [1] Congo [Republic]",
        '  Choose: answer.choose("Congo", "Congo [DRC]").fetch()',
    ]


def test_a_declined_answer_reads_as_its_reason() -> None:
    assert repr(read("search-declined.json")) == (
        "Search declined the question: it asks for an argument and names no data "
        "to show."
    )


def test_the_html_escapes_every_server_string() -> None:
    wire = load("search-4.json")
    wire["parts"][1]["no_data"]["message"] = "<script>alert(1)</script>"
    wire["parts"][0]["spec"]["resolved"]["rendered_sentence"] = "Debt & <b>more</b>"
    page = read(wire)._repr_html_()
    assert "<script>" not in page
    assert "<b>" not in page
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in page
    assert "Debt &amp; &lt;b&gt;more&lt;/b&gt;" in page


def test_the_status_line_shows_only_inside_a_notebook(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    shown: list[Any] = []

    class Handle:
        def update(self, data: dict[str, str], *, raw: bool) -> None:
            shown.append(("update", data))

    def display(data: dict[str, str], *, raw: bool, display_id: bool) -> Handle:
        shown.append(("display", data))
        return Handle()

    with _display.search_status("ODA"):
        pass
    assert shown == []

    ipython = types.ModuleType("IPython")
    ipython.get_ipython = lambda: types.SimpleNamespace(kernel=object())  # ty: ignore[unresolved-attribute]
    ipython_display = types.ModuleType("IPython.display")
    ipython_display.display = display  # ty: ignore[unresolved-attribute]
    monkeypatch.setitem(sys.modules, "ipykernel", types.ModuleType("ipykernel"))
    monkeypatch.setitem(sys.modules, "IPython", ipython)
    monkeypatch.setitem(sys.modules, "IPython.display", ipython_display)
    with _display.search_status("ODA"):
        assert shown == [("display", {"text/plain": "Searching DFO: ODA"})]
    assert shown[-1] == ("update", {"text/plain": ""})

    shown.clear()
    monkeypatch.setenv("DFO_PROGRESS", "0")
    with _display.search_status("ODA"):
        pass
    assert shown == []
