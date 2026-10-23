"""Tests for the `dfo` command and `login()`."""

import io
from pathlib import Path

import pytest

from dfo._client import cli as _cli
from dfo._config.credentials import read_profiles
from dfo._config.paths import cache_directory

KEY = "dfo_k_4f8Kq2ZtR7mWx1NcB9vLp3YhD6sGa0Ue2wanxe"


@pytest.fixture
def credentials(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "dfo" / "credentials.toml"
    for name in ("DFO_API_KEY", "DFO_PROFILE"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("DFO_CREDENTIALS_FILE", str(path))
    return path


def test_login_with_token_reads_stdin_and_stores_the_key(
    credentials: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr("sys.stdin", io.StringIO(f"{KEY}\n"))
    assert _cli.main(["auth", "login", "--with-token"]) == 0
    assert read_profiles(credentials) == {"default": {"key": KEY}}
    out = capsys.readouterr().out
    assert KEY not in out
    assert "dfo_k_***anxe" in out


def test_login_prompts_and_honours_the_profile(
    credentials: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DFO_PROFILE", "ci")
    monkeypatch.setattr(_cli.getpass, "getpass", lambda prompt: KEY)
    _cli.login()
    assert read_profiles(credentials) == {"ci": {"key": KEY}}


def test_login_says_when_a_key_fails_the_format_check(
    credentials: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr("sys.stdin", io.StringIO("sk-not-a-dfo-key"))
    assert _cli.main(["auth", "login", "--with-token"]) == 0
    assert "unknown_prefix" in capsys.readouterr().out
    assert read_profiles(credentials) == {"default": {"key": "sk-not-a-dfo-key"}}


def test_login_refuses_an_empty_key(
    credentials: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr("sys.stdin", io.StringIO("\n"))
    assert _cli.main(["auth", "login", "--with-token"]) == 1
    assert "No key given" in capsys.readouterr().err
    assert not credentials.exists()


def test_status_names_the_source_and_masks_the_key(
    credentials: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert _cli.main(["auth", "status"]) == 0
    assert "anonymous" in capsys.readouterr().out
    credentials.parent.mkdir(parents=True)
    credentials.write_text(f'[default]\nkey = "{KEY}"\n')
    assert _cli.main(["auth", "status"]) == 0
    out = capsys.readouterr().out
    assert str(credentials) in out
    assert "dfo_k_***anxe" in out
    assert KEY not in out
    monkeypatch.setenv("DFO_API_KEY", KEY)
    assert _cli.main(["auth", "status"]) == 0
    assert "DFO_API_KEY environment variable" in capsys.readouterr().out


def test_status_reports_a_broken_file(
    credentials: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    credentials.parent.mkdir(parents=True)
    credentials.write_text("key = 'x'\n")
    assert _cli.main(["auth", "status"]) == 1
    assert "line 1" in capsys.readouterr().err


def test_cache_clear_removes_only_the_client_cache(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DFO_CACHE_DIR", str(tmp_path))
    directory = Path(cache_directory())
    (directory / "files").mkdir(parents=True)
    (directory / "files" / "blob").write_bytes(b"x")
    (tmp_path / "other").write_text("kept")
    assert _cli.main(["cache", "clear"]) == 0
    assert not directory.exists()
    assert (tmp_path / "other").read_text() == "kept"
    assert _cli.main(["cache", "clear"]) == 0
