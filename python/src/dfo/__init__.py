"""Python client for the Development Finance Observatory APIs.

`dfo.search(question)` returns an `Answer` that says what DFO understood.
`answer.fetch()` or `dfo.fetch(spec_or_ref)` returns a `Dataset`, which
`data.save` writes to a Parquet file and `dfo.load` reads back. `Client` and
`AsyncClient` carry the same calls for one configuration each.

The task modules hold the rest: `dfo.errors` the errors and warnings,
`dfo.types` what answers and datasets contain, `dfo.lookup` names, nodes and
codes, and `dfo.auth` keys and headers.
"""

from dfo import auth, errors, lookup, types
from dfo._client.client import AsyncClient
from dfo._client.default import configure, fetch, search
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
    "auth",
    "configure",
    "errors",
    "fetch",
    "load",
    "lookup",
    "search",
    "types",
]
