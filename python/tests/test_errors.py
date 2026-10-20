"""Tests for the error tree, the generated error map and the warning helpers."""

import json
import pickle
import warnings

import pytest

from dfo import _errors
from dfo._error_map import ACTIONS, GAP_KINDS
from dfo._errors import (
    AuthenticationError,
    ContractError,
    DfoError,
    DfoTimeoutError,
    DfoWarning,
    IncompleteAnswerError,
    InvalidRequestError,
    NetworkError,
    NotFoundError,
    PermissionDeniedError,
    QuotaExceededError,
    RateLimitError,
    ServerError,
    VersionUnavailableError,
    error_class,
    problem_error,
    warn,
    warn_once,
)
from tests.rule_vectors import CONTRACT

ORIGIN = "https://api.example.org"

# The contract README's table of actions and the class each maps to.
ACTION_CLASSES = {
    "fix_request": InvalidRequestError,
    "check_id": NotFoundError,
    "choose": IncompleteAnswerError,
    "ask_data_question": IncompleteAnswerError,
    "take_newest_version": VersionUnavailableError,
    "log_in": AuthenticationError,
    "request_scope": PermissionDeniedError,
    "wait": RateLimitError,
    "wait_for_reset": QuotaExceededError,
    "report": ServerError,
    "upgrade": ContractError,
}

_ROWS = json.loads((CONTRACT / "actions.json").read_text(encoding="utf-8"))["codes"]


def test_the_contract_lists_codes() -> None:
    assert _ROWS


@pytest.mark.parametrize("row", _ROWS, ids=[row["code"] for row in _ROWS])
def test_every_contract_code_has_its_class(row: dict[str, str]) -> None:
    # The status is one no row's class shares, so only the code can decide.
    assert error_class(row["code"], 418) is ACTION_CLASSES[row["action"]]
    assert GAP_KINDS.get(row["code"]) == row.get("gap_kind")


def test_the_map_holds_exactly_the_contract_codes() -> None:
    assert {row["code"]: row["action"] for row in _ROWS} == ACTIONS


def test_every_contract_action_maps_to_a_class() -> None:
    schema = json.loads((CONTRACT / "actions.schema.json").read_text(encoding="utf-8"))
    actions = schema["properties"]["codes"]["items"]["properties"]["action"]["enum"]
    assert sorted(actions) == sorted(ACTION_CLASSES)


@pytest.mark.parametrize(
    ("status", "cls"),
    [
        (400, InvalidRequestError),
        (401, AuthenticationError),
        (403, PermissionDeniedError),
        (404, NotFoundError),
        (408, DfoTimeoutError),
        (409, InvalidRequestError),
        (429, RateLimitError),
        (500, ServerError),
        (503, ServerError),
        (None, DfoError),
        (302, DfoError),
    ],
)
def test_an_unknown_code_maps_on_its_status(status: int | None, cls: type) -> None:
    assert error_class("no_such_code", status) is cls
    assert error_class(None, status) is cls


def test_the_standard_classes_are_also_builtin_errors() -> None:
    assert issubclass(NetworkError, ConnectionError)
    assert issubclass(DfoTimeoutError, TimeoutError)
    error = NetworkError("down", retryable=True)
    assert (str(error), error.retryable) == ("down", True)


def test_an_error_pickles_with_its_fields() -> None:
    error = problem_error(
        404, {"code": "spec_not_found", "detail": "Gone."}, reason="", origin=ORIGIN
    )
    copy = pickle.loads(pickle.dumps(error))
    assert (type(copy), copy.code, copy.status) == (
        NotFoundError,
        "spec_not_found",
        404,
    )


def test_a_body_without_json_uses_the_reason_phrase() -> None:
    error = problem_error(503, None, reason="Service Unavailable", origin=ORIGIN)
    assert (type(error), str(error), error.retryable) == (
        ServerError,
        "Service Unavailable",
        True,
    )
    assert (error.code, error.problem, error.docs_url) == (None, None, None)


def test_a_proxy_body_without_retry_is_not_retryable() -> None:
    body = {"error": "rate_limited", "retry": "do_not_retry", "detail": "Stop."}
    error = problem_error(429, body, reason="", origin=ORIGIN)
    assert (type(error), error.code, error.retryable) == (
        RateLimitError,
        "rate_limited",
        False,
    )


def test_warn_names_the_callers_line() -> None:
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        warn(DfoWarning("look"))
    assert caught[0].filename == __file__


def test_warn_once_shows_a_key_once(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_errors, "_warned", set())
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        warn_once("k", DfoWarning("first"))
        warn_once("k", DfoWarning("second"))
        warn_once("j", DfoWarning("third"))
    assert [str(warning.message) for warning in caught] == ["first", "third"]
