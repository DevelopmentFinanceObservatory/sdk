"""The `client-identity` vectors: the `X-DFO-Client` value, and the caller's
headers that name it."""

import json
import re
from typing import Any

import httpx2
import pytest

from dfo._core.errors import InvalidRequestError
from dfo._http.transport import CLIENT_IDENTITY, client_identity
from dfo._sync._http.transport import Transport
from tests._data import CONTRACT
from tests.rule_vectors import vectors

IDENTITIES = [v for v in vectors("client-identity") if v.get("client") == "dfo-python"]
HEADERS = [v for v in vectors("client-identity") if "via" in v]


@pytest.mark.parametrize("vector", IDENTITIES, ids=[v["name"] for v in IDENTITIES])
def test_the_identity_vectors(vector: dict[str, Any]) -> None:
    runtime = vector["runtime"]
    value = client_identity(vector["version"], runtime["name"], runtime["version"])
    assert value == vector["value"]


def test_the_running_identity_matches_the_rule_pattern() -> None:
    rule = json.loads((CONTRACT / "rules" / "client-identity.json").read_text())
    assert re.fullmatch(rule["pattern"], CLIENT_IDENTITY)


@pytest.mark.parametrize("vector", HEADERS, ids=[v["name"] for v in HEADERS])
def test_the_header_vectors(vector: dict[str, Any]) -> None:
    sent: list[httpx2.Request] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        sent.append(request)
        return httpx2.Response(200, json={})

    headers = vector["headers"]
    options: dict[str, Any] = (
        {"headers": headers}
        if vector["via"] == "argument"
        else {"header_provider": lambda: headers}
    )

    def call() -> None:
        with Transport(
            base_url="https://api.example.org/api/v1",
            api_key=False,
            http_transport=httpx2.MockTransport(handler),
            **options,
        ) as transport:
            transport.request("GET", "/datasets/schema")

    if vector["verdict"] == "refuse":
        with pytest.raises(InvalidRequestError) as caught:
            call()
        assert caught.value.code == vector["reason"]
        assert sent == []
        return
    call()
    (request,) = sent
    assert request.headers["x-dfo-client"] == CLIENT_IDENTITY
    for name, value in headers.items():
        assert request.headers[name] == value
