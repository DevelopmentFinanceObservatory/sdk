"""Lookups for names and codes in the graph, the code registry and Search's catalogue.

Each lookup returns the decoded response body, typed by the served OpenAPI
document's schema. The client reads none of it, so an unknown member or enum value
passes through untouched. A body with a `code` that lacks the member its schema
is told apart by is a problem document sent with a success status, and raises as
the class the contract's registry maps that code to, else `contract_violation`.
"""

import re
from collections.abc import Mapping, Sequence
from datetime import date
from typing import Any
from urllib.parse import quote

import httpx2

from dfo._core.codes import INVALID_ARGUMENT
from dfo._core.errors import client_error
from dfo._core.text import control_fault, has_dot_segment
from dfo._core.types import Node, ResolveKind, matches
from dfo._datasets.build import response_json
from dfo._generated.wire import (
    CatalogueResponse,
    CodeRegistryEntry,
    ResolveResponse,
)
from dfo._http.transport import AsyncTransport

# A registry code: lower-case snake case.
_CODE = re.compile(r"[a-z][a-z0-9_]*")


def _lookup_body(
    transport: AsyncTransport, response: httpx2.Response, member: str
) -> Any:
    """The decoded body of a lookup's response, whose schema requires `member`.

    Raises:
        DfoError: The body is a problem document: it holds a `code` and no
            `member`. It raises as the class the registry maps its code to.
        ContractError: The body is not JSON (`unexpected_response`), or the
            problem document's code is one the registry does not hold
            (`contract_violation`).
    """
    body = response_json(response)
    if isinstance(body, Mapping) and "code" in body and member not in body:
        raise transport.success_problem(response, body)
    return body


def _check_dcid(dcid: object) -> None:
    """Refuse a dcid that would leave the node route or carry a query.

    Raises:
        InvalidRequestError: `invalid_argument`.
    """
    if not isinstance(dcid, str) or not dcid:
        problem = "is not a non-empty string"
    elif fault := control_fault(dcid):
        problem = f"holds {fault}"
    elif "?" in dcid or "#" in dcid:
        problem = "holds a ? or a #"
    elif has_dot_segment(dcid):
        problem = "holds a . or .. segment"
    else:
        return
    raise client_error(
        INVALID_ARGUMENT, f"The dcid {problem}; pass one such as country/NGA"
    )


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
        return _lookup_body(self._transport, response, "results")

    async def node(self, dcid: str, /, *, as_of: date | None = None) -> Node:
        """One graph node by its dcid, such as `country/NGA`.

        Args:
            dcid: The node's dcid.
            as_of: Read the node as the graph held it on this date.

        Raises:
            InvalidRequestError: `dcid` is empty or holds a `.` or `..`
                segment, a `?`, a `#` or a control character
                (`invalid_argument`); no request is sent.
            NotFoundError: The graph holds no node with that dcid.
        """
        _check_dcid(dcid)
        params = None if as_of is None else {"as_of": as_of.isoformat()}
        response = await self._transport.request(
            "GET", f"/graph/node/{quote(dcid, safe='/')}", params=params
        )
        return _lookup_body(self._transport, response, "kind")


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
            InvalidRequestError: `code` is not lower-case snake case
                (`invalid_argument`); no request is sent.
            NotFoundError: The registry holds no such code.
        """
        if not matches(_CODE, code):
            raise client_error(
                INVALID_ARGUMENT,
                f"{code!r} is not a code, which is a lower-case letter followed "
                "by lower-case letters, digits or _",
            )
        url = self._transport.origin_url(f"/codes/{code}")
        response = await self._transport.request("GET", url)
        return _lookup_body(self._transport, response, "mappings")


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
    return _lookup_body(transport, response, "catalogue_version")
