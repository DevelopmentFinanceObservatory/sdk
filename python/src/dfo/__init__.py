"""Python client for the Development Finance Observatory APIs.

`dfo.search(question)` returns an `Answer` that says what DFO understood.
`answer.fetch()` or `dfo.fetch(spec_or_ref)` returns a `Dataset`, which
`data.save` writes to a Parquet file and `dfo.load` reads back. `Client` and
`AsyncClient` carry the same calls for one configuration each.

`dfo.pin(data)` keeps a Dataset's versions fetchable with no time limit, and
`dfo.latest_year(offset)` names a year DFO settles each time an operation runs.
`dfo.share(cards, latest=...)` publishes cards from `dfo.cards` as a link that
follows new data or stays fixed; `dfo.snapshot`, `dfo.unshare` and
`dfo.history` fix it, take it down and list what it served.

The task modules hold the rest: `dfo.analysis` DFO's operations and recipes,
`dfo.cards` the charts, tables and numbers DFO draws,
`dfo.errors` the errors and warnings, `dfo.types` what answers and datasets
contain, `dfo.lookup` names, nodes and codes, and `dfo.auth` keys and headers.
"""

from dfo import analysis, auth, cards, errors, lookup, types
from dfo._client.client import AsyncClient
from dfo._client.default import (
    configure,
    fetch,
    history,
    pin,
    search,
    share,
    snapshot,
    unshare,
)
from dfo._core.periods import latest_year
from dfo._core.refs import DatasetRef
from dfo._core.types import Spec
from dfo._datasets.bundle import load
from dfo._datasets.dataset import Dataset
from dfo._sync._client.client import Client
from dfo._sync._search.answer import Answer
from dfo._version import __version__

__all__ = [
    "Answer",
    "AsyncClient",
    "Client",
    "Dataset",
    "DatasetRef",
    "Spec",
    "__version__",
    "analysis",
    "auth",
    "cards",
    "configure",
    "errors",
    "fetch",
    "history",
    "latest_year",
    "load",
    "lookup",
    "pin",
    "search",
    "share",
    "snapshot",
    "types",
    "unshare",
]
