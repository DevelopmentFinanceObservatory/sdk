"""Replay every scenario in `contract/scenarios/` over `Client` and `AsyncClient`.

Each scenario runs once per client flavour and once per base-URL form in
`BASE_URLS`, through `_over(Session(transport, None))` with a mock HTTP transport
that serves the scenario's exchanges in order, and an injected clock whose sleep
advances it at once. A request matches the next exchange on its method and full
URL: `path` under the base URL, `origin_path` against the base URL's origin, and
`url` as it stands. API requests carry the key and the client's headers; a signed
storage URL gets a bare request. A response that names the recorded API origin,
in its body or a header, names the replay base URL's origin instead.

Every step's outcome is compared member by member with `expect`. A step op or
key, or an expect member, that this module has no reader for fails the scenario,
so a scenario added to the contract later is either replayed or refused.

A step's `long_builds` are read from the pollers the client made: each poller
whose build ran on as an operation, not yet reported by an earlier step, gives
its last `operation_id`, its `poll_waits` and its `resubmissions`. Every other
wait the client asks the clock for is a retry's, so the step's `retry_waits` are
the waits it took that no poller counted. A step's `warnings` are the codes of
the warnings of the client's own it issued. Both are compared on every outcome,
as an empty list when the outcome leaves them out.

Each scenario starts as a fresh process would: no warning has been issued.
"""

import asyncio
import inspect
import json
import warnings
from collections import Counter
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

import httpx2
import pytest

from dfo._client.client import AsyncClient
from dfo._core import errors as _errors
from dfo._core.errors import (
    DataWarning,
    DfoError,
    DfoWarning,
    SearchWarning,
    VersionUnavailableError,
)
from dfo._core.refs import DatasetRef, RefMember
from dfo._core.types import Gap, Rendering, Spec
from dfo._datasets import fetch as _fetch
from dfo._datasets import operation as _operation
from dfo._datasets import resolve as _resolve
from dfo._datasets.build import Reading, build_body, layout_of, rendering_for
from dfo._datasets.dataset import Dataset, build_dataset
from dfo._datasets.fetch import Session as AsyncSession
from dfo._http.transport import (
    CLIENT_HEADER,
    CLIENT_IDENTITY,
    USER_AGENT,
    AsyncTransport,
)
from dfo._search.answer import AsyncAnswer
from dfo._sync._client.client import Client
from dfo._sync._datasets import fetch as _sync_fetch
from dfo._sync._datasets import operation as _sync_operation
from dfo._sync._datasets import resolve as _sync_resolve
from dfo._sync._datasets.fetch import Session
from dfo._sync._http.transport import Transport
from dfo._sync._search.answer import Answer
from tests._data import CONTRACT

SCENARIOS_DIR = CONTRACT / "scenarios"
KEY = "dfo_k_4f8Kq2ZtR7mWx1NcB9vLp3YhD6sGa0Ue2wanxe"
# A header the replay's client sets, which only API requests may carry.
REPLAY_HEADER = "x-dfo-replay"

# The base-URL forms each scenario replays under. The replay names its own base
# URL and never reads a record's `origin.base_url`.
BASE_URLS = {
    "api-path": "https://replay.example.org/api",
    "path-trailing-slash": "https://developmentfinance.org/api/v1/",
    "bare-origin": "http://127.0.0.1:8083",
}

# The keys each step op takes, by the form of the step.
STEP_KEYS = {
    "search": {"op", "question"},
    "choose": {"op", "part", "option"},
    "fetch-answer": {"op", "layout", "partial", "strict", "party_totals"},
    "fetch-spec": {
        "op",
        "spec",
        "layout",
        "strict",
        "window",
        "entities",
        "facets",
        "party_totals",
    },
    "fetch-ref": {"op", "ref"},
    "newest_version": {"op", "spec"},
    "mint": {"op", "spec", "layout"},
    "operation": {"op", "operation_id", "layout"},
    "result": {"op"},
}


def _load_scenarios() -> dict[str, dict[str, Any]]:
    records = {
        path.stem: json.loads(path.read_text())
        for path in sorted(SCENARIOS_DIR.glob("*.json"))
    }
    if not records:
        raise RuntimeError(f"No scenario in {SCENARIOS_DIR}")
    return records


SCENARIOS = _load_scenarios()


