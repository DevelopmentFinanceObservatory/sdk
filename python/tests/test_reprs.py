"""Every public value object prints one or two short lines that name it."""

import json
import unicodedata
from collections.abc import Callable
from datetime import UTC, date, datetime

import pytest

import dfo
from dfo._core.errors import (
    DataWarning,
    DfoWarning,
    NotFoundError,
    SearchWarning,
    SeriesLeftOutWarning,
)
from dfo._core.lookup_results import (
    Catalogue,
    Code,
    Entity,
    Match,
    Node,
    read_matches,
)
from dfo._core.parse import parse_parts
from dfo._core.periods import latest_year
from dfo._core.refs import DatasetRef, Member, RefMember
from dfo._core.types import (
    Assumption,
    CandidatesPart,
    Citation,
    CitationSource,
    DefinitePart,
    Departure,
    Gap,
    NoDataPart,
    Notice,
    Option,
    RawResponse,
    Rendering,
    RequestedOperation,
    Spec,
    UnknownPart,
    UnsupportedPart,
)
from dfo._datasets.analysis import AsyncAnalysis
from dfo._datasets.bundle import BundleLimits
from dfo._datasets.cards import AsyncCards
from dfo._datasets.dataset import Dataset, LeftOutSeries, LeftOutStep, build_dataset
from dfo._datasets.publication import Card, Served, Share
from dfo._datasets.recipe import recipe
from dfo._search.lookups import AsyncLookup
from dfo._sync._search.answer import Answer
from tests._data import load
from tests._datasets import recorded_member

SPEC_ID = "spec_" + "3f1a" * 8
LONG = "Kenya's percent of total government expenditure on education, 2015 to 2022"


def _definite() -> DefinitePart:
    (part,) = parse_parts(load("search-1.json"))
    assert isinstance(part, DefinitePart)
    return part


def _candidates() -> CandidatesPart:
    parts = parse_parts(load("search-two-parts-candidates.json"))
    (part,) = (part for part in parts if isinstance(part, CandidatesPart))
    return part


def _gap() -> Gap:
    part = _candidates()
    return Gap(1, part, "choice", "Choose a reading.", part.candidates)


def _lookup() -> object:
    with dfo.Client(base_url="https://api.example.org", api_key=False) as client:
        return client.lookup


def _async_lookup() -> object:
    # The repr reads no state, so the lookup needs no transport.
    return object.__new__(AsyncLookup)


def _dataset() -> Dataset:
    return build_dataset(
        [recorded_member()], layout="long", complete=True, missing=(), stale=False
    )


def _member() -> object:
    return _dataset().members[0]


def _ref_member() -> object:
    return _dataset().ref.members[0]


_OPTION = Option("Congo [DRC]", ("Congo",), {})
_GERMANY = Entity("country/DEU", "Germany", "country")
_CONGO = Entity("country/COD", "Congo [DRC]", "country")


def _match(
    text: str,
    status: str,
    entity: Entity | None = None,
    candidates: tuple[Entity, ...] = (),
    near_matches: tuple[Entity, ...] = (),
) -> Match:
    return Match(text, status, entity, candidates, near_matches, {})


def _catalogue(examples: tuple[str, ...]) -> Catalogue:
    counts = {"publishers": 7, "variables": 13847, "aid": {}}
    return Catalogue("v1", counts, examples, {})


_EDUCATION = Notice("empty_result", "warn", "The frame holds zero observations.")

