"""Tests for the error tree, the error map and codes, and the warning helpers."""

import ast
import json
import pickle
import warnings
from pathlib import Path

import pytest

import dfo
from dfo._core import codes as _codes
from dfo._core import errors as _errors
from dfo._core.errors import (
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
from dfo._core.refusals import error_class, problem_error
from dfo._generated.error_map import (
    ACTIONS,
    CLIENT_CODES,
    GAP_KINDS,
    REFUSAL_WITHOUT_CODE,
    WARNING_CODES,
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
        "HTTP 503 with no refusal code. [refusal_without_code]",
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


def test_a_body_with_error_and_retry_members_carries_no_code() -> None:
    body = {"error": "rate_limited", "retry": "do_not_retry", "detail": "Stop."}
    error = problem_error(429, body, reason="", origin=ORIGIN)
    assert (type(error), error.code, error.retryable) == (
        RateLimitError,
        "refusal_without_code",
        True,
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


def test_warn_once_keeps_a_bounded_record(monkeypatch: pytest.MonkeyPatch) -> None:
    # The `warnings` registry counts too: under the default filter it records
    # every text shown, which it would keep in this module for good.
    monkeypatch.setattr(_errors, "_warned", set())
    monkeypatch.setattr(_errors, "_registry", {})
    monkeypatch.setattr(_errors, "_WARNED_MAX", 4)
    monkeypatch.delitem(globals(), "__warningregistry__", raising=False)
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("default")
        for index in range(10):
            text = "x" * 5000 + str(index)
            warn_once(("x-dfo-warning", text), DfoWarning(text))
    assert len(caught) == 10
    assert len(_errors._warned) <= 4
    assert len(_errors._registry) <= 4
    assert len(globals().get("__warningregistry__", {})) <= 1  # its version


_CLIENT_ROWS = json.loads((CONTRACT / "client-codes.json").read_text(encoding="utf-8"))[
    "codes"
]
_CLIENT_CODES = {
    name: value for name, value in vars(_codes).items() if isinstance(value, ClientCode)
}
_SOURCE = Path(dfo.__file__).parent
_ERROR_CLASSES = {
    name
    for name, value in vars(_errors).items()
    if isinstance(value, type) and issubclass(value, DfoError)
}


def test_the_map_and_codes_hold_exactly_the_contract_client_codes() -> None:
    by_status = [row["code"] for row in _CLIENT_ROWS if row["class"] == "by_status"]
    assert by_status == [REFUSAL_WITHOUT_CODE]
    assert {
        row["code"]: (row["class"], row["retryable"])
        for row in _CLIENT_ROWS
        if row["class"] != "by_status"
    } == CLIENT_CODES
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
    """The `dfo._core.codes` constant a `client_error` call names, or None."""
    first = call.args[0] if call.args else None
    if isinstance(first, ast.Name) and first.id in _CLIENT_CODES:
        return first.id
    return None


def test_the_package_builds_errors() -> None:
    assert len(_raises()) > 50


def test_every_client_raise_names_a_contract_code() -> None:
    """A raise takes its code and class from one row of `client-codes.json`.

    `client_error` takes a `dfo._core.codes` constant, never a string. A class built by
    name outside `dfo._core.errors` must carry a refusal's code (`code=<error>.code`),
    or a code the contract maps to that class in `actions.json`, so no raise can set
    a code the contract lacks, or none at all.
    """
    problems = []
    for where, callee, call in _raises():
        if callee == "client_error":
            if _constant(call) is None:
                problems.append(f"{where}: client_error takes no contract constant")
            continue
        if where.startswith("_core/errors.py:"):
            continue
        code = next((kw.value for kw in call.keywords if kw.arg == "code"), None)
        if isinstance(code, ast.Constant) and isinstance(code.value, str):
            mapped = error_class(code.value, None)
            if code.value in ACTIONS and mapped.__name__ == callee:
                continue
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
    [(_codes.DIGEST_MISMATCH, False), (_codes.DOWNLOAD_FAILED, True)],
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


@pytest.mark.parametrize("code", _CLIENT_CODES.values(), ids=lambda code: code.code)
def test_a_client_error_prints_its_code(code: ClientCode[DfoError]) -> None:
    error = _errors.client_error(code, "Bad input.")
    assert str(error) == f"Bad input. [{code.code}]"
    assert repr(error) == f"{code.error_class.__name__}('Bad input. [{code.code}]')"


# One code per action, so every error class a refusal maps to is covered.
_ACTION_CODES = {row["action"]: row["code"] for row in reversed(_ROWS)}


@pytest.mark.parametrize("action", sorted(_ACTION_CODES))
def test_a_refusal_prints_its_code_and_trace_id(action: str) -> None:
    code = _ACTION_CODES[action]
    body = {"code": code, "detail": "Refused.", "trace_id": "4f2a91c0"}
    error = problem_error(400, body, reason="Bad Request", origin=ORIGIN)
    assert type(error) is ACTION_CLASSES[action]
    assert str(error) == f"Refused. [{code} · trace 4f2a91c0]"


@pytest.mark.parametrize(
    ("message", "fields", "shown"),
    [
        ("Gone.", {}, "Gone."),
        ("Gone.", {"trace_id": "t1"}, "Gone. [trace t1]"),
        ("Gone.\n  Try again.", {"code": "x_gone"}, "Gone.\n  Try again.\n[x_gone]"),
    ],
    ids=["neither", "trace-only", "several-lines"],
)
def test_an_error_prints_what_it_has(
    message: str, fields: dict[str, str], shown: str
) -> None:
    error = DfoError(message, **fields)
    assert str(error) == shown
    assert str(_errors.recast(error, ServerError)) == shown


_WARNING_ROWS = json.loads(
    (CONTRACT / "warning-codes.json").read_text(encoding="utf-8")
)["codes"]
_WARNING_CODES = {
    name: value
    for name, value in vars(_codes).items()
    if isinstance(value, WarningCode)
}
# The classes of the warnings the client issues itself, and the row type: only
# `client_warning` builds the first, and only `dfo._core.codes` the second.
_OWN_WARNING_BUILDERS = frozenset(
    {"DfoWarning", "DfoDeprecationWarning", "WarningCode"}
)
_BUILDERS = frozenset({"_core/errors.py", "_core/codes.py"})


def test_the_map_and_codes_hold_exactly_the_contract_warning_codes() -> None:
    assert {row["code"]: row["class"] for row in _WARNING_ROWS} == WARNING_CODES
    assert {
        name: (code.code, code.warning_class.__name__)
        for name, code in _WARNING_CODES.items()
    } == {row["code"].upper(): (row["code"], row["class"]) for row in _WARNING_ROWS}


def test_every_client_warning_names_a_contract_code() -> None:
    """A warning of the client's own takes its code and class from one row.

    Only `client_warning` builds one, from a `WarningCode` in `dfo._core.codes`, so
    no warning can carry a code `warning-codes.json` lacks, and every row is used.
    """
    problems = []
    used = set()
    for path in sorted(_SOURCE.rglob("*.py")):
        name = path.relative_to(_SOURCE).as_posix()
        if name in _BUILDERS:
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
    warning = _errors.client_warning(_codes.ROUTE_DEPRECATED, "going")
    assert (type(warning), warning.code, str(warning)) == (
        DfoDeprecationWarning,
        "route_deprecated",
        "going [route_deprecated]",
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
    body = {"code": row["code"], "retryable": True, "detail": "Wait."}
    error = problem_error(status, body, reason="", origin=ORIGIN)
    assert (type(error), error.code, error.retryable) == (
        status_class(status),
        row["code"],
        True,
    )


_ERRORS_DOC = Path(__file__).parents[2] / "docs" / "errors.md"


def _doc_table(heading: str) -> list[list[str]]:
    """The cells of the first table under `heading` in docs/errors.md, header and
    rule left out, each cell stripped of its backticks."""
    text = _ERRORS_DOC.read_text(encoding="utf-8").split(f"\n{heading}\n", 1)[1]
    lines = text.splitlines()
    first = next(index for index, line in enumerate(lines) if line.startswith("|"))
    rows = []
    for line in lines[first + 2 :]:
        if not line.startswith("|"):
            break
        rows.append(
            [cell.strip().replace("`", "") for cell in line.strip("|").split("|")]
        )
    return rows


def test_the_errors_doc_lists_each_server_code_under_its_class() -> None:
    documented = {
        cls: set(codes.split(", ")) for cls, codes in _doc_table("### Server codes")
    }
    mapped: dict[str, set[str]] = {}
    for code in {*ACTIONS, *(row["code"] for row in _PROXY_ROWS)}:
        mapped.setdefault(error_class(code, None).__name__, set()).add(code)
    assert documented == mapped


def test_the_errors_doc_lists_each_client_and_warning_code() -> None:
    client = {
        code: (cls, retryable)
        for code, cls, retryable, _ in _doc_table("### Client codes")
    }
    assert client == {
        row["code"]: (
            "by status" if row["class"] == "by_status" else row["class"],
            {True: "yes", False: "no", "by_status": "by status"}[row["retryable"]],
        )
        for row in _CLIENT_ROWS
    }
    warnings_ = {code: cls for code, cls, _ in _doc_table("### Warnings")}
    assert warnings_ == {row["code"]: row["class"] for row in _WARNING_ROWS}