@dataclass
class Clock:
    """A monotonic clock that a sleep advances at once, recording retry waits.

    A poller counts each poll wait before it sleeps, so a sleep while
    `poll_waits()` exceeds the poll waits seen is a poll's, and any other is a
    retry's.
    """

    poll_waits: Callable[[], int]
    now: float = 1000.0
    polls_seen: int = 0
    retry_waits: list[float] = field(default_factory=list)

    def read(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        if self.poll_waits() > self.polls_seen:
            self.polls_seen += 1
        else:
            self.retry_waits.append(seconds)
        self.now += seconds

    async def async_sleep(self, seconds: float) -> None:
        self.sleep(seconds)


def _origin(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}"


def _recorded_origin(record: Mapping[str, Any]) -> str:
    """The API origin a scenario's responses name: its recording's, or its
    parent's for a synthetic scenario."""
    origin = record["origin"]
    if origin["kind"] == "synthetic":
        origin = SCENARIOS[origin["derived_from"]]["origin"]
    return _origin(origin["base_url"])


class Exchanges:
    """Serves a scenario's exchanges in order, checking each request.

    A response body or header that names the recorded API origin names the
    replay's origin instead, as the server under the replay's base URL would.
    """

    def __init__(self, record: Mapping[str, Any], base_url: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.origin = _origin(base_url)
        self.recorded_origin = _recorded_origin(record)
        self.pending = list(record["exchanges"])
        # Each request the client made, as its method, URL and body.
        self.sent: list[tuple[str, bytes]] = []
        # A recorded scenario lists every body member the client sent.
        self.whole_bodies = record["origin"]["kind"] == "recorded"

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        seen = f"{request.method} {request.url}"
        assert self.pending, f"no exchange left for {seen}"
        self.sent.append((seen, request.content))
        exchange = self.pending.pop(0)
        expected = exchange["request"]
        assert seen == f"{expected['method']} {self._target(expected)}"
        if "url" in expected:
            assert "authorization" not in request.headers, seen
            assert REPLAY_HEADER not in request.headers, seen
            assert CLIENT_HEADER not in request.headers, seen
            assert request.headers.get("user-agent") != USER_AGENT, seen
        else:
            assert request.headers.get("authorization") == f"Bearer {KEY}", seen
            assert request.headers.get(REPLAY_HEADER) == "1", seen
            assert request.headers.get(CLIENT_HEADER) == CLIENT_IDENTITY, seen
        if "json" in expected:
            body = json.loads(request.content)
            for key, value in expected["json"].items():
                assert body.get(key) == value, f"{seen}: body member {key}"
            if self.whole_bodies:
                assert set(body) == set(expected["json"]), seen
        return _response(exchange["response"], self._on_replay_origin)

    def _on_replay_origin(self, text: str) -> str:
        return text.replace(f"{self.recorded_origin}/", f"{self.origin}/")

    def _target(self, expected: Mapping[str, Any]) -> str:
        if "path" in expected:
            return self.base_url + expected["path"]
        if "origin_path" in expected:
            return self.origin + expected["origin_path"]
        return expected["url"]


def _response(
    answer: Mapping[str, Any], rewrite: Callable[[str], str]
) -> httpx2.Response:
    if "body_file" in answer:
        content = (SCENARIOS_DIR / answer["body_file"]).read_bytes()
    elif "json" in answer:
        content = rewrite(json.dumps(answer["json"])).encode()
    else:
        content = b""
    headers = {
        name: rewrite(value) for name, value in answer.get("headers", {}).items()
    }
    return httpx2.Response(answer["status"], headers=headers, content=content)


def _client(
    flavour: str, base_url: str, handler: Exchanges, clock: Clock
) -> AsyncClient | Client:
    if flavour == "async":
        transport = AsyncTransport(
            base_url=base_url,
            api_key=KEY,
            headers={REPLAY_HEADER: "1"},
            http_transport=httpx2.MockTransport(handler),
            sleep=clock.async_sleep,
            clock=clock.read,
        )
        return AsyncClient._over(AsyncSession(transport, None))
    sync = Transport(
        base_url=base_url,
        api_key=KEY,
        headers={REPLAY_HEADER: "1"},
        http_transport=httpx2.MockTransport(handler),
        sleep=clock.sleep,
        clock=clock.read,
    )
    return Client._over(Session(sync, None))


async def _settle(value: Any) -> Any:
    """Await an async client's result; a sync client's arrives as it is."""
    return await value if inspect.isawaitable(value) else value


def _form(step: Mapping[str, Any]) -> str:
    op = step["op"]
    if op != "fetch":
        return op
    if "ref" in step:
        return "fetch-ref"
    return "fetch-spec" if "spec" in step else "fetch-answer"


def _spec(obj: Mapping[str, Any]) -> Spec:
    return Spec(
        obj["spec_id"],
        obj["definition"],
        obj.get("sentence"),
        obj.get("entity_groups"),
    )


def _options(step: Mapping[str, Any], *names: str) -> dict[str, Any]:
    options = {name: step[name] for name in names if name in step}
    if isinstance(options.get("window"), list):
        options["window"] = tuple(options["window"])
    return options


def _latest_ref(step: Mapping[str, Any]) -> DatasetRef:
    """A ref to some version of a fetch-spec step's spec, in the rendering the
    step posts, whose latest fetch builds what the step builds."""
    spec = _spec(step["spec"])
    return DatasetRef(
        (
            RefMember(
                parts=(),
                sentence=step["spec"]["sentence"],
                spec=spec,
                content_version="cv_" + "0" * 32,
                digest="sha256:" + "0" * 64,
                rendering=rendering_for(
                    step.get("layout", "long"),
                    party_totals=step.get("party_totals", False),
                ),
            ),
        )
    )


def _run(
    step: Mapping[str, Any],
    client: AsyncClient | Client,
    answer: Any,
    operation: Any,
    *,
    latest: bool = False,
) -> Any:
    """Start one step; returns an awaitable for the async client. With `latest`,
    a fetch-spec step fetches a ref to its spec with `latest=True`."""
    form = _form(step)
    if form not in STEP_KEYS:
        pytest.fail(f"step op {step['op']!r} has no replay")
    if unknown := set(step) - STEP_KEYS[form]:
        pytest.fail(f"{form} step keys {sorted(unknown)} have no replay")
    match form:
        case "search":
            started = client.search(step["question"])
        case "choose":
            started = answer.choose(step["option"], **_options(step, "part"))
        case "fetch-answer":
            options = _options(step, "layout", "partial", "strict", "party_totals")
            started = answer.fetch(**options)
        case "fetch-spec" if latest:
            options = _options(step, "strict")
            started = client.fetch(_latest_ref(step), latest=True, **options)
        case "fetch-spec":
            options = _options(
                step, "layout", "strict", "window", "entities", "facets", "party_totals"
            )
            started = client.fetch(_spec(step["spec"]), **options)
        case "fetch-ref":
            started = client.fetch(DatasetRef.from_json(json.dumps(step["ref"])))
        case "newest_version":
            # No public call reads the newest version; a ref's fetch looks it
            # up through this one, which the step drives directly.
            lookup = (
                _resolve._newest
                if isinstance(client, AsyncClient)
                else _sync_resolve._newest
            )
            started = lookup(
                client._session.transport,
                step["spec"]["spec_id"],
                deadline=None,
            )
        case "mint":
            started = _mint(client, _spec(step["spec"]), step.get("layout", "long"))
        case "operation":
            started = _resume(client, step["operation_id"], step.get("layout", "long"))
        case _:
            started = _result(client, operation)
    return started


# No public call starts a build without waiting for it, or reads one by its id.
# The `mint`, `operation` and `result` steps drive the poller `fetch` waits
# through, as `newest_version` drives its lookup.


type AnyPoller = _operation.Poller | _sync_operation.Poller


@dataclass(frozen=True)
class LongBuild:
    """A build a `mint` or `operation` step started, which `result` finishes.
    `want` is the reading posted, or None for a build read by its id."""

    poller: AnyPoller
    want: Reading | None
    rendering: Rendering

    @property
    def operation_id(self) -> str | None:
        return self.poller.operation_id

    @property
    def status(self) -> str:
        return self.poller.status


def _engine(client: AsyncClient | Client) -> tuple[Any, Any]:
    """The operation and fetch modules of the client's flavour."""
    if isinstance(client, AsyncClient):
        return _operation, _fetch
    return _sync_operation, _sync_fetch


def _quiet(*_: object) -> None:
    """A progress hook that shows nothing."""


async def _mint(client: AsyncClient | Client, spec: Spec, layout: str) -> LongBuild:
    operation, _ = _engine(client)
    transport = client._session.transport
    # A mint posts the plain rendering.
    rendering = rendering_for(layout, party_totals=True)
    body = build_body(spec, rendering)
    reply = await _settle(operation.post_build(transport, body, deadline=None))
    poller = operation.Poller(transport, reply, body=body, on_progress=_quiet)
    return LongBuild(poller, Reading((), spec, spec.sentence), rendering)


async def _resume(
    client: AsyncClient | Client, operation_id: str, layout: str
) -> LongBuild:
    operation, _ = _engine(client)
    poller = await _settle(
        operation.resume(client._session.transport, operation_id, on_progress=_quiet)
    )
    return LongBuild(poller, None, rendering_for(layout, party_totals=True))


async def _result(client: AsyncClient | Client, build: LongBuild) -> Dataset:
    _, fetch = _engine(client)
    session = client._session
    built = await _settle(build.poller.wait(None))
    member = await _settle(
        fetch.finish_member(
            session.transport,
            built.manifest,
            built.trace_id,
            want=build.want,
            rendering=build.rendering,
            strict=False,
            cache=session.cache,
            deadline=None,
        )
    )
    return build_dataset(
        [member],
        layout=layout_of(build.rendering),
        complete=True,
        missing=(),
        stale=False,
        cache=session.cache,
    )


def _option_count(gap: Gap) -> int:
    return len(gap.options)


def _part_rows(data: Dataset) -> list[dict[str, Any]]:
    # Members stack in order, so first appearance is member order.
    counts = Counter(data.to_arrow().column("part").to_pylist())
    return [{"part": part, "rows": rows} for part, rows in counts.items()]


def _newest_version(error: object) -> str | None:
    if not isinstance(error, VersionUnavailableError):
        pytest.fail(f"newest_version read from {error!r}")
    return error.newest_version


@dataclass(frozen=True)
class NewestVersion:
    """The result of a `newest_version` step."""

    content_version: str | None


@dataclass
class Step:
    """What one step left besides its result: its warnings, the pollers of the
    builds it saw run on, and the waits before its retries."""

    issued: list[warnings.WarningMessage]
    pollers: list[AnyPoller]
    retry_waits: list[float]


# The classes of the warnings the client issues itself, which carry a code from
# `warning-codes.json`; a `DataWarning` or `SearchWarning` carries the server's.
_SERVER_WARNINGS = (DataWarning, SearchWarning)


def _warning_codes(step: Step) -> list[str | None]:
    return [
        w.message.code
        for w in step.issued
        if isinstance(w.message, DfoWarning)
        and not isinstance(w.message, _SERVER_WARNINGS)
    ]


class Pollers:
    """Every poller the client makes, handed to the first step that reads them."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self._made: list[AnyPoller] = []
        self._reported = 0
        for module in (_operation, _sync_operation):
            monkeypatch.setattr(module.Poller, "__init__", self._recording(module))

    def _recording(self, module: Any) -> Callable[..., None]:
        init = module.Poller.__init__

        def record(poller: AnyPoller, *args: Any, **kwargs: Any) -> None:
            init(poller, *args, **kwargs)
            self._made.append(poller)

        return record

    def poll_waits(self) -> int:
        """How many poll waits every poller made so far has counted."""
        return sum(len(poller.poll_waits) for poller in self._made)

    def take(self) -> list[AnyPoller]:
        """The pollers of builds that ran on, made since the last `take`."""
        made, self._reported = self._made[self._reported :], len(self._made)
        return [poller for poller in made if poller.operation_id is not None]


def _long_builds(step: Step) -> list[dict[str, Any]]:
    return [
        {
            "operation_id": poller.operation_id,
            "poll_waits": list(poller.poll_waits),
            "resubmissions": poller.resubmissions,
        }
        for poller in step.pollers
    ]


type Reader = Callable[[Any, Step], Any]

# The members every outcome may give, read on every step and compared as an empty
# list when the outcome leaves them out.
COMMON: dict[str, Reader] = {
    "retry_waits": lambda _, step: step.retry_waits,
    "warnings": lambda _, step: _warning_codes(step),
}

READERS: dict[str, tuple[tuple[type, ...], dict[str, Reader]]] = {
    "answer": (
        (AsyncAnswer, Answer),
        {
            "kind": lambda answer, _: answer.kind,
            "status": lambda answer, _: answer.status,
            "sentence": lambda answer, _: answer.sentence,
            "complete": lambda answer, _: answer.complete,
            "specs": lambda answer, _: [spec.spec_id for spec in answer.specs],
            "gaps": lambda answer, _: [
                {
                    "part": gap.part_index,
                    "kind": gap.kind,
                    "options": _option_count(gap),
                }
                for gap in answer.gaps
            ],
        },
    ),
    "dataset": (
        (Dataset,),
        {
            "rows": lambda data, _: len(data),
            "columns": lambda data, _: list(data.to_arrow().column_names),
            "part_rows": lambda data, _: _part_rows(data),
            "complete": lambda data, _: data.complete,
            "members": lambda data, _: [
                {
                    "parts": list(member.parts),
                    "spec_id": member.spec.spec_id,
                    "content_version": member.content_version,
                    "sentence": member.sentence,
                }
                for member in data.members
            ],
            "missing": lambda data, _: [
                {"part": gap.part_index, "kind": gap.kind} for gap in data.missing
            ],
            "search_warning": lambda _, step: any(
                isinstance(w.message, SearchWarning) for w in step.issued
            ),
            "long_builds": lambda _, step: _long_builds(step),
        },
    ),
    "newest_version": (
        (NewestVersion,),
        {"content_version": lambda found, _: found.content_version},
    ),
    "operation": (
        (LongBuild,),
        {
            "operation_id": lambda operation, _: operation.operation_id,
            "status": lambda operation, _: operation.status,
        },
    ),
    "error": (
        (DfoError, DfoWarning),
        {
            "class": lambda error, _: type(error).__name__,
            "code": lambda error, _: error.code,
            "trace_id": lambda error, _: error.trace_id,
            "newest_version": lambda error, _: _newest_version(error),
            "long_builds": lambda _, step: _long_builds(step),
        },
    ),
}


def _check(where: str, outcome: Mapping[str, Any], result: object, step: Step) -> None:
    if len(outcome) != 1 or (kind := next(iter(outcome))) not in READERS:
        pytest.fail(f"{where}: outcome {sorted(outcome)} has no replay")
    classes, readers = READERS[kind]
    readers = readers | COMMON
    expected = {member: [] for member in COMMON} | outcome[kind]
    if unknown := set(expected) - readers.keys():
        pytest.fail(f"{where}: {kind} members {sorted(unknown)} have no replay")
    if not isinstance(result, classes):
        pytest.fail(f"{where}: expected {kind} {expected}, got {result!r}")
    actual = {member: readers[member](result, step) for member in expected}
    assert actual == expected, where


async def _replay(
    record: Mapping[str, Any],
    client: AsyncClient | Client,
    pollers: Pollers,
    clock: Clock,
    *,
    revive: bool = False,
    latest: bool = False,
) -> None:
    """Run a scenario's steps and check each outcome. With `revive`, each choose
    and answer fetch runs on the answer read back from its JSON, as a web route
    holding the answer between requests would. With `latest`, each fetch-spec
    step fetches a ref to its spec with `latest=True`."""
    calls, outcomes = record["call"], record["expect"]
    assert len(calls) == len(outcomes), "expect holds one outcome per step"
    answer: Any = None
    operation: Any = None
    for index, (step, outcome) in enumerate(zip(calls, outcomes, strict=True)):
        where = f"step {index} ({step['op']})"
        if revive and _form(step) in ("choose", "fetch-answer"):
            answer = type(answer).from_json(answer.to_json(), client=client)
        retried = len(clock.retry_waits)
        with warnings.catch_warnings(record=True) as issued:
            warnings.simplefilter("always")
            try:
                result = await _settle(
                    _run(step, client, answer, operation, latest=latest)
                )
            except (DfoError, DfoWarning) as error:
                if "error" not in outcome:
                    raise
                result = error
        # A mint's builds run on into the `result` step, which reports them.
        taken = [] if "operation" in outcome else pollers.take()
        if step["op"] == "newest_version" and not isinstance(result, DfoError):
            result = NewestVersion(result)
        _check(where, outcome, result, Step(issued, taken, clock.retry_waits[retried:]))
        if isinstance(result, AsyncAnswer | Answer):
            answer = result
        elif isinstance(result, LongBuild):
            operation = result
    await _settle(
        client.aclose() if isinstance(client, AsyncClient) else client.close()
    )


@pytest.fixture(autouse=True)
def fresh_process(monkeypatch: pytest.MonkeyPatch) -> None:
    """Start each scenario online, with no warning issued yet."""
    monkeypatch.delenv("DFO_OFFLINE", raising=False)
    monkeypatch.setenv("DFO_PROGRESS", "0")
    monkeypatch.setattr(_errors, "_warned", set())


# The scenarios with a step that runs on an answer Search gave.
ANSWER_STEPS = [
    name
    for name, record in SCENARIOS.items()
    if any(_form(step) in ("choose", "fetch-answer") for step in record["call"])
]


@pytest.mark.parametrize("flavour", ["async", "sync"])
@pytest.mark.parametrize("form", list(BASE_URLS))
@pytest.mark.parametrize("name", list(SCENARIOS))
def test_scenario_replays(
    name: str, form: str, flavour: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    record = SCENARIOS[name]
    assert record["name"] == name
    base_url = BASE_URLS[form]
    exchanges = Exchanges(record, base_url)
    pollers = Pollers(monkeypatch)
    clock = Clock(pollers.poll_waits)
    client = _client(flavour, base_url, exchanges, clock)
    asyncio.run(_replay(record, client, pollers, clock))
    assert exchanges.pending == [], "the call left exchanges unmade"


@pytest.mark.parametrize("flavour", ["async", "sync"])
@pytest.mark.parametrize("name", ANSWER_STEPS)
def test_a_revived_answer_sends_the_requests_the_original_sends(
    name: str, flavour: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An answer read back from `to_json` chooses and fetches as the answer it
    was written from: the same requests, byte for byte, and the same outcomes."""
    record = SCENARIOS[name]
    sent = []
    for revive in (False, True):
        monkeypatch.setattr(_errors, "_warned", set())
        exchanges = Exchanges(record, BASE_URLS["api-path"])
        pollers = Pollers(monkeypatch)
        clock = Clock(pollers.poll_waits)
        client = _client(flavour, BASE_URLS["api-path"], exchanges, clock)
        asyncio.run(_replay(record, client, pollers, clock, revive=revive))
        assert exchanges.pending == [], "the call left exchanges unmade"
        sent.append(exchanges.sent)
    assert sent[0] == sent[1]


# The scenarios whose every spec fetch builds the spec as Search named it, with
# its sentence, as a latest fetch of a ref to that spec builds it.
LATEST_STEPS = [
    name
    for name, record in SCENARIOS.items()
    if (specs := [step for step in record["call"] if _form(step) == "fetch-spec"])
    and all(
        not {"window", "entities", "facets"} & set(step) and "sentence" in step["spec"]
        for step in specs
    )
]


@pytest.mark.parametrize("flavour", ["async", "sync"])
@pytest.mark.parametrize("name", LATEST_STEPS)
def test_a_latest_ref_fetch_replays_the_spec_fetch(
    name: str, flavour: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`fetch(ref, latest=True)` builds each member's spec as a spec fetch does:
    the same exchanges and the same outcomes."""
    record = SCENARIOS[name]
    exchanges = Exchanges(record, BASE_URLS["api-path"])
    pollers = Pollers(monkeypatch)
    clock = Clock(pollers.poll_waits)
    client = _client(flavour, BASE_URLS["api-path"], exchanges, clock)
    asyncio.run(_replay(record, client, pollers, clock, latest=True))
    assert exchanges.pending == [], "the call left exchanges unmade"


def test_the_latest_replay_covers_both_layouts() -> None:
    layouts = {
        step.get("layout", "long")
        for name in LATEST_STEPS
        for step in SCENARIOS[name]["call"]
        if _form(step) == "fetch-spec"
    }
    assert layouts == {"long", "frame"}


def test_the_revived_replay_covers_choose_steps() -> None:
    """A cut that drops a member a choice posts fails a revived replay."""
    assert any(
        step["op"] == "choose"
        for name in ANSWER_STEPS
        for step in SCENARIOS[name]["call"]
    )
