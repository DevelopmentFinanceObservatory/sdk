"""Tests for a search by series codes: the parsed input it posts, and the gap a
reading that is not its code's series alone leaves.

The answers come from `tests/data/search-codes.json`, a dev reply to the request
in `search-codes.request.json`: two IDS codes DFO holds exactly and one it does
not hold. The inexact cases change only `exact`, or add a second code, in that
reply.
"""

from typing import Any

import pytest

from dfo._core.errors import InvalidRequestError
from dfo._core.lookup_results import Entity, Match
from dfo._datasets.fetch import Session
from dfo._search.answer import AsyncAnswer, answer_from_body
from dfo._search.display import incomplete_message
from dfo._search.structured import parsed_input
from tests._data import load

KENYA = Entity("country/KEN", "Kenya", "country")


def no_session() -> Session:
    raise AssertionError("reading an answer sends no request")


def read(body: dict[str, Any], codes: list[str] | None = None) -> AsyncAnswer:
    return answer_from_body(body, question=None, source=no_session, codes=codes)


def test_the_recorded_request_is_what_the_keywords_build() -> None:
    built = parsed_input(
        ["DT.TDS.MLAT.CD", " DT.TDS.BLAT.CD", "XX.NOPE.CD"],
        entities={"destination": ["country/KEN"]},
        window=(2015, 2020),
    )
    assert built == load("search-codes.request.json")["input"]


@pytest.mark.parametrize(
    ("keywords", "expected"),
    [
        ({}, {}),
        ({"variable": " debt service "}, {"variable_text": "debt service"}),
        (
            {"entities": {"place": [KENYA]}},
            {"entities": [{"text": "Kenya", "dcid": "country/KEN"}]},
        ),
        (
            {
                "entities": {
                    "origin": [
                        Match(
                            "France",
                            "resolved",
                            Entity("country/FRA", "France", None),
                            (),
                            (),
                            {},
                        )
                    ],  # ty: ignore[invalid-argument-type]
                    "destination": [" country/KEN ", KENYA],
                }
            },
            {
                "entities": [
                    {"text": "France", "dcid": "country/FRA", "role_text": "from"},
                    {"text": "country/KEN", "dcid": "country/KEN", "role_text": "to"},
                    {"text": "Kenya", "dcid": "country/KEN", "role_text": "to"},
                ]
            },
        ),
        ({"window": "latest"}, {"time_text": "latest"}),
        ({"window": "all"}, {}),
        ({"open_roles": ("origin",)}, {"open_roles": ["origin"]}),
        ({"source": "IDS"}, {"sources": [{"text": "IDS"}]}),
        (
            {"entities": {"place": (entity for entity in [KENYA])}},
            {"entities": [{"text": "Kenya", "dcid": "country/KEN"}]},
        ),
    ],
    ids=[
        "code",
        "variable",
        "place",
        "flow",
        "latest",
        "all",
        "open",
        "source",
        "generator",
    ],
)
def test_each_keyword_fills_every_part(
    keywords: dict[str, Any], expected: dict[str, Any]
) -> None:
    built = parsed_input(["DT.TDS.MLAT.CD", "dt.tds.blat.cd"], **keywords)
    assert built["parts"] == [
        {"variable_text": code, "source_code": code, "separate": True, **expected}
        for code in ("DT.TDS.MLAT.CD", "dt.tds.blat.cd")
    ]


@pytest.mark.parametrize(
    "keywords",
    [
        {"codes": "DT.TDS.MLAT.CD"},
        {"codes": []},
        {"codes": ["DT.TDS.MLAT.CD", " "]},
        {"codes": ["DT.TDS.MLAT.CD", "dt.tds.mlat.cd"]},
        {"variable": ""},
        {"entities": ["country/KEN"]},
        {"entities": {"recipient": ["country/KEN"]}},
        {"entities": {"place": None}},
        {"entities": {"origin": []}},
        {"entities": {"place": "country/KEN"}},
        {"entities": {"place": {"country/KEN", "country/NGA"}}},
        {"entities": {"place": {"country/KEN": "Kenya"}.keys()}},
        {"window": (2020, 2015)},
        {"open_roles": "origin"},
        {"open_roles": ["place"]},
        {"source": 3},
    ],
    ids=[
        "codes-string",
        "codes-empty",
        "code-blank",
        "code-twice",
        "variable-empty",
        "entities-list",
        "entities-wire-word",
        "entities-none",
        "entities-empty",
        "entities-string",
        "entities-set",
        "entities-dict-view",
        "window-reversed",
        "open-roles-string",
        "open-roles-place",
        "source-number",
    ],
)
def test_a_keyword_that_breaks_its_rule_is_refused(keywords: dict[str, Any]) -> None:
    arguments = {"codes": ["DT.TDS.MLAT.CD"], **keywords}
    with pytest.raises(InvalidRequestError) as caught:
        parsed_input(arguments.pop("codes"), **arguments)
    assert caught.value.code == "invalid_argument"


