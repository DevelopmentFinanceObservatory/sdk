"""The nearest of a set of names to a word a caller gave, for a refusal's "did you mean".

Both sides are folded first, by default to lower case, so `congo [drc]` meets
`Congo [DRC]` at distance 0. The nearest is the name at the smallest edit distance,
a swap of two neighbouring characters counting as one edit, the first listed on a
tie, and only within a third of the word's folded length, at least 1, so a word
that resembles nothing suggests nothing.
"""

from collections.abc import Callable, Iterable


def nearest(
    word: str, names: Iterable[str], /, fold: Callable[[str], str] = str.lower
) -> str | None:
    """The nearest of `names` to `word`, or None when none lies within reach."""
    folded = fold(word)
    reach = max(1, len(folded) // 3)
    best = None
    best_distance = reach + 1
    for name in names:
        distance = _edit_distance(folded, fold(name))
        if distance < best_distance:
            best, best_distance = name, distance
    return best


def _edit_distance(a: str, b: str) -> int:
    """The fewest insertions, deletions, substitutions and swaps of two neighbours
    that turn `a` into `b`."""
    before: list[int] = []
    previous = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        current = [i]
        for j in range(1, len(b) + 1):
            distance = min(
                previous[j] + 1,
                current[j - 1] + 1,
                previous[j - 1] + (a[i - 1] != b[j - 1]),
            )
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                distance = min(distance, before[j - 2] + 1)
            current.append(distance)
        before, previous = previous, current
    return previous[len(b)]