# Each row builds the object and names what its repr must hold: the whole repr
# when the row builds it from literals, else the identity it must name.
ROWS: list[tuple[str, Callable[[], object], str, bool]] = [
    ("spec", lambda: Spec(SPEC_ID, {}), f"Spec({SPEC_ID})", True),
    (
        "spec-sentence",
        lambda: Spec(SPEC_ID, {}, LONG),
        f"Spec({SPEC_ID}, \"Kenya's percent of total government expenditure on "
        'educatio…")',
        True,
    ),
    ("definite-part", _definite, "DefinitePart(", False),
    ("candidates-part", _candidates, "3 candidates", False),
    (
        "no-data-part",
        lambda: NoDataPart(
            status="no_data", variable_text="GDP", reason="awaiting", options=(_OPTION,)
        ),
        'NoDataPart("GDP", awaiting, 1 option)',
        True,
    ),
    (
        "unsupported-part",
        lambda: UnsupportedPart(
            status="unsupported",
            variable_text="GDP",
            reason="forecast",
            warnings=(_EDUCATION, _EDUCATION),
        ),
        'UnsupportedPart("GDP", forecast, 2 warnings)',
        True,
    ),
    (
        "unknown-part",
        lambda: UnknownPart(status="later"),
        'UnknownPart(status "later")',
        True,
    ),
    ("gap", _gap, "Gap(part 1 ", False),
    (
        "gap-options",
        lambda: Gap(
            0,
            NoDataPart(status="no_data", variable_text="Congo", reason="x"),
            "choice",
            "",
            (_OPTION, _OPTION, _OPTION, _OPTION),
        ),
        'Gap(part 0 "Congo", choice, 4 options: Congo [DRC] | Congo [DRC] | '
        "Congo [DRC] | +1 more)",
        True,
    ),
    (
        # The widest a gap prints: long labels, a long kind, more than three options.
        "gap-widest",
        lambda: Gap(
            999,
            NoDataPart(status="no_data", variable_text=LONG, reason="x"),
            "not_understood",
            "",
            (Option(LONG, (), {}),) * 120,
        ),
        "Gap(part 999 ",
        False,
    ),
    ("candidate", lambda: _candidates().candidates[0], 'Candidate("', False),
    ("option", lambda: _OPTION, 'Option("Congo [DRC]")', True),
    (
        "notice",
        lambda: _EDUCATION,
        "Notice(empty_result, warn: The frame holds zero observations.)",
        True,
    ),
    (
        "departure",
        lambda: Departure("closest_match", "Shows the closest year."),
        "Departure(closest_match: Shows the closest year.)",
        True,
    ),
    (
        "assumption",
        lambda: Assumption("declared_default", "how:dac2aAidType", "official aid"),
        'Assumption(declared_default how:dac2aAidType: "official aid")',
        True,
    ),
    (
        "requested-operation",
        lambda: RequestedOperation("rank", "top 5 donors", over="donor"),
        'RequestedOperation(rank "top 5 donors" over donor)',
        True,
    ),
    (
        "citation",
        lambda: Citation("OECD (2024).", (CitationSource("x", "OECD DAC1"),)),
        'Citation("OECD (2024).", 1 source)',
        True,
    ),
    (
        "citation-source",
        lambda: CitationSource("x", "OECD DAC1", licence="CC BY 4.0"),
        'CitationSource("OECD DAC1", CC BY 4.0)',
        True,
    ),
    ("member", _member, "Member(spec_", False),
    ("ref-member", _ref_member, "RefMember(spec_", False),
    (
        "raw-response",
        lambda: RawResponse(200, {"content-type": "application/json"}, b"{}"),
        "RawResponse(200, application/json, 2 bytes)",
        True,
    ),
    (
        "bundle-limits",
        lambda: BundleLimits(max_zip_entries=10),
        "BundleLimits(max_zip_entries=10)",
        True,
    ),
    (
        "lookup",
        _lookup,
        "<Lookup: resolve(*names), node(dcid), code(code), catalogue()>",
        True,
    ),
    (
        "async-lookup",
        _async_lookup,
        "<AsyncLookup: resolve(*names), node(dcid), code(code), catalogue()>",
        True,
    ),
    (
        "entity",
        lambda: Entity("country/KEN", "Kenya", "country"),
        "Entity(Kenya  country/KEN  (country))",
        True,
    ),
    (
        "match-resolved",
        lambda: _match(
            "Georgia",
            "resolved",
            Entity("country/GEO", "Georgia", "country"),
            near_matches=(Entity("geoId/13", "Georgia", "place_other"),),
        ),
        "Match(Georgia -> Georgia  country/GEO  (country)  +1 near match)",
        True,
    ),
    (
        "match-resolved-near-matches",
        lambda: _match(
            "Georgia",
            "resolved",
            Entity("country/GEO", "Georgia", "country"),
            near_matches=(_GERMANY, _CONGO),
        ),
        "Match(Georgia -> Georgia  country/GEO  (country)  +2 near matches)",
        True,
    ),
    (
        "match-ambiguous",
        lambda: _match("Congo", "ambiguous", candidates=(_CONGO,) * 4),
        "Match(Congo -> ambiguous: Congo [DRC]  country/COD | Congo [DRC]  "
        "country/COD | Congo [DRC]  country/COD | +1 more)",
        True,
    ),
    (
        "match-not-found",
        lambda: _match("Germny", "not_found", near_matches=(_GERMANY,)),
        "Match(Germny -> not found; nearest: Germany  country/DEU)",
        True,
    ),
    (
        "match-not-held",
        lambda: read_matches(
            {
                "results": [
                    {
                        "input": "Atlantis",
                        "status": "not_held",
                        "entity": {"ref": "dc/x", "label": "Atlantis", "kind": None},
                        "candidates": None,
                        "near_matches": None,
                    }
                ]
            }
        )[0],
        "Match(Atlantis -> not held: Atlantis  dc/x)",
        True,
    ),
    (
        "entity-unnamed",
        lambda: Entity("geoId/13", None, None),
        "Entity(geoId/13)",
        True,
    ),
    ("code-undefined", lambda: Code("x_y", None, {}), "Code(x_y)", True),
    (
        "match-widest",
        lambda: _match(
            LONG,
            "ambiguous",
            candidates=(Entity("x/" + "y" * 80, LONG, "place_other"),) * 120,
        ),
        "Match(Kenya's percent",
        False,
    ),
    (
        "node",
        lambda: Node("country/KEN", "Kenya", "country", ("Country",), {}),
        "Node(Kenya  country/KEN  (country)  types: Country)",
        True,
    ),
    (
        "code",
        lambda: Code("spec_not_found", "No definition is registered.", {}),
        "Code(spec_not_found: No definition is registered.)",
        True,
    ),
    (
        "catalogue",
        lambda: _catalogue(("ODA to Kenya since 2015",)),
        'Catalogue(7 publishers, 13,847 variables; 1 example question, such as "ODA '
        'to Kenya since 2015")',
        True,
    ),
    (
        "error",
        lambda: NotFoundError("No entry.", code="code_not_found", trace_id="4f2a"),
        "NotFoundError('No entry. [code_not_found · trace 4f2a]')",
        True,
    ),
    (
        "search-warning",
        lambda: SearchWarning("Shows 2022.", code="closest_match"),
        "SearchWarning('Shows 2022. [closest_match]')",
        True,
    ),
    ("latest-year", lambda: latest_year(-4), "latest_year(-4)", True),
    (
        "recipe",
        lambda: recipe(Spec(SPEC_ID, {})).rank(by="origin", limit=10),
        f"Recipe(rank by origin, limit 10, from {SPEC_ID})",
        True,
    ),
    (
        "left-out-series",
        lambda: LeftOutSeries(
            {"financingRecipient": "country/NGA"},
            LeftOutStep("growth", 0),
            "data",
            "endpoint_missing",
            1,
        ),
        "LeftOutSeries(financingRecipient=country/NGA: growth dropped 1 row from data, "
        "endpoint_missing)",
        True,
    ),
    (
        "async-analysis",
        lambda: object.__new__(AsyncAnalysis),
        "<AsyncAnalysis: filter, aggregate, growth, rank, quotient_of, share_of, "
        "join, sum_of, compare>",
        True,
    ),
    (
        "card",
        lambda: Card(
            "cmp_ad956b407b1623ec17cfcd55",
            1,
            "line",
            _dataset().ref,
            "German ODA, last ten years",
            "cmw_secret",
        ),
        'Card(line cmp_ad956b407b1623ec17cfcd55, "German ODA, last ten years", draws '
        f"{_dataset().members[0].spec.spec_id} at "
        f"{_dataset().members[0].content_version})",
        True,
    ),
    (
        "share",
        lambda: Share(
            "k3Qx8vTa",
            "https://developmentfinance.org/s/k3Qx8vTa",
            "https://developmentfinance.org/embed/k3Qx8vTa",
            (
                "https://developmentfinance.org/api/v1/presentation/shares/k3Qx8vTa/slots/1/data",
            ),
            2,
            True,
            "shw_secret",
        ),
        "Share(live https://developmentfinance.org/s/k3Qx8vTa, 1 slot, revision 2)",
        True,
    ),
    (
        "served",
        lambda: Served(
            1,
            "cmp_ad956b407b1623ec17cfcd55",
            1,
            "ops_" + "a" * 32,
            "ocv_" + "b" * 32,
            datetime(2026, 9, 24, 8, 0, tzinfo=UTC),
            False,
            date(2026, 11, 23),
            True,
        ),
        f"Served(slot 1 cmp_ad956b407b1623ec17cfcd55 from 24 Sep 2026: ops_{'a' * 32} "
        f"at ocv_{'b' * 32} · fetchable until 23 Nov 2026)",
        True,
    ),
    (
        "async-cards",
        lambda: object.__new__(AsyncCards),
        "<AsyncCards: line, bar, table, stat, source>",
        True,
    ),
    (
        "series-left-out-warning",
        lambda: SeriesLeftOutWarning("3 series left out."),
        "SeriesLeftOutWarning('3 series left out.')",
        True,
    ),
    (
        "data-warning",
        lambda: DataWarning("No rows.", code="empty_result", severity="warn"),
        "DataWarning('No rows. [empty_result]')",
        True,
    ),
]


