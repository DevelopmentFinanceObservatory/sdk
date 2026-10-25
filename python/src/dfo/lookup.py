"""Lookups on the default client: names to graph nodes, a node by its dcid, a
code's registry entry, and what Search holds data on.

`dfo.lookup.resolve("Nigeria")` and `client.lookup.resolve("Nigeria")` make the
same request; `dfo.configure` sets the client these functions use.
"""

from dfo._client.default import catalogue, code, node, resolve
from dfo._core.types import Node
from dfo._generated.wire import (
    CatalogueResponse,
    CodeRegistryEntry,
    ResolveKind,
    ResolveResponse,
)

__all__ = [
    "CatalogueResponse",
    "CodeRegistryEntry",
    "Node",
    "ResolveKind",
    "ResolveResponse",
    "catalogue",
    "code",
    "node",
    "resolve",
]
