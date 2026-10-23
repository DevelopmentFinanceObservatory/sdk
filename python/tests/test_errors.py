"""Tests for the error tree, the generated error map and the warning helpers."""

import ast
import json
import pickle
import warnings
from pathlib import Path

import pytest

import dfo
from dfo import _error_map, _errors
from dfo._error_map import ACTIONS, GAP_KINDS, REFUSAL_WITHOUT_CODE
from dfo._errors import (
    AuthenticationError,
    ClientCode,
    ContractError,
    DfoDeprecationWarning,
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
    WarningCode,
    status_class,
    warn,
    warn_once,
)
from dfo._refusals import error_class, problem_error
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
        (410, NotFoundError),
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
    assert (error.code, error.problem, error.docs_url) == (
        "refusal_without_code",
        None,
        None,
    )


@pytest.mark.parametrize(
    ("status", "cls"),
    [(401, AuthenticationError), (410, NotFoundError), (418, InvalidRequestError)],
)
def test_a_problem_document_without_a_code_takes_the_status_class(
    status: int, cls: type
) -> None:
    error = problem_error(status, {"title": "Refused"}, reason="", origin=ORIGIN)
    assert (type(error), error.code) == (cls, "refusal_without_code")


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


_CLIENT_ROWS = json.loads((CONTRACT / "client-codes.json").read_text(encoding="utf-8"))[
    "codes"
]
_CLIENT_CODES = {
    name: value
    for name, value in vars(_error_map).items()
    if isinstance(value, ClientCode)
}
_SOURCE = Path(dfo.__file__).parent
_ERROR_CLASSES = {
    name
    for name, value in vars(_errors).items()
    if isinstance(value, type) and issubclass(value, DfoError)
}


def test_the_map_holds_exactly_the_contract_client_codes() -> None:
    by_status = [row["code"] for row in _CLIENT_ROWS if row["class"] == "by_status"]
    assert by_status == [REFUSAL_WITHOUT_CODE]
    assert {
        name: (code.code, code.error_class.__name__, code.retryable)
        for name, code in _CLIENT_CODES.items()
    } == {
        row["code"].upper(): (row["code"], row["class"], row["retryable"])
        for row in _CLIENT_ROWS
        if row["class"] != "by_status"
    }


def _raises() -> list[tuple[str, str, ast.Call]]:
    """Every call in the package that builds an error: where, the callee, the call."""
    calls = []
    for path in sorted(_SOURCE.rglob("*.py")):
        name = path.relative_to(_SOURCE).as_posix()
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)):
                continue
            if node.func.id == "client_error" or node.func.id in _ERROR_CLASSES:
                calls.append((f"{name}:{node.lineno}", node.func.id, node))
    return calls


def _constant(call: ast.Call) -> str | None:
    """The generated constant a `client_error` call names, or None."""
    first = call.args[0] if call.args else None
    if isinstance(first, ast.Name) and first.id in _CLIENT_CODES:
        return first.id
    return None


def test_the_package_builds_errors() -> None:
    assert len(_raises()) > 50


def test_every_client_raise_names_a_contract_code() -> None:
    """A raise takes its code and class from one row of `client-codes.json`.

    `client_error` takes a generated constant, never a string. A class built by
    name outside `dfo._errors` must carry a refusal's code (`code=<error>.code`),
    so no raise can set a code the contract lacks, or none at all.
    """
    problems = []
    for where, callee, call in _raises():
        if callee == "client_error":
            if _constant(call) is None:
                problems.append(f"{where}: client_error takes no contract constant")
            continue
        if where.startswith("_errors.py:"):
            continue
        code = next((kw.value for kw in call.keywords if kw.arg == "code"), None)
        if not (isinstance(code, ast.Attribute) and code.attr == "code"):
            problems.append(f"{where}: {callee} built without client_error")
    assert problems == []


def test_every_contract_client_code_is_raised() -> None:
    used = {
        _constant(call) for _, callee, call in _raises() if callee == "client_error"
    }
    assert sorted(set(_CLIENT_CODES) - used) == []


@pytest.mark.parametrize(
    ("code", "retryable"),
    [(_error_map.DIGEST_MISMATCH, False), (_error_map.DOWNLOAD_FAILED, True)],
)
def test_a_client_error_takes_its_rows_class_and_flag(
    code: ClientCode[ServerError], retryable: bool
) -> None:
    error = _errors.client_error(code, "bad bytes", status=200)
    assert (type(error), error.code, error.status, error.retryable) == (
        ServerError,
        code.code,
        200,
        retryable,
    )


_WARNING_ROWS = json.loads(
    (CONTRACT / "warning-codes.json").read_text(encoding="utf-8")
)["codes"]
_WARNING_CODES = {
    name: value
    for name, value in vars(_error_map).items()
    if isinstance(value, WarningCode)
}
# The classes of the warnings the client issues itself, and the row type: only
# `client_warning` builds the first, and only the generated map the second.
_OWN_WARNING_BUILDERS = frozenset(
    {"DfoWarning", "DfoDeprecationWarning", "WarningCode"}
)
_GENERATED = frozenset({"_errors.py", "_error_map.py"})


def test_the_map_holds_exactly_the_contract_warning_codes() -> None:
    assert {
        name: (code.code, code.warning_class.__name__)
        for name, code in _WARNING_CODES.items()
    } == {row["code"].upper(): (row["code"], row["class"]) for row in _WARNING_ROWS}


def test_every_client_warning_names_a_contract_code() -> None:
    """A warning of the client's own takes its code and class from one row.

    Only `client_warning` builds one, from a `WarningCode` the map generates, so
    no warning can carry a code `warning-codes.json` lacks, and every row is used.
    """
    problems = []
    used = set()
    for path in sorted(_SOURCE.rglob("*.py")):
        name = path.relative_to(_SOURCE).as_posix()
        if name in _GENERATED:
            continue
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Name) and node.id in _WARNING_CODES:
                used.add(node.id)
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id in _OWN_WARNING_BUILDERS
            ):
                problems.append(f"{name}:{node.lineno}: builds {node.func.id}")
    assert problems == []
    assert sorted(set(_WARNING_CODES) - used) == []


def test_a_client_warning_takes_its_rows_class() -> None:
    warning = _errors.client_warning(_error_map.ROUTE_DEPRECATED, "going")
    assert (type(warning), warning.code, str(warning)) == (
        DfoDeprecationWarning,
        "route_deprecated",
        "going",
    )


_PROXY_ROWS = json.loads((CONTRACT / "proxy-codes.json").read_text(encoding="utf-8"))[
    "codes"
]


@pytest.mark.parametrize("row", _PROXY_ROWS, ids=[row["code"] for row in _PROXY_ROWS])
def test_a_proxy_refusal_keeps_its_code_and_takes_its_status_class(
    row: dict[str, object],
) -> None:
    status = row["status"]
    assert isinstance(status, int)
    assert row["code"] not in ACTIONS
    body = {"error": row["code"], "retry": "retry_after_delay", "detail": "Wait."}
    error = problem_error(status, body, reason="", origin=ORIGIN)
    assert (type(error), error.code, error.retryable) == (
        status_class(status),
        row["code"],
        True,
    )
