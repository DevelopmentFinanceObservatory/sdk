"""Tests for the module functions and the default client behind them.

The default client is built on first use, replaced by `configure`, reset in a
forked child and closed at exit; importing `dfo` reads nothing.
"""

import gc
import inspect
import json
import os
import subprocess
import sys
import textwrap
import warnings
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx2
import pytest

import dfo
from dfo import _default
from dfo._sync._client import Client
from dfo._sync._fetch import Session
from dfo._sync._transport import Transport

from ._fetch_support import Replay

QUESTION = "ODA disbursements from Germany to Nigeria for basic health care"


@pytest.fixture(autouse=True)
def fresh_default(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> None:
    """Each test starts with no default client and no key, cache or progress."""
    monkeypatch.setattr(_default, "_client", None)
    monkeypatch.setenv("DFO_CREDENTIALS_FILE", str(tmp_path / "none.toml"))
    monkeypatch.setenv("DFO_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setenv("DFO_PROGRESS", "0")
    for name in ("DFO_API_KEY", "DFO_PROFILE", "DFO_OFFLINE"):
        monkeypatch.delenv(name, raising=False)


def parameters(function: Callable[..., Any]) -> list[inspect.Parameter]:
    """A callable's parameters, without `self`."""
    found = list(inspect.signature(function).parameters.values())
    return [parameter for parameter in found if parameter.name != "self"]


@pytest.mark.parametrize(
    ("module_function", "method"),
    [
        (dfo.fetch, Client.fetch),
        (dfo.search, Client.search),
        (dfo.configure, Client.__init__),
    ],
)
def test_a_module_function_takes_its_client_methods_arguments(
    module_function: Callable[..., Any], method: Callable[..., Any]
) -> None:
    assert parameters(module_function) == parameters(method)
    returns = inspect.signature(method).return_annotation
    if method is not Client.__init__:
        assert inspect.signature(module_function).return_annotation == returns


def unexpected(request: httpx2.Request) -> httpx2.Response:
    raise AssertionError(f"unexpected {request.method} {request.url}")


def mock_clients(
    monkeypatch: pytest.MonkeyPatch, servers: dict[str, Callable[..., Any]]
) -> list[Client]:
    """Make the default client serve each base URL from its handler."""
    built: list[Client] = []

    def client(**options: Any) -> Client:
        base_url = options.get("base_url") or "https://default.example.org/api"
        transport = Transport(
            base_url=base_url,
            api_key=False,
            http_transport=httpx2.MockTransport(servers.get(base_url, unexpected)),
        )
        built.append(Client._over(Session(transport, None)))
        return built[-1]

    monkeypatch.setattr(_default, "Client", client)
    return built


def test_an_answer_stays_usable_after_configure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first, second = "https://first.example.org/api", "https://second.example.org/api"
    asked = Replay("answer-definite-fetch", first)
    asked.exchanges = asked.exchanges[:1]
    built = Replay("answer-definite-fetch", second)
    built.exchanges = built.exchanges[1:]
    clients = mock_clients(monkeypatch, {first: asked, second: built})

    dfo.configure(base_url=first)
    answer = dfo.search(QUESTION)
    dfo.configure(base_url=second)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        data = answer.fetch()

    assert data.rows == built.record["expect"][1]["dataset"]["rows"]
    assert (asked.exchanges, built.exchanges) == ([], [])
    assert [len(asked.requests), len(built.requests)] == [1, 3]
    # The replaced client stays open while referenced, and closes once collected.
    replaced = clients[0]._current().transport
    assert not replaced._http.is_closed
    clients.clear()
    gc.collect()
    assert replaced._http.is_closed


def test_the_default_client_is_built_once_on_first_use(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clients = mock_clients(monkeypatch, {})
    assert _default._client is None
    first = _default.default_client()
    assert _default.default_client() is first
    assert clients == [first]


FORK = textwrap.dedent(
    """
    import os
    from dfo import _default

    parent = _default.default_client()
    # Another thread holds the lock as the process forks.
    _default._lock.acquire()
    pid = os.fork()
    if pid == 0:
        inherited = _default._client is None and not _default._lock.locked()
        rebuilt = _default.default_client()
        unclosed = not parent._current().transport._http.is_closed
        os._exit(0 if inherited and rebuilt is not parent and unclosed else 1)
    _default._lock.release()
    _, status = os.waitpid(pid, 0)
    assert os.waitstatus_to_exitcode(status) == 0, "the child kept the parent's client"
    assert _default._client is parent
    """
)


@pytest.mark.skipif(not hasattr(os, "fork"), reason="needs os.fork")
def test_a_forked_child_drops_the_inherited_client_unclosed() -> None:
    # A fresh interpreter, since this one runs pyarrow's threads and fork warns.
    # NO_PROXY keeps httpx2 off macOS's system proxy lookup, which starts threads
    # and crashes a forked child.
    result = subprocess.run(
        [sys.executable, "-W", "error", "-c", FORK],
        capture_output=True,
        text=True,
        check=False,
        env={**os.environ, "NO_PROXY": "*"},
    )
    assert result.returncode == 0, result.stderr


NO_IO = textwrap.dedent(
    """
    import builtins, contextlib, importlib, io, json, os, socket, sys

    for name in json.loads(sys.argv[1]):
        # A few entries are synthetic modules an extension registers as it loads.
        with contextlib.suppress(ImportError):
            importlib.import_module(name)

    def refuse(what):
        def call(*args, **kwargs):
            raise AssertionError(f"importing dfo used {what}: {args[:1]!r}")
        return call

    class Environ(dict):
        def __getitem__(self, key):
            refuse("os.environ")(key)
        get = __contains__ = __getitem__

    builtins.open = io.open = refuse("open")
    os.getenv = refuse("os.getenv")
    os.environ = Environ()
    socket.socket.connect = refuse("socket.connect")
    socket.getaddrinfo = refuse("socket.getaddrinfo")
    exec(sys.argv[2])
    """
)

LOADED = (
    "import json, sys; import dfo; "
    "print(json.dumps(sorted(m for m in sys.modules if m.split('.')[0] != 'dfo')))"
)


def test_importing_dfo_reads_no_file_environment_or_network() -> None:
    # The modules dfo imports load first, so the traps catch only dfo's own code.
    loaded = subprocess.run(
        [sys.executable, "-c", LOADED], capture_output=True, check=True, text=True
    ).stdout
    others = [name for name in json.loads(loaded) if name != "__main__"]
    assert "httpx2" in others

    def run(statement: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-c", NO_IO, json.dumps(others), statement],
            capture_output=True,
            text=True,
            check=False,
        )

    control = run("os.environ.get('HOME')")
    assert "importing dfo used os.environ" in control.stderr
    result = run("import dfo")
    assert result.returncode == 0, result.stderr


def test_every_public_name_has_a_known_type() -> None:
    # Runs pyright's type-completeness check, about a second.
    pyright = Path(sys.executable).with_name("pyright")
    result = subprocess.run(
        [str(pyright), "--verifytypes", "dfo", "--ignoreexternal", "--outputjson"],
        capture_output=True,
        text=True,
        check=False,
    )
    report = json.loads(result.stdout)
    assert report["typeCompleteness"]["completenessScore"] == 1, [
        diagnostic["message"] for diagnostic in report["generalDiagnostics"]
    ]
    assert result.returncode == 0
