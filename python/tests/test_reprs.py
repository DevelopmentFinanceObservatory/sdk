"""Every public value object prints one or two short lines that name it."""

from collections.abc import Callable

import pytest

import dfo
from dfo._core.errors import DataWarning, NotFoundError, SearchWarning
from dfo._core.parse import parse_parts
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
    RequestedOperation,
    Spec,
    UnknownPart,
    UnsupportedPart,
)
from dfo._datasets.bundle import BundleLimits
from dfo._datasets.dataset import Dataset, build_dataset
from dfo._search.lookups import AsyncLookup
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
