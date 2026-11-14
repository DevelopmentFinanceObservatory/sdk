"""Replay the contract's key-format and key-lookup vectors, and test `ApiKey`."""

import copy
import os
import pickle
import sys
import types
import warnings
from pathlib import Path
from typing import Any

import pytest

from dfo._config.credentials import ACCEPTED_FORMAT
from dfo._config.keys import ApiKey, KeyState, check_key_format, resolve_key
from dfo._core import errors as _errors
from dfo._core.errors import AuthenticationError, DfoWarning
from tests.rule_vectors import ids, vectors

KEY = "dfo_k_4f8Kq2ZtR7mWx1NcB9vLp3YhD6sGa0Ue2wanxe"


@pytest.fixture(autouse=True)
def fresh_warnings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_errors, "_warned", set())


@pytest.mark.parametrize("vector", vectors("key-format"), ids=ids("key-format"))
def test_key_format(vector: dict[str, Any]) -> None:
    assert check_key_format(vector["key"]) == vector.get("reason")


@pytest.mark.parametrize("vector", vectors("key-format"), ids=ids("key-format"))
def test_a_key_that_fails_the_check_warns_and_is_sent(vector: dict[str, Any]) -> None:
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        resolved = resolve_key(vector["key"], env={})
    assert resolved.key == ApiKey(vector["key"])
    shown = [warning for warning in caught if issubclass(warning.category, DfoWarning)]
    assert len(shown) == (vector["verdict"] == "warn")
    if shown:
        assert vector["key"] not in str(shown[0].message)
        assert shown[0].filename == __file__


def test_a_key_that_fails_the_check_warns_once_per_process() -> None:
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        for _ in range(3):
            resolve_key("sk-not-a-dfo-key", env={})
        resolve_key("sk-another-key", env={})
    assert len([w for w in caught if issubclass(w.category, DfoWarning)]) == 2


@pytest.mark.parametrize("entry", ['key = ""\n', 'name = "laptop"\n'])
def test_a_profile_with_an_empty_or_no_key_raises(entry: str, tmp_path: Path) -> None:
    path = tmp_path / "credentials.toml"
    path.write_text(f"[default]\n{entry}", encoding="utf-8")
    with pytest.raises(AuthenticationError) as caught:
        resolve_key(env={}, path=str(path))
    assert caught.value.code == "profile_without_key"


@pytest.mark.parametrize("api_key", ["", lambda: ""], ids=["string", "callable"])
def test_an_empty_key_argument_raises(api_key: Any) -> None:
    with pytest.raises(AuthenticationError) as caught:
        resolve_key(api_key, env={"DFO_API_KEY": KEY})
    assert caught.value.code == "key_empty"


@pytest.mark.parametrize(
    ("value", "fault"),
    [
        (KEY + "\n", "a line break at character 45"),
        (KEY[:10] + "\r\nX-Evil: 1" + KEY[10:], "a line break at character 11"),
        (" " + KEY, "whitespace at character 1"),
        ("   ", "whitespace at character 1"),
        (KEY + "\t", "whitespace at character 45"),
        (KEY + "\x00", "a control character at character 45"),
        (KEY + "\u00e9", "a non-ASCII character at character 45"),
    ],
    ids=[
        "newline",
        "crlf",
        "leading-space",
        "whitespace-only",
        "tab",
        "nul",
        "e-acute",
    ],
)
@pytest.mark.parametrize(
    ("source", "named"),
    [
        ("argument", "the api_key argument"),
        ("callable", "the api_key argument"),
        ("environment", "DFO_API_KEY"),
        ("credentials_file", "profile 'default' of "),
    ],
)
def test_a_key_outside_visible_ascii_is_refused_naming_where(
    value: str, fault: str, source: str, named: str, tmp_path: Path
) -> None:
    path = tmp_path / "credentials.toml"
    if source == "credentials_file":
        if any(char < " " for char in value):
            pytest.skip("the credentials file cannot hold a control character")
        path.write_text(f'[default]\nkey = "{value}"\n', encoding="utf-8")
    api_key: Any = {"argument": value, "callable": lambda: value}.get(source)
    env = {"DFO_API_KEY": value} if source == "environment" else {}
    with pytest.raises(AuthenticationError) as caught:
        resolve_key(api_key, env=env, path=str(path))
    message = str(caught.value)
    assert caught.value.code == "key_invalid"
    assert named in message
    assert fault in message
    assert KEY[6:20] not in message


@pytest.mark.parametrize(
    ("api_key", "named"),
    [
        (5, "api_key is a int"),
        (True, "api_key is a bool"),
        (lambda: None, "The api_key callable returned a NoneType"),
        (lambda: 5, "The api_key callable returned a int"),
    ],
    ids=["int", "true", "callable-none", "callable-int"],
)
def test_a_key_that_is_not_a_string_is_refused_naming_where(
    api_key: Any, named: str
) -> None:
    with pytest.raises(AuthenticationError) as caught:
        resolve_key(api_key, env={})
    assert caught.value.code == "key_invalid"
    assert named in str(caught.value)


def _look_up(vector: dict[str, Any], tmp_path: Path) -> Any:
    path = tmp_path / "credentials.toml"
    if vector["file"] is not None:
        path.write_text(vector["file"], encoding="utf-8")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DfoWarning)
        return resolve_key(vector.get("api_key"), env=vector["env"], path=str(path))


@pytest.mark.parametrize("vector", vectors("key-lookup"), ids=ids("key-lookup"))
def test_key_lookup(vector: dict[str, Any], tmp_path: Path) -> None:
    if "error" in vector:
        with pytest.raises(AuthenticationError) as caught:
            _look_up(vector, tmp_path)
        assert caught.value.code == vector["error"]["reason"]
        return
    resolved = _look_up(vector, tmp_path)
    key = None if resolved.key is None else resolved.key.reveal()
    assert (resolved.source, key) == (vector["source"], vector["key"])


