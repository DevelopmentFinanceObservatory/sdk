"""Replay every scenario in `contract/scenarios/` over `Client` and `AsyncClient`.

Each scenario runs once per client flavour and once per base-URL form in
`BASE_URLS`, through `_over(Session(transport, None))` with a mock HTTP transport
that serves the scenario's exchanges in order, and an injected clock whose sleep
advances it at once. A request matches the next exchange on its method and full
URL: `path` under the base URL, `origin_path` against the base URL's origin, and
`url` as it stands. API requests carry the key and the client's headers; a signed
storage URL gets a bare request.

Every step's outcome is compared member by member with `expect`. A step op or
key, or an expect member, that this module has no reader for fails the scenario,
so a scenario added to the contract later is either replayed or refused.

A step's `long_builds` are read from the pollers the client made: each poller
whose build ran on as an operation, not yet reported by an earlier step, gives
its last `operation_id`, its `poll_waits` and its `resubmissions`.
"""

import asyncio
import inspect
import json
import warnings
from collections import Counter
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from itertools import pairwise
from typing import Any
from urllib.parse import urlsplit

import httpx2
import pytest

from dfo import _operation
from dfo._answer import AsyncAnswer
from dfo._client import AsyncClient
from dfo._dataset import Dataset
from dfo._errors import DfoError, DfoWarning, SearchWarning, VersionUnavailableError
from dfo._fetch import Session as AsyncSession
from dfo._operation import AsyncOperation
from dfo._sync import _operation as _sync_operation
from dfo._sync._answer import Answer
from dfo._sync._client import Client
from dfo._sync._fetch import Session
from dfo._sync._operation import Operation
from dfo._sync._transport import Transport
from dfo._transport import USER_AGENT, AsyncTransport
from dfo._types import DatasetRef, Gap, Spec

from .._data import CONTRACT

SCENARIOS_DIR = CONTRACT / "scenarios"
KEY = "dfo_k_4f8Kq2ZtR7mWx1NcB9vLp3YhD6sGa0Ue2wanxe"
CLIENT_HEADER = "x-dfo-replay"

# The base-URL forms each scenario replays under. The replay names its own base
# URL and never reads a record's `origin.base_url`.
BASE_URLS = {
    "api-path": "https://replay.example.org/api",
    "path-trailing-slash": "https://developmentfinance.org/api/v1/",
    "bare-origin": "http://127.0.0.1:8083",
}

