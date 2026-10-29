"""DFO's operations: each computed by DFO and returned as a derived Dataset.

`dfo.analysis.rank(data, by="origin", limit=10)` runs one operation on the
default client, as `client.analysis.rank(...)` does on a client you build. Each
takes a `Spec`, a `DatasetRef`, a `Dataset` or a `Recipe` holding one reading,
and returns a `Dataset` whose `left_out` lists every series an operation dropped
for missing data. `recipe(start)` describes a chain of the same operations
without running it, so `dfo.fetch(recipe)` runs the whole chain in one request:
`analysis.rank(data, ...)` returns what `dfo.fetch(analysis.recipe(data).rank(...))`
returns. A year may be `dfo.latest_year(offset)`, which DFO settles each run.
"""

from dfo._client.analysis import (
    aggregate,
    compare,
    filter,
    growth,
    join,
    quotient_of,
    rank,
    share_of,
    sum_of,
)
from dfo._datasets.recipe import recipe

__all__ = [
    "aggregate",
    "compare",
    "filter",
    "growth",
    "join",
    "quotient_of",
    "rank",
    "recipe",
    "share_of",
    "sum_of",
]