@pytest.mark.skipif(os.name != "posix", reason="POSIX file modes")
@pytest.mark.parametrize("fault", ["directory", "no-permission"])
def test_a_credentials_file_that_cannot_be_read_raises(
    fault: str, tmp_path: Path
) -> None:
    path = tmp_path / "credentials.toml"
    if fault == "directory":
        path.mkdir()
    else:
        path.write_text(f'[default]\nkey = "{KEY}"\n')
        path.chmod(0)
        if os.access(path, os.R_OK):
            pytest.skip("this user reads a file with no permissions")
    with pytest.raises(AuthenticationError) as caught:
        resolve_key(env={}, path=str(path))
    assert caught.value.code == "credentials_file_unreadable"
    assert str(path) in str(caught.value)


@pytest.mark.parametrize(
    ("content", "line", "reason"),
    [
        ('[default]\nkey = "k" # comment\n', 2, "invalid_line"),
        ("[default]\nkey = 'k'\n", 2, "invalid_line"),
        ('[default]\nkey = "k"\n[default.sub]\n', 3, "invalid_line"),
        ('\ufeff[default]\nkey = "k"\n', 1, "invalid_line"),
    ],
    ids=["trailing-comment", "single-quoted", "nested-table", "bom"],
)
def test_a_credentials_file_outside_the_subset_names_the_subset(
    content: str, line: int, reason: str, tmp_path: Path
) -> None:
    path = tmp_path / "credentials.toml"
    path.write_text(content, encoding="utf-8")
    with pytest.raises(AuthenticationError) as caught:
        resolve_key(env={}, path=str(path))
    assert caught.value.code == "credentials_file_invalid"
    assert f"at line {line} ({reason})" in str(caught.value)
    assert ACCEPTED_FORMAT in str(caught.value)


def test_the_lookup_reads_the_contract_path_by_default(tmp_path: Path) -> None:
    path = tmp_path / "keys.toml"
    path.write_text(f'[default]\nkey = "{KEY}"\n')
    resolved = resolve_key(env={"DFO_CREDENTIALS_FILE": str(path)})
    assert (resolved.source, resolved.path, resolved.profile) == (
        "credentials_file",
        str(path),
        "default",
    )


def test_a_callable_or_api_key_argument_is_unwrapped() -> None:
    assert resolve_key(lambda: KEY, env={}).key == ApiKey(KEY)
    assert resolve_key(lambda: ApiKey(KEY), env={}).key == ApiKey(KEY)
    assert resolve_key(ApiKey(KEY), env={}).source == "argument"


@pytest.fixture
def colab(monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    secrets: dict[str, str] = {}

    class SecretNotFoundError(Exception):
        pass

    class NotebookAccessError(Exception):
        pass

    def get(name: str) -> str:
        if name not in secrets:
            raise SecretNotFoundError(name)
        return secrets[name]

    userdata = types.ModuleType("google.colab.userdata")
    userdata.get = get
    userdata.SecretNotFoundError = SecretNotFoundError
    userdata.NotebookAccessError = NotebookAccessError
    monkeypatch.setitem(sys.modules, "google", types.ModuleType("google"))
    monkeypatch.setitem(sys.modules, "google.colab", types.ModuleType("google.colab"))
    monkeypatch.setitem(sys.modules, "google.colab.userdata", userdata)
    return secrets


def test_a_colab_secret_comes_after_the_file(
    colab: dict[str, str], tmp_path: Path
) -> None:
    missing = str(tmp_path / "none.toml")
    assert resolve_key(env={}, path=missing).source == "anonymous"
    colab["DFO_API_KEY"] = KEY
    resolved = resolve_key(env={}, path=missing)
    assert (resolved.source, resolved.key) == ("colab", ApiKey(KEY))
    file = tmp_path / "credentials.toml"
    file.write_text('[default]\nkey = "from-file"\n')
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DfoWarning)
        assert resolve_key(env={}, path=str(file)).source == "credentials_file"


def test_a_colab_lookup_that_fails_leaves_no_secret(
    colab: dict[str, str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    def broken(name: str) -> str:
        raise RuntimeError(f"colab broke {KEY}")

    monkeypatch.setattr(sys.modules["google.colab.userdata"], "get", broken)
    resolved = resolve_key(env={}, path=str(tmp_path / "none.toml"))
    assert resolved.source == "anonymous"


def test_api_key_hides_its_value() -> None:
    key = ApiKey(KEY)
    assert key.reveal() == KEY
    assert not isinstance(key, str)
    assert KEY not in repr(key)
    assert KEY not in str(key)
    assert KEY not in f"{key}"
    assert repr(key) == "ApiKey('dfo_k_***anxe')"
    assert copy.deepcopy(key) is key
    with pytest.raises(TypeError, match="pickled"):
        pickle.dumps(key)


@pytest.mark.parametrize(("value", "code"), [("", "key_empty"), (b"k", "key_invalid")])
def test_api_key_refuses_an_empty_or_non_string_value(value: object, code: str) -> None:
    with pytest.raises(AuthenticationError) as caught:
        ApiKey(value)
    assert caught.value.code == code


def test_key_state_reports_a_change_after_refresh() -> None:
    keys = [KEY, KEY, "dfo_k_other"]
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DfoWarning)
        state = KeyState(lambda: keys.pop(0))
        assert state.refresh() is False
        assert state.refresh() is True
    assert state.resolved.key == ApiKey("dfo_k_other")
