"""Lookups on the default client: names to graph nodes, a node by its dcid, a
code's registry entry, and what Search holds data on.

`dfo.lookup.resolve("Nigeria")` and `client.lookup.resolve("Nigeria")` make the
same request; `dfo.configure` sets the client these functions use. The results
are the `Match`, `Node`, `Code` and `Catalogue` types in `dfo.types`.
"""

from dfo._client.default import catalogue, code, node, resolve
from dfo._generated.wire import ResolveKind

__all__ = [
    "ResolveKind",
    "catalogue",
    "code",
    "node",
    "resolve",
]