@pytest.mark.parametrize(
    ("build", "expected", "whole"),
    [row[1:] for row in ROWS],
    ids=[row[0] for row in ROWS],
)
def test_a_value_object_prints_a_short_summary(
    build: Callable[[], object], expected: str, whole: bool
) -> None:
    text = repr(build())
    lines = text.splitlines()
    assert len(lines) <= 2
    assert all(len(line) <= 200 for line in lines)
    if whole:
        assert text == expected
    else:
        assert expected in text


# Server text that would clear a terminal (ESC [2J), open a C1 control sequence
# (CSI) and break the line.
HOSTILE = "a\u001b[2Jb\u009bc\nd"
_RENDERING = Rendering("parquet", bundle=False)


def _hostile_ref_member() -> RefMember:
    return RefMember(
        (), HOSTILE, Spec(SPEC_ID, {}), HOSTILE, "sha256:" + "0" * 64, _RENDERING
    )


def _hostile_member() -> Member:
    citation = Citation(HOSTILE, (CitationSource("x", HOSTILE),))
    return Member(
        (),
        Spec(SPEC_ID, {}),
        HOSTILE,
        HOSTILE,
        citation,
        "sha256:" + "0" * 64,
        _RENDERING,
    )


def _hostile_dataset() -> Dataset:
    member = recorded_member(sentence=HOSTILE, content_version=HOSTILE)
    return build_dataset(
        [member], layout="long", complete=True, missing=(), stale=False
    )


