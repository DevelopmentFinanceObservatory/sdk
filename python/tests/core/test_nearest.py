"""Tests for the nearest name a refusal suggests."""

import pytest

from dfo._core.nearest import nearest

LABELS = ("Congo [DRC]", "Congo [Republic]")


@pytest.mark.parametrize(
    ("word", "names", "expected"),
    [
        ("congo [drc]", LABELS, "Congo [DRC]"),
        ("Cong", ("GDP", "Congo"), "Congo"),
        ("conut", ("count",), "count"),
        ("ab", ("ba", "ab"), "ab"),
        ("Kinshasa", LABELS, None),
        ("Congo", LABELS, None),
        ("cat", ("bat", "cab"), "bat"),
        ("x", (), None),
    ],
    ids=[
        "case-folded",
        "one-letter-short",
        "neighbours-swapped",
        "exact-beats-swap",
        "like-none",
        "beyond-a-third",
        "first-on-a-tie",
        "no-names",
    ],
)
def test_nearest_is_the_closest_name_within_a_third_of_the_word(
    word, names, expected
) -> None:
    assert nearest(word, names) == expected
