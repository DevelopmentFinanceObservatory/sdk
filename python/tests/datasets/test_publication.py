"""Tests for what a card sends and how a share is named, without a server."""

from datetime import UTC, date, datetime, timedelta, timezone
from typing import Any

import pytest

from dfo._core.errors import InvalidRequestError
from dfo._core.periods import latest_year
from dfo._datasets.cards import stat_intent
from dfo._datasets.publication import as_of_moment, share_id_of
from tests._data import load

LATEST = {"anchor": "latest", "offset": 0}
BEFORE = {"anchor": "latest", "offset": -1}


@pytest.mark.parametrize(
    ("arguments", "intent"),
    [
        ({}, {}),
        ({"year": 2020}, {"window": {"start": "2020", "end": "2020"}}),
        (
            {"year": latest_year(), "compare_to": latest_year(-1)},
            {
                "window": {"start": BEFORE, "end": LATEST},
                "change": {"basis": [BEFORE, LATEST]},
            },
        ),
        (
            {
                "year": latest_year(),
                "compare_to": 2015,
                "change": "percent",
                "title": "Aid to Kenya",
            },
            {
                "title": "Aid to Kenya",
                "window": {"start": "2015", "end": LATEST},
                "change": {"basis": ["2015", LATEST], "derivation": "percent_change"},
            },
        ),
    ],
    ids=["newest", "year", "change", "percent-change"],
)
def test_a_stat_card_shows_its_year_and_counts_its_change_from_compare_to(
    arguments: dict[str, Any], intent: dict[str, Any]
) -> None:
    given = {"year": None, "compare_to": None, "change": "difference", "title": None}
    assert stat_intent(**{**given, **arguments}) == intent


@pytest.mark.parametrize(
    "arguments",
    [
        {"compare_to": latest_year(-1)},
        {"year": latest_year(), "change": "percent"},
        {"year": latest_year(), "compare_to": 2015, "change": "ratio"},
        {"year": "2020"},
        {"title": ""},
    ],
    ids=[
        "compare-without-year",
        "change-without-compare",
        "unknown-change",
        "text-year",
        "empty-title",
    ],
)
def test_a_malformed_stat_card_is_refused(arguments: dict[str, Any]) -> None:
    given = {"year": None, "compare_to": None, "change": "difference", "title": None}
    with pytest.raises(InvalidRequestError) as caught:
        stat_intent(**{**given, **arguments})
    assert caught.value.code == "invalid_argument"


@pytest.mark.parametrize(
    "url",
    [
        "https://developmentfinance.org/s/k3Qx8vTa",
        "https://developmentfinance.org/embed/k3Qx8vTa?theme=dark",
        "http://localhost:3000/s/k3Qx8vTa/",
    ],
)
def test_a_share_url_names_its_share(url: str) -> None:
    assert share_id_of(url, "dfo") == "k3Qx8vTa"


@pytest.mark.parametrize(
    "target",
    [
        "k3Qx8vTa",
        "https://developmentfinance.org/s/k3Qx8vT",
        "https://developmentfinance.org/data/k3Qx8vTa",
        "https://developmentfinance.org/s/k3Qx8vTa/../x",
        None,
    ],
)
def test_anything_but_a_share_or_its_url_is_refused(target: object) -> None:
    with pytest.raises(InvalidRequestError, match=r"dfo\.share\(cards"):
        share_id_of(target, "dfo")


def _utc_text(moment: datetime) -> str:
    """`moment` as the TypeScript client's `toISOString` writes it."""
    written = moment.astimezone(UTC).isoformat(timespec="milliseconds")
    return written.replace("+00:00", "Z")


# The text rows the TypeScript client's tests read too, so both read `as_of`
# text by one grammar.
AS_OF_CASES = load("as-of-cases.json")


@pytest.mark.parametrize("case", AS_OF_CASES, ids=[c["text"] for c in AS_OF_CASES])
def test_as_of_text_reads_by_the_grammar_both_clients_share(
    case: dict[str, Any],
) -> None:
    if case["moment"] is None:
        with pytest.raises(InvalidRequestError) as caught:
            as_of_moment(case["text"])
        assert caught.value.code == "invalid_argument"
        return
    moment, day = as_of_moment(case["text"])
    assert (_utc_text(moment), day.isoformat()) == (case["moment"], case["day"])


@pytest.mark.parametrize(
    ("as_of", "moment", "day"),
    [
        (date(2026, 10, 28), "2026-10-28T23:59:59.999Z", "2026-10-28"),
        (
            datetime(2026, 10, 28, 10, 0, 0, 123_456, tzinfo=UTC),
            "2026-10-28T10:00:00.123Z",
            "2026-10-28",
        ),
        (
            datetime(2026, 10, 28, 23, 30, tzinfo=timezone(timedelta(hours=-5))),
            "2026-10-29T04:30:00.000Z",
            "2026-10-28",
        ),
    ],
    ids=["date", "utc-datetime", "offset-datetime"],
)
def test_as_of_reads_a_date_as_its_day_and_a_datetime_as_its_moment(
    as_of: object, moment: str, day: str
) -> None:
    read, on = as_of_moment(as_of)
    assert (_utc_text(read), on.isoformat()) == (moment, day)


@pytest.mark.parametrize(
    "as_of", [datetime(2026, 10, 28, 10), 20261028, None], ids=["naive", "int", "none"]
)
def test_as_of_refuses_a_naive_datetime_and_other_objects(as_of: object) -> None:
    with pytest.raises(InvalidRequestError) as caught:
        as_of_moment(as_of)
    assert caught.value.code == "invalid_argument"