def _revived_answer() -> Answer:
    body = {**load("search-1.json"), "rendered_sentence": HOSTILE}
    text = json.dumps({"format_version": 1, "question": None, "answer": body})
    with dfo.Client(base_url="https://api.example.org", api_key=False) as client:
        answer = Answer.from_json(text, client=client)
    assert answer.sentence == HOSTILE
    return answer


_HOSTILE_PART = NoDataPart(status="no_data", variable_text=HOSTILE, reason=HOSTILE)

# Each row shows server text through one display path. The multi-line rows show
# several lines by design, so only the server's own line break must go.
HOSTILE_ROWS: list[tuple[str, Callable[[], str], bool]] = [
    ("spec", lambda: repr(Spec(SPEC_ID, {}, HOSTILE)), False),
    ("part", lambda: repr(_HOSTILE_PART), False),
    ("unknown-part", lambda: repr(UnknownPart(status=HOSTILE)), False),
    ("notice", lambda: repr(Notice(HOSTILE, HOSTILE, HOSTILE)), False),
    ("departure", lambda: repr(Departure(HOSTILE, HOSTILE)), False),
    (
        "requested-operation",
        lambda: repr(RequestedOperation(HOSTILE, HOSTILE, over=HOSTILE)),
        False,
    ),
    ("assumption", lambda: repr(Assumption(HOSTILE, HOSTILE, HOSTILE)), False),
    ("option", lambda: repr(Option(HOSTILE, (), {})), False),
    (
        "gap",
        lambda: repr(
            Gap(0, _HOSTILE_PART, "choice", HOSTILE, (Option(HOSTILE, (), {}),))
        ),
        False,
    ),
    ("gap-no-options", lambda: repr(Gap(0, _HOSTILE_PART, "choice", HOSTILE)), False),
    ("citation", lambda: repr(Citation(HOSTILE)), False),
    (
        "match",
        lambda: str(
            _match(
                HOSTILE,
                "not_found",
                near_matches=(Entity(HOSTILE, HOSTILE, HOSTILE),),
            )
        ),
        False,
    ),
    ("entity", lambda: repr(Entity(HOSTILE, HOSTILE, HOSTILE)), False),
    ("code", lambda: str(Code(HOSTILE, HOSTILE, {})), False),
    ("catalogue", lambda: str(_catalogue((HOSTILE,))), False),
    (
        "citation-source",
        lambda: repr(CitationSource("x", HOSTILE, licence=HOSTILE)),
        False,
    ),
    (
        "raw-response",
        lambda: repr(RawResponse(200, {"content-type": HOSTILE}, b"")),
        False,
    ),
    ("member", lambda: repr(_hostile_member()), False),
    ("ref-member", lambda: repr(_hostile_ref_member()), False),
    ("dataset-ref", lambda: repr(DatasetRef((_hostile_ref_member(),))), False),
    ("dataset", lambda: repr(_hostile_dataset()), True),
    ("dataset-html", lambda: _hostile_dataset()._repr_html_(), False),
    ("answer", lambda: repr(_revived_answer()), True),
    ("error-code", lambda: str(NotFoundError("No entry.", code=HOSTILE)), False),
    ("error-trace", lambda: str(NotFoundError("No entry.", trace_id=HOSTILE)), False),
    ("warning-code", lambda: str(DfoWarning("No rows.", code=HOSTILE)), False),
    (
        "left-out-series",
        lambda: repr(
            LeftOutSeries(
                {HOSTILE: HOSTILE}, LeftOutStep(HOSTILE, 0), HOSTILE, HOSTILE, 1
            )
        ),
        False,
    ),
    (
        "data-warning",
        lambda: str(DataWarning("No rows.", code=HOSTILE, severity="warn")),
        False,
    ),
    ("search-warning", lambda: str(SearchWarning("Shows 2022.", code=HOSTILE)), False),
]


@pytest.mark.parametrize(
    ("show", "lines"),
    [row[1:] for row in HOSTILE_ROWS],
    ids=[row[0] for row in HOSTILE_ROWS],
)
def test_server_text_reaches_a_display_without_control_characters(
    show: Callable[[], str], lines: bool
) -> None:
    text = show()
    allowed = {"\n"} if lines else set()
    controls = {
        char
        for char in text
        if unicodedata.category(char) == "Cc" and char not in allowed
    }
    assert controls == set()
    # The server's text shows, its line break a space.
    assert "a[2Jbc d" in text


def test_a_match_prints_the_line_its_repr_wraps() -> None:
    match = _match("Germny", "not_found", near_matches=(_GERMANY,))
    assert str(match) == "Germny -> not found; nearest: Germany  country/DEU"
    assert repr(match) == f"Match({match})"