def test_an_empty_binding_is_refused_in_searchs_own_words() -> None:
    with pytest.raises(InvalidRequestError) as caught:
        parsed_input(["DT.TDS.MLAT.CD"], entities={"origin": []})
    # `fetch` reads an empty binding as a role to drop with None, which a search
    # refuses, so its hint would send the caller to another refusal.
    assert "None" not in str(caught.value)


def test_an_unresolved_match_is_refused_as_fetch_refuses_it() -> None:
    ambiguous = Match("Congo", "ambiguous", None, (KENYA,), (), {})  # ty: ignore[invalid-argument-type]
    with pytest.raises(InvalidRequestError) as caught:
        parsed_input(["DT.TDS.MLAT.CD"], entities={"place": [ambiguous]})
    assert caught.value.code == "match_unresolved"


def held(entries: list[dict[str, Any]]) -> dict[str, Any]:
    """The recorded reply with its first part's source codes replaced."""
    body = load("search-codes.json")
    body["parts"][0]["spec"]["resolved"]["stat_vars"]["source_codes"] = entries
    return body


IDS = "provenance/WorldBankInternationalDebtStatistics"
MLAT = {"provenance": IDS, "code": "DT.TDS.MLAT.CD", "exact": True}


@pytest.mark.parametrize(
    ("entries", "gaps"),
    [
        ([MLAT], [(2, "no_data")]),
        ([{**MLAT, "code": "dt.tds.mlat.cd"}], [(2, "no_data")]),
        ([{**MLAT, "exact": False}], [(0, "no_data"), (2, "no_data")]),
        (
            [{"provenance": IDS, "code": "DT.TDS.MLAT.CD"}],
            [(0, "no_data"), (2, "no_data")],
        ),
        (
            [MLAT, {**MLAT, "code": "DT.TDS.MLAT.CD.X"}],
            [(0, "no_data"), (2, "no_data")],
        ),
        ([], [(0, "no_data"), (2, "no_data")]),
        ([MLAT, "DT.TDS.MLAT.CD"], [(0, "no_data"), (2, "no_data")]),
    ],
    ids=[
        "exact",
        "lower-case",
        "not-exact",
        "exact-left-out",
        "second-code",
        "none",
        "not-an-object",
    ],
)
@pytest.mark.parametrize("by", ["codes", "restatement"])
def test_a_reading_that_is_not_its_codes_series_alone_is_a_gap(
    entries: list[dict[str, Any]], gaps: list[tuple[int, str]], by: str
) -> None:
    codes = (
        ["DT.TDS.MLAT.CD", "DT.TDS.BLAT.CD", "XX.NOPE.CD"] if by == "codes" else None
    )
    answer = read(held(entries), codes)
    assert [(gap.part_index, gap.kind) for gap in answer.gaps] == gaps
    assert len(answer.specs) == 3 - len(gaps)
    assert not answer.complete


def test_a_code_gap_names_the_asked_code_and_the_codes_the_part_holds() -> None:
    answer = read(held([{**MLAT, "exact": False}, {**MLAT, "code": "DT.X"}]))
    message = answer.gaps[0].message
    assert '"DT.TDS.MLAT.CD" (not exact)' in message
    assert '"DT.X"' in message
    assert "series code" in message
    assert "dfo.fetch(answer.parts[0].spec)" in message
    lines = incomplete_message(answer).splitlines()
    assert lines[0] == "Search answered 1 of 3 series codes."
    assert lines[1].startswith('  missing  "DT.TDS.MLAT.CD": ')

    unlisted = read(held([]))
    assert "names no series code" in unlisted.gaps[0].message


def test_a_part_without_a_code_in_its_restatement_is_read_as_before() -> None:
    body = held([{**MLAT, "exact": False}])
    del body["parts"][0]["restatement"]["source_code"]
    assert [gap.part_index for gap in read(body).gaps] == [2]
