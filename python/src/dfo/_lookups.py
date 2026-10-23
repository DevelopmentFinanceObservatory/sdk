"""Lookups for names and codes in the graph, the code registry and Search's catalogue.

Each lookup returns the decoded response body, typed by the served OpenAPI
document's schema. The client reads none of it, so an unknown member or enum value
passes through untouched.
"""

from collections.abc import Sequence
from datetime import date
from typing import Any, Literal
from urllib.parse import quote

from dfo._build import response_json
from dfo._transport import AsyncTransport
from dfo._wire import (
    AggregateNode,
    CatalogueResponse,
    CodeNode,
    CodeRegistryEntry,
    CodeSystemNode,
    ContinentalUnionNode,
    ContinentNode,
    CountryNode,
    DatasetNode,
    GroupNode,
    OrganisationNode,
    OtherNode,
    PlaceOtherNode,
    ProvenanceNode,
    ResolveResponse,
    SourceNode,
    StatVarNode,
    SubregionNode,
    UnitNode,
)

type ResolveKind = Literal[
    "country",
    "continent",
    "subregion",
    "continental_union",
    "organisation",
    "aggregate",
    "place_other",
    "group",
    "code",
    "other",
]
"""A kind of graph node a name can resolve to."""

type Node = (
    StatVarNode
    | CodeSystemNode
    | CodeNode
    | GroupNode
    | CountryNode
    | ContinentNode
    | SubregionNode
    | ContinentalUnionNode
    | PlaceOtherNode
    | OrganisationNode
    | AggregateNode
    | UnitNode
    | SourceNode
    | DatasetNode
    | ProvenanceNode
    | OtherNode
)
"""One graph node, told apart by its `kind`."""


class AsyncGraph:
    """The graph's lookups: names to dcids, and a node by its dcid."""

    def __init__(self, transport: AsyncTransport) -> None:
        """Look up through `transport`."""
        self._transport = transport

    async def resolve(
        self,
        *texts: str,
        kinds: Sequence[ResolveKind] | None = None,
        code_system: str | None = None,
        expand_members: bool = False,
    ) -> ResolveResponse:
        """Resolve names, such as "Nigeria" or "Sahel", to graph nodes.

        Args:
            texts: One to 25 names, resolved as one batch. `results` follows
                their order.
            kinds: The node kinds a name may resolve to; None takes the server's
                default of every kind of place and group.
            code_system: Narrow `code` matches to one code system's graph id,
                such as `CRSPurposeCodeEnum`. Needs `code` in `kinds`.
            expand_members: Inline each group's or region's members.

        Raises:
            InvalidRequestError: The server refused the names or kinds.
        """
        body: dict[str, Any] = {"texts": list(texts)}
        if kinds is not None:
            body["kinds"] = list(kinds)
        if code_system is not None:
            body["code_system"] = code_system
        if expand_members:
            body["expand"] = ["members"]
        response = await self._transport.request("POST", "/graph/resolve", json=body)
        return response_json(response)

    async def node(self, dcid: str, /, *, as_of: date | None = None) -> Node:
        """One graph node by its dcid, such as `country/NGA`.

        Args:
            dcid: The node's dcid.
            as_of: Read the node as the graph held it on this date.

        Raises:
            NotFoundError: The graph holds no node with that dcid.
        """
        params = None if as_of is None else {"as_of": as_of.isoformat()}
        response = await self._transport.request(
            "GET", f"/graph/node/{quote(dcid, safe='/')}", params=params
        )
        return response_json(response)


class AsyncCodes:
    """The code registry: what each refusal and warning code means."""

    def __init__(self, transport: AsyncTransport) -> None:
        """Look up through `transport`."""
        self._transport = transport

    async def get(self, code: str, /) -> CodeRegistryEntry:
        """The registry entry for one code, such as `spec_not_found`.

        The registry sits at the API host's root, the page an error's `docs_url`
        names.

        Raises:
            NotFoundError: The registry holds no such code.
        """
        url = self._transport.origin_url(f"/codes/{quote(code, safe='')}")
        return response_json(await self._transport.request("GET", url))


async def catalogue(
    transport: AsyncTransport, *, place: str | None = None
) -> CatalogueResponse:
    """The catalogue of what Search holds data on, with counts and example questions.

    Args:
        transport: The transport the request goes through.
        place: A country dcid, such as `country/NGA`, to scope the counts and
            examples to that country.
    """
    params = None if place is None else {"place": place}
    response = await transport.request("GET", "/search/catalogue", params=params)
    return response_json(response)
