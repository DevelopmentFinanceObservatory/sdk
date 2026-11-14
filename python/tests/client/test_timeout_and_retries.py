"""Replay the contract's timeout-and-retries vectors through `dfo.Client`."""

from typing import Any

import pytest

import dfo
from dfo._core.errors import InvalidRequestError
from dfo._core.timeouts import CLIENT_TIMEOUT, FROM_ENVIRONMENT
from dfo._http.transport import resolve_max_retries, resolve_timeout
from dfo._search.answer import SEARCH_TIMEOUT
from tests.rule_vectors import ids, vectors

RULE = "timeout-and-retries"
BASE = "https://api.example.org/api/v1"
# Each call's own bound when neither it nor the client sets one.
CALL_DEFAULTS = {"search": SEARCH_TIMEOUT, "fetch": None}


@pytest.mark.parametrize("vector", vectors(RULE), ids=ids(RULE))
def test_timeout_and_retries(
    vector: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    for name, value in vector["env"].items():
        monkeypatch.setenv(name, value)
    variable = vector["variable"]
    option = {"DFO_TIMEOUT": "timeout", "DFO_MAX_RETRIES": "max_retries"}[variable]
    arguments = {option: vector["argument"]} if "argument" in vector else {}
    error = vector.get("error")

    if error is not None and error["source"] != "call":
        with pytest.raises(InvalidRequestError) as caught:
            dfo.Client(api_key=False, base_url=BASE, **arguments)
        assert caught.value.code == error["code"]
        assert (variable in str(caught.value)) == (error["source"] == "environment")
        return

    with dfo.Client(api_key=False, base_url=BASE, **arguments) as client:
        transport = client._current().transport
        if option == "max_retries":
            _, source = resolve_max_retries(
                vector.get("argument", FROM_ENVIRONMENT), env=vector["env"]
            )
            assert (transport.max_retries, source) == (
                vector["resolved"],
                vector["source"],
            )
            return

        def resolve() -> float | None:
            return transport.call_timeout(
                vector.get("call_argument", CLIENT_TIMEOUT),
                default=CALL_DEFAULTS[vector["call"]],
            )

        if error is not None:
            with pytest.raises(InvalidRequestError) as caught:
                resolve()
            assert caught.value.code == error["code"]
            assert variable not in str(caught.value)
            return
        assert resolve() == vector["resolved"]
        _, source = resolve_timeout(
            vector.get("argument", FROM_ENVIRONMENT), env=vector["env"]
        )
        expected = vector["source"]
        assert ("call" if "call_argument" in vector else source) == expected


@pytest.mark.parametrize(
    ("text", "resolved"), [("0" * 5000 + "3", 3), ("1" * 5000, None)]
)
def test_max_retries_of_any_length(text: str, resolved: int | None) -> None:
    """A `DFO_MAX_RETRIES` past int()'s 4,300-digit limit is refused by name."""
    env = {"DFO_MAX_RETRIES": text}
    if resolved is not None:
        assert resolve_max_retries(FROM_ENVIRONMENT, env=env) == (
            resolved,
            "environment",
        )
        return
    with pytest.raises(InvalidRequestError) as caught:
        resolve_max_retries(FROM_ENVIRONMENT, env=env)
    assert caught.value.code == "invalid_argument"
    assert "DFO_MAX_RETRIES" in str(caught.value)