# The keys each step op takes, by the form of the step.
STEP_KEYS = {
    "search": {"op", "question", "timeout"},
    "choose": {"op", "part", "option"},
    "fetch-answer": {"op", "layout", "partial", "strict", "timeout"},
    "fetch-spec": {
        "op",
        "spec",
        "layout",
        "strict",
        "timeout",
        "window",
        "entities",
        "facets",
    },
    "fetch-ref": {"op", "ref", "timeout"},
    "mint": {"op", "spec", "layout"},
    "operation": {"op", "operation_id", "layout"},
    "result": {"op", "timeout"},
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
    """A monotonic clock that a sleep advances at once, recording each wait."""

    now: float = 1000.0
    waits: list[float] = field(default_factory=list)

    def read(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.waits.append(seconds)
        self.now += seconds

    async def async_sleep(self, seconds: float) -> None:
        self.sleep(seconds)


class Exchanges:
    """Serves a scenario's exchanges in order, checking each request."""

    def __init__(self, record: Mapping[str, Any], base_url: str) -> None:
        parts = urlsplit(base_url)
        self.base_url = base_url.rstrip("/")
        self.origin = f"{parts.scheme}://{parts.netloc}"
        self.pending = list(record["exchanges"])
        # A recorded scenario lists every body member the client sent.
        self.whole_bodies = record["origin"]["kind"] == "recorded"

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        seen = f"{request.method} {request.url}"
        assert self.pending, f"no exchange left for {seen}"
        exchange = self.pending.pop(0)
        expected = exchange["request"]
        assert seen == f"{expected['method']} {self._target(expected)}"
        if "url" in expected:
            assert "authorization" not in request.headers, seen
            assert CLIENT_HEADER not in request.headers, seen
            assert request.headers.get("user-agent") != USER_AGENT, seen
        else:
            assert request.headers.get("authorization") == f"Bearer {KEY}", seen
            assert request.headers.get(CLIENT_HEADER) == "1", seen
        if "json" in expected:
            body = json.loads(request.content)
            for key, value in expected["json"].items():
                assert body.get(key) == value, f"{seen}: body member {key}"
            if self.whole_bodies:
                assert set(body) == set(expected["json"]), seen
        return _response(exchange["response"])

    def _target(self, expected: Mapping[str, Any]) -> str:
        if "path" in expected:
            return self.base_url + expected["path"]
        if "origin_path" in expected:
            return self.origin + expected["origin_path"]
        return expected["url"]


def _response(answer: Mapping[str, Any]) -> httpx2.Response:
    if "body_file" in answer:
        content = (SCENARIOS_DIR / answer["body_file"]).read_bytes()
    elif "json" in answer:
        content = json.dumps(answer["json"]).encode()
    else:
        content = b""
    return httpx2.Response(
        answer["status"], headers=answer.get("headers", {}), content=content
    )


def _retry_waits(record: Mapping[str, Any]) -> Counter[float]:
    """The `Retry-After` waits the client must take before repeating a refused
    request. A poll that answers paces the next by its resource's
    `retry_after_ms` first, which `long_builds` checks."""
    waits: Counter[float] = Counter()
    for current, following in pairwise(record["exchanges"]):
        response = current["response"]
        value = response.get("headers", {}).get("retry-after")
        if (
            value is not None
            and response["status"] >= 400
            and current["request"] == following["request"]
        ):
            waits[float(value)] += 1
    return waits


def _client(
    flavour: str, base_url: str, handler: Exchanges, clock: Clock
) -> AsyncClient | Client:
    if flavour == "async":
        transport = AsyncTransport(
            base_url=base_url,
            api_key=KEY,
            default_headers={CLIENT_HEADER: "1"},
            http_transport=httpx2.MockTransport(handler),
            sleep=clock.async_sleep,
            clock=clock.read,
        )
        return AsyncClient._over(AsyncSession(transport, None))
    sync = Transport(
        base_url=base_url,
        api_key=KEY,
        default_headers={CLIENT_HEADER: "1"},
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


def _run(
    step: Mapping[str, Any],
    client: AsyncClient | Client,
    answer: Any,
    operation: Any,
) -> Any:
    """Start one step; returns an awaitable for the async client."""
    form = _form(step)
    if form not in STEP_KEYS:
        pytest.fail(f"step op {step['op']!r} has no replay")
    if unknown := set(step) - STEP_KEYS[form]:
        pytest.fail(f"{form} step keys {sorted(unknown)} have no replay")
    match form:
        case "search":
            started = client.search(step["question"], **_options(step, "timeout"))
        case "choose":
            choice = (
                (step["part"], step["option"]) if "part" in step else (step["option"],)
            )
            started = answer.choose(*choice)
        case "fetch-answer":
            options = _options(step, "layout", "partial", "strict", "timeout")
            started = answer.fetch(**options)
        case "fetch-spec":
            options = _options(
                step, "layout", "strict", "timeout", "window", "entities", "facets"
            )
            started = client.fetch(_spec(step["spec"]), **options)
        case "fetch-ref":
            ref = DatasetRef.from_json(json.dumps(step["ref"]))
            started = client.fetch(ref, **_options(step, "timeout"))
        case "mint":
            started = client.mint(_spec(step["spec"]), **_options(step, "layout"))
        case "operation":
            started = client.operation(step["operation_id"], **_options(step, "layout"))
        case _:
            started = operation.result(**_options(step, "timeout"))
    return started


def _option_count(gap: Gap[Any]) -> int:
    return len(gap.options)


def _part_rows(data: Dataset) -> list[dict[str, Any]]:
    # Members stack in order, so first appearance is member order.
    counts = Counter(data.to_arrow().column("part").to_pylist())
    return [{"part": part, "rows": rows} for part, rows in counts.items()]


def _newest_version(error: object) -> str | None:
    if not isinstance(error, VersionUnavailableError):
        pytest.fail(f"newest_version read from {error!r}")
    return error.newest_version


type AnyPoller = _operation.Poller | _sync_operation.Poller


@dataclass
class Step:
    """What one step left besides its result: its warnings, and the pollers of
    the builds it saw run on."""

    issued: list[warnings.WarningMessage]
    pollers: list[AnyPoller]


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
            "rows": lambda data, _: data.rows,
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
    "operation": (
        (AsyncOperation, Operation),
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
            "newest_version": lambda error, _: _newest_version(error),
            "long_builds": lambda _, step: _long_builds(step),
        },
    ),
}


def _check(where: str, outcome: Mapping[str, Any], result: object, step: Step) -> None:
    if len(outcome) != 1 or (kind := next(iter(outcome))) not in READERS:
        pytest.fail(f"{where}: outcome {sorted(outcome)} has no replay")
    classes, readers = READERS[kind]
    expected = outcome[kind]
    if unknown := set(expected) - readers.keys():
        pytest.fail(f"{where}: {kind} members {sorted(unknown)} have no replay")
    if not isinstance(result, classes):
        pytest.fail(f"{where}: expected {kind} {expected}, got {result!r}")
    actual = {member: readers[member](result, step) for member in expected}
    assert actual == expected, where


async def _replay(
    record: Mapping[str, Any], client: AsyncClient | Client, pollers: Pollers
) -> None:
    calls, outcomes = record["call"], record["expect"]
    assert len(calls) == len(outcomes), "expect holds one outcome per step"
    answer: Any = None
    operation: Any = None
    for index, (step, outcome) in enumerate(zip(calls, outcomes, strict=True)):
        where = f"step {index} ({step['op']})"
        with warnings.catch_warnings(record=True) as issued:
            warnings.simplefilter("always")
            try:
                result = await _settle(_run(step, client, answer, operation))
            except (DfoError, DfoWarning) as error:
                if "error" not in outcome:
                    raise
                result = error
        # A mint's builds run on into the `result` step, which reports them.
        taken = [] if "operation" in outcome else pollers.take()
        _check(where, outcome, result, Step(issued, taken))
        if isinstance(result, AsyncAnswer | Answer):
            answer = result
        elif isinstance(result, AsyncOperation | Operation):
            operation = result
    await _settle(
        client.aclose() if isinstance(client, AsyncClient) else client.close()
    )


@pytest.fixture(autouse=True)
def online(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DFO_OFFLINE", raising=False)
    monkeypatch.setenv("DFO_PROGRESS", "0")


@pytest.mark.parametrize("flavour", ["async", "sync"])
@pytest.mark.parametrize("form", list(BASE_URLS))
@pytest.mark.parametrize("name", list(SCENARIOS))
def test_scenario_replays(
    name: str, form: str, flavour: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    record = SCENARIOS[name]
    assert record["name"] == name
    base_url = BASE_URLS[form]
    clock = Clock()
    exchanges = Exchanges(record, base_url)
    pollers = Pollers(monkeypatch)
    client = _client(flavour, base_url, exchanges, clock)
    asyncio.run(_replay(record, client, pollers))
    assert exchanges.pending == [], "the call left exchanges unmade"
    assert Counter(clock.waits) >= _retry_waits(record), clock.waits
