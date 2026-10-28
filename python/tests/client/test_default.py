"""Tests for the module functions and the default client behind them.

The default client is built on first use, replaced by `configure`, kept with a
fresh connection pool in a forked child and closed at exit; importing `dfo` reads
nothing.
"""

import gc
import inspect
import json
import os
import subprocess
import sys
import textwrap
import threading
import warnings
import weakref
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx2
import pytest

import dfo
from dfo._client import default as _default
from dfo._core.errors import InvalidRequestError
from dfo._datasets.cache import Cache
from dfo._sync._client.client import Client
from dfo._sync._datasets.analysis import Analysis
from dfo._sync._datasets.cards import Cards
from dfo._sync._datasets.fetch import Session
from dfo._sync._http.transport import Transport
from dfo._sync._search.lookups import Lookup
from tests._data import DATA, load
from tests._fetch_support import Replay

DEFAULT_URL = "https://default.example.org/api"
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
        (dfo.lookup.resolve, Lookup.resolve),
        (dfo.lookup.node, Lookup.node),
        (dfo.lookup.code, Lookup.code),
        (dfo.lookup.catalogue, Lookup.catalogue),
        (dfo.pin, Client.pin),
        (dfo.share, Client.share),
        (dfo.snapshot, Client.snapshot),
        (dfo.unshare, Client.unshare),
        (dfo.history, Client.history),
        *(
            (getattr(dfo.cards, kind), getattr(Cards, kind))
            for kind in ("line", "bar", "table", "stat", "source")
        ),
        *(
            (getattr(dfo.analysis, verb), getattr(Analysis, verb))
            for verb in (
                "filter",
                "aggregate",
                "growth",
                "rank",
                "quotient_of",
                "share_of",
                "join",
                "sum_of",
                "compare",
            )
        ),
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
    monkeypatch: pytest.MonkeyPatch,
    servers: dict[str, Callable[..., Any]],
    cache: Cache | None = None,
) -> list[Client]:
    """Make the default client serve each base URL from its handler, over `cache`."""
    built: list[Client] = []
    default = _default._DefaultClient

    def client(**options: Any) -> Client:
        base_url = options.get("base_url") or DEFAULT_URL
        transport = Transport(
            base_url=base_url,
            api_key=False,
            http_transport=httpx2.MockTransport(servers.get(base_url, unexpected)),
            caller=default._caller,
        )
        built.append(default._over(Session(transport, cache)))
        return built[-1]

    monkeypatch.setattr(_default, "_DefaultClient", client)
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

    assert len(data) == built.record["expect"][1]["dataset"]["rows"]
    assert (asked.exchanges, built.exchanges) == ([], [])
    assert [len(asked.requests), len(built.requests)] == [1, 3]
    # The replaced client stays open while referenced, and closes once collected.
    replaced = clients[0]._current().transport
    assert not replaced._pool._client.is_closed
    clients.clear()
    gc.collect()
    assert replaced._pool._client.is_closed


