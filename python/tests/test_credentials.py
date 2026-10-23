"""Replay the contract's credentials-file vectors, and test writing the file."""

import os
import stat
import sys
import tomllib
from pathlib import Path
from typing import Any

import pytest

from dfo._credentials import (
    CredentialsFileError,
    parse_credentials,
    read_profiles,
    render_credentials,
    store_key,
)
from tests.rule_vectors import ids, vectors

KEY = "dfo_k_4f8Kq2ZtR7mWx1NcB9vLp3YhD6sGa0Ue2wanxe"


@pytest.mark.parametrize(
    "vector", vectors("credentials-file"), ids=ids("credentials-file")
)
def test_credentials_file(vector: dict[str, Any]) -> None:
    if "error" in vector:
        with pytest.raises(CredentialsFileError) as caught:
            parse_credentials(vector["text"])
        assert (caught.value.reason, caught.value.line) == (
            vector["error"]["reason"],
            vector["error"]["line"],
        )
        return
    assert parse_credentials(vector["text"]) == vector["profiles"]


@pytest.mark.parametrize(
    "vector",
    [vector for vector in vectors("credentials-file") if "profiles" in vector],
    ids=[
        vector["name"] for vector in vectors("credentials-file") if "profiles" in vector
    ],
)
def test_rendered_profiles_read_back_and_are_toml(vector: dict[str, Any]) -> None:
    text = render_credentials(vector["profiles"])
    assert parse_credentials(text) == vector["profiles"]
    assert tomllib.loads(text) == vector["profiles"]


def test_a_file_that_is_not_utf8_is_broken_at_line_one(tmp_path: Path) -> None:
    path = tmp_path / "credentials.toml"
    path.write_bytes(b'[default]\nkey = "\xff"\n')
    with pytest.raises(CredentialsFileError) as caught:
        read_profiles(path)
    assert (caught.value.reason, caught.value.line) == ("invalid_line", 1)


def test_store_key_keeps_other_profiles_and_entries(tmp_path: Path) -> None:
    path = tmp_path / "dfo" / "credentials.toml"
    path.parent.mkdir()
    path.write_text('[ci]\nkey = "old"\n\n[default]\nkey = "old"\nlabel = "laptop"\n')
    store_key(path, "default", KEY)
    assert read_profiles(path) == {
        "ci": {"key": "old"},
        "default": {"key": KEY, "label": "laptop"},
    }


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX permission bits")
def test_store_key_writes_an_owner_only_file(tmp_path: Path) -> None:
    path = tmp_path / "config" / "dfo" / "credentials.toml"
    store_key(path, "default", KEY)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
    assert os.listdir(path.parent) == ["credentials.toml"]


@pytest.mark.parametrize(
    ("profile", "key"),
    [("default", 'dfo"k'), ("default", "dfo\\k"), ("default", "dfo\nk"), ("a.b", KEY)],
)
def test_store_key_refuses_what_the_format_cannot_hold(
    tmp_path: Path, profile: str, key: str
) -> None:
    path = tmp_path / "credentials.toml"
    with pytest.raises(ValueError, match="holds"):
        store_key(path, profile, key)
    assert not path.exists()


def test_store_key_refuses_to_overwrite_a_broken_file(tmp_path: Path) -> None:
    path = tmp_path / "credentials.toml"
    path.write_text("key = 'x'\n")
    with pytest.raises(CredentialsFileError):
        store_key(path, "default", KEY)
    assert path.read_text() == "key = 'x'\n"