def test_an_in_flight_search_keeps_the_replaced_default_client_open(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first, second = "https://first.example.org/api", "https://second.example.org/api"
    replay = Replay("answer-definite-fetch", first)
    replay.exchanges = replay.exchanges[:1]
    started = threading.Event()
    resume = threading.Event()

    def paused(request: httpx2.Request) -> httpx2.Response:
        started.set()
        assert resume.wait(timeout=5)
        return replay(request)

    clients = mock_clients(monkeypatch, {first: paused})
    dfo.configure(base_url=first)
    result: list[object] = []
    failures: list[BaseException] = []

    def search() -> None:
        try:
            result.append(dfo.search(QUESTION))
        except BaseException as error:
            failures.append(error)

    worker = threading.Thread(target=search)
    worker.start()
    try:
        assert started.wait(timeout=5)
        transport = clients[0]._current().transport
        replaced = weakref.ref(clients[0])
        dfo.configure(base_url=second)
        clients.clear()
        gc.collect()
        assert replaced() is not None
        assert not transport._pool._client.is_closed
    finally:
        resume.set()
        worker.join(timeout=5)
    assert not worker.is_alive()
    assert failures == []
    assert len(result) == 1
    gc.collect()
    assert replaced() is None
    assert transport._pool._client.is_closed


def test_the_lookup_functions_ask_the_default_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bodies = {
        "/api/graph/resolve": {"results": []},
        "/api/graph/node/country/NGA": {
            "kind": "country",
            "ref": "country/NGA",
            "types": [],
        },
        "/codes/spec_not_found": {"code": "spec_not_found", "mappings": []},
        "/api/search/catalogue": {
            "catalogue_version": "v1",
            "counts": {},
            "examples": [],
        },
    }
    seen: list[str] = []

    def serve(request: httpx2.Request) -> httpx2.Response:
        seen.append(request.url.path)
        return httpx2.Response(200, json=bodies[request.url.path])

    mock_clients(monkeypatch, {DEFAULT_URL: serve})
    dfo.lookup.resolve("Nigeria")
    dfo.lookup.node("country/NGA")
    dfo.lookup.code("spec_not_found")
    dfo.lookup.catalogue()
    assert seen == list(bodies)


def test_the_analysis_functions_run_on_the_default_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ready = load("analysis-rank-ready.json")
    (member,) = ready["ref"]["members"]
    frame = (
        f"/api/datasets/derived/{member['spec']['spec_id']}/{member['content_version']}"
    )
    seen: list[str] = []

    def serve(request: httpx2.Request) -> httpx2.Response:
        seen.append(f"{request.method} {request.url.path}")
        if request.method == "POST":
            return httpx2.Response(200, json=ready)
        if request.url.path == frame:
            return httpx2.Response(200, json=load("analysis-rank-manifest.json"))
        return httpx2.Response(
            200, content=(DATA / "analysis-rank-frame.parquet").read_bytes()
        )

    mock_clients(monkeypatch, {DEFAULT_URL: serve})
    data = dfo.analysis.rank(dfo.Spec("spec_" + "a" * 32, {}), by="destination")
    assert seen == ["POST /api/datasets/analysis", f"GET {frame}", f"GET {frame}/file"]
    assert "newest later: dfo.fetch(data.ref, latest=True)" in repr(data)
    with pytest.raises(InvalidRequestError, match=r"dfo\.fetch\(data\.ref"):
        dfo.pin(data)


def test_a_card_and_its_share_go_through_the_default_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    replies = {
        "/api/presentation/components": load("card-line-created.json")["body"],
        "/api/presentation/shares": load("share-created.json")["body"],
    }
    seen: list[str] = []

    def serve(request: httpx2.Request) -> httpx2.Response:
        seen.append(f"{request.method} {request.url.path}")
        return httpx2.Response(201, json=replies[request.url.path])

    mock_clients(monkeypatch, {DEFAULT_URL: serve})
    ref = dfo.DatasetRef.from_json(json.dumps(load("analysis-rank-ready.json")["ref"]))
    card = dfo.cards.source(ref)
    tile = dfo.share(card, latest=True)
    assert seen == [
        "POST /api/presentation/components",
        "POST /api/presentation/shares",
    ]
    assert tile.write_token is not None
    with pytest.raises(InvalidRequestError, match=r"dfo\.cards\.line\(data\)"):
        dfo.share([], latest=True)


@pytest.mark.parametrize("configured", [False, True], ids=["built", "configured"])
def test_the_module_functions_hints_name_dfo(*, configured: bool) -> None:
    if configured:
        dfo.configure(base_url=DEFAULT_URL, api_key=False, cache=False)
    spec = dfo.Spec("spec_x", {})
    with pytest.raises(InvalidRequestError) as caught:
        dfo.fetch(spec, latest=True)
    assert "drop it: dfo.fetch(spec)." in str(caught.value)


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
    import httpx2._utils
    import dfo
    from dfo._client import default as _default

    dfo.configure(base_url="https://configured.example.org/api", api_key=False)
    parent = _default.default_client()
    transport = parent._current().transport
    inherited = transport._pool.client
    # Another thread holds the lock as the process forks.
    _default._lock.acquire()
    pid = os.fork()
    if pid == 0:
        # The platform's proxy lookup, which crashes here on macOS.
        looked_up = []
        httpx2._utils.getproxies = lambda: looked_up.append(True) or {}
        kept = _default.default_client() is parent and not _default._lock.locked()
        configured = parent.base_url == "https://configured.example.org/api"
        fresh = transport._pool.client
        proxied = fresh._mounts.keys() == inherited._mounts.keys() != set()
        transport.close()
        untouched = fresh is not inherited and fresh.is_closed
        ok = kept and configured and proxied and untouched and not looked_up
        os._exit(0 if ok and not inherited.is_closed else 1)
    _default._lock.release()
    _, status = os.waitpid(pid, 0)
    assert os.waitstatus_to_exitcode(status) == 0, "the child lost or reused the pool"
    assert _default._client is parent
    assert transport._pool.client is inherited and not inherited.is_closed
    """
)


@pytest.mark.skipif(not hasattr(os, "fork"), reason="needs os.fork")
def test_a_forked_child_keeps_the_configured_client_on_a_fresh_pool() -> None:
    # A fresh interpreter, since this one runs pyarrow's threads and fork warns.
    # A proxy in the environment keeps the parent off macOS's system proxy
    # lookup, which starts threads; the child must build its pool over the same
    # proxies without looking them up.
    result = subprocess.run(
        [sys.executable, "-W", "error", "-c", FORK],
        capture_output=True,
        text=True,
        check=False,
        env={
            **os.environ,
            "HTTPS_PROXY": "http://proxy.example.invalid:3128",
            "NO_PROXY": "",
        },
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
    # As on Windows, which has no fork.
    result = run("del os.register_at_fork; import dfo")
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
