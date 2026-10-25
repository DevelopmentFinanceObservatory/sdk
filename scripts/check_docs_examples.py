#!/usr/bin/env python3
"""Run the code examples in the SDK docs against a DFO deployment.

    DFO_BASE_URL=https://... uv run --directory python \\
        python ../scripts/check_docs_examples.py [FILE ...] [--language LANG]
        [--report PATH] [--timeout SECONDS] [--list] [--allow-production]

Each fenced `python` block in `README.md`, `python/README.md`, and
`python/docs/*.md`, and each `ts` or `typescript` block in `typescript/README.md`
and `typescript/docs/*.md`, runs against `DFO_BASE_URL` with no API key. The
Python blocks of one file run in order in one namespace, as a notebook would run
them. A TypeScript block that holds an `import` statement starts a program, and
each block after it without one continues that program, so it sees the names the
earlier blocks declared.

The comment `<!-- docs-check: skip -->`, or `<!-- docs-check: skip: REASON -->`,
on the last non-blank line before a block skips the block. A skipped TypeScript
block that starts a program skips the blocks that continue it. A Python or
TypeScript fence that is indented or sits in a list or quote is a marker error.

`DFO_BASE_URL` may not name the public API's host, developmentfinance.org, or a
subdomain of it, unless `--allow-production` is passed. A client built without a
base URL uses `DFO_BASE_URL`; each process checks that before its first block. A
request to the public API fails, checked on its URL as the SDK sends it, so a proxy
does not hide it. Signed downloads and other hosts pass. Prints a line per block
and the counts, writes a Markdown report with `--report`, and exits 1 when a block
fails, a process fails after its last block, or none ran, and 2 on a usage or
marker error.
"""

import argparse
import importlib.util
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import traceback
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Literal
from urllib.parse import urlsplit

type Language = Literal["python", "typescript"]
type Outcome = Literal["pass", "fail", "skip"]

ROOT = Path(__file__).resolve().parent.parent
TYPESCRIPT = ROOT / "typescript"
DEFAULT_FILES = (
    "README.md",
    "python/README.md",
    "python/docs/*.md",
    "typescript/README.md",
    "typescript/docs/*.md",
)
PROGRAM_START = re.compile(r"^\s*import[\s{*\"']", re.MULTILINE)
MARKER = re.compile(r"^<!--\s*docs-check:\s*(?P<directive>.*?)\s*-->$")
SKIP = re.compile(r"^skip(?:\s*:\s*(?P<reason>.+))?$")
# A fence may follow indentation or a list or quote marker; its closing fence has
# a prefix of the same length, the same character, and at least its length.
FENCE_OPEN = re.compile(
    r"^(?P<prefix>[\s>*+\-\d.)]*?)(?P<fence>`{3,}|~{3,})(?P<info>\S*)"
)
FENCE_CLOSE = re.compile(r"^(?P<prefix>[\s>]*?)(?P<fence>`{3,}|~{3,})\s*$")
PACKAGE_IMPORT = re.compile(
    r"""(["'])@developmentfinance/client(?P<subpath>/[\w-]+)?\1"""
)
NODE_ERROR = re.compile(r"^[\w$.]*(?:Error|Exception)\b")
DOC_FRAME = re.compile(r"(?P<where>(?P<path>[^\s()]+\.md):\d+)")
NODE_FRAME = re.compile(r"file://\S*?/chain-\d+\.mts:(?P<line>\d+)(?::\d+)?")
MIN_NODE = (22, 18)
PRODUCTION_HOST = "developmentfinance.org"

LANGUAGES: dict[str, Language] = {
    "python": "python",
    "py": "python",
    "ts": "typescript",
    "typescript": "typescript",
}


class MarkerError(ValueError):
    """A docs-check marker is malformed or misplaced, a fence never closes, or a
    Python or TypeScript block sits indented or in a list or quote."""


class UsageError(ValueError):
    """The command line names a file that does not exist."""


@dataclass(frozen=True)
class Block:
    """A fenced code block; `line` is the line of its opening fence, from 1."""

    path: str
    line: int
    language: Language
    code: str
    skip: str | None = None

    @property
    def where(self) -> str:
        return f"{self.path}:{self.line}"

    @property
    def starts_program(self) -> bool:
        return PROGRAM_START.search(self.code) is not None


@dataclass(frozen=True)
class Result:
    block: Block
    outcome: Outcome
    detail: str = ""


def parse_blocks(path: str, text: str) -> list[Block]:
    """Return the Python and TypeScript blocks of a Markdown file, with their markers.

    Raises:
        MarkerError: A marker names an unknown directive or sits anywhere but
            before a Python or TypeScript block, a fence never closes, or a
            Python or TypeScript fence sits indented or in a list or quote.
    """
    blocks: list[Block] = []
    lines = text.splitlines()
    marker: tuple[int, str] | None = None
    index = 0
    while index < len(lines):
        line = lines[index]
        if (opened := FENCE_OPEN.match(line)) and not (
            opened["fence"][0] == "`" and "`" in opened["info"]
        ):
            start = index
            index += 1
            while index < len(lines) and not _closes(opened, lines[index]):
                index += 1
            if index == len(lines):
                raise MarkerError(f"{path}:{start + 1}: the code fence never closes")
            language = LANGUAGES.get(opened["info"].lower())
            if language is not None and opened["prefix"]:
                raise MarkerError(
                    f"{path}:{start + 1}: a {language} block must open at the start "
                    "of a line, outside lists and quotes, for the check to run it"
                )
            if marker is not None and language is None:
                raise MarkerError(
                    f"{path}:{marker[0]}: a docs-check marker must sit before a "
                    "python or ts block"
                )
            if language is not None:
                code = "\n".join(lines[start + 1 : index])
                skip = marker[1] if marker is not None else None
                blocks.append(Block(path, start + 1, language, code, skip))
            marker = None
        elif found := MARKER.match(line.strip()):
            if marker is not None:
                raise MarkerError(
                    f"{path}:{marker[0]}: two docs-check markers in a row"
                )
            marker = (index + 1, _skip_reason(path, index + 1, found["directive"]))
        elif line.strip() and marker is not None:
            raise MarkerError(
                f"{path}:{marker[0]}: a docs-check marker must sit before a "
                "python or ts block"
            )
        index += 1
    if marker is not None:
        raise MarkerError(f"{path}:{marker[0]}: a docs-check marker ends the file")
    return blocks


def _closes(opened: re.Match[str], line: str) -> bool:
    found = FENCE_CLOSE.match(line)
    return (
        found is not None
        and len(found["prefix"]) == len(opened["prefix"])
        and found["fence"][0] == opened["fence"][0]
        and len(found["fence"]) >= len(opened["fence"])
    )


def _skip_reason(path: str, line: int, directive: str) -> str:
    found = SKIP.match(directive)
    if found is None:
        raise MarkerError(
            f"{path}:{line}: unknown docs-check directive {directive!r}; "
            "the only one is `skip`, or `skip: REASON`"
        )
    return found["reason"] or "marked skip"


def typescript_programs(blocks: Sequence[Block]) -> list[list[Block]]:
    """Group a file's TypeScript blocks into programs, each from an importing block."""
    programs: list[list[Block]] = []
    for block in blocks:
        if block.starts_program or not programs:
            programs.append([block])
        else:
            programs[-1].append(block)
    return programs


def package_entries(client_shim: str) -> dict[str, str]:
    """Map each import path of the package to the module a docs program loads.

    The root loads `client_shim`. Each subpath in the `exports` of
    `typescript/package.json` loads the source file its build comes from, so
    `./dist/wire.js` becomes `src/wire.ts`.
    """
    exports = json.loads((TYPESCRIPT / "package.json").read_text())["exports"]
    entries = {"": client_shim}
    for subpath, target in exports.items():
        if subpath == "." or not isinstance(target, dict):
            continue
        built = PurePosixPath(target["default"]).relative_to("dist")
        entries[subpath.removeprefix(".")] = (
            (TYPESCRIPT / "src" / built).with_suffix(".ts").as_uri()
        )
    return entries


def program_source(
    blocks: Sequence[Block], entries: Mapping[str, str]
) -> tuple[str, list[int]]:
    """Return one module running `blocks` in order, and each block's first line in it.

    Imports of the package load the modules `entries` maps its import paths to,
    and an import path it lacks stays as written. After each block the module calls
    `__dfoDocsCheckDone` with the block's index, on a line of its own, so the lines
    of a block keep their offsets.
    """

    def point(found: re.Match[str]) -> str:
        entry = entries.get(found["subpath"] or "")
        return found[0] if entry is None else json.dumps(entry)

    parts: list[str] = []
    starts: list[int] = []
    line = 1
    for index, block in enumerate(blocks):
        code = PACKAGE_IMPORT.sub(point, block.code)
        starts.append(line)
        parts.extend((code, f"globalThis.__dfoDocsCheckDone({index});"))
        line += code.count("\n") + 2
    return "\n".join(parts) + "\n", starts


def doc_line(blocks: Sequence[Block], starts: Sequence[int], module_line: int) -> str:
    """Name the docs line that line `module_line` of a program module came from."""
    for block, start in reversed(list(zip(blocks, starts, strict=True))):
        if module_line >= start:
            return f"{block.path}:{block.line + 1 + module_line - start}"
    return f"line {module_line}"


def node_error(stderr: str, blocks: Sequence[Block], starts: Sequence[int]) -> str:
    """Return Node's error output with module positions written as docs lines.

    The first line names the docs line the error came from, when a stack frame
    points into the blocks, and Node's line naming the error.
    """
    kept = [
        NODE_FRAME.sub(lambda m: doc_line(blocks, starts, int(m["line"])), line)
        for line in stderr.splitlines()
        if line.strip() and not line.startswith("Node.js v") and "(node:" not in line
    ]
    if not kept:
        return "Node exited without output"
    error = next((line for line in kept if NODE_ERROR.match(line)), kept[0])
    paths = {block.path for block in blocks}
    frame = next((m for line in kept if (m := DOC_FRAME.search(line))), None)
    at = f"{frame['where']}: " if frame and frame["path"] in paths else ""
    return "\n".join([at + error.strip(), *kept[:16]])


def plan_typescript(blocks: Sequence[Block]) -> list[list[Block] | Result]:
    """Return the programs to run, and a skip result for each block left out."""
    planned: list[list[Block] | Result] = []
    for program in typescript_programs(blocks):
        head = program[0]
        if head.skip is not None:
            planned.append(Result(head, "skip", head.skip))
            planned.extend(
                Result(block, "skip", f"continues the skipped block at {head.where}")
                for block in program[1:]
            )
            continue
        planned.extend(
            Result(block, "skip", block.skip)
            for block in program[1:]
            if block.skip is not None
        )
        planned.append([block for block in program if block.skip is None])
    return planned


def finish(
    blocks: Sequence[Block], done: dict[int, Result], failure: str | None
) -> list[Result]:
    """Fill in the blocks a process left without a result.

    `failure` says why the process failed, or is None when it exited 0. The
    first block without a result failed with it, and the rest did not run. When
    every block has a result and the process failed, it failed after the last
    block, and that block fails with it.
    """
    if len(done) == len(blocks) and failure is not None:
        last = blocks[-1]
        detail = f"the process failed after this block: {failure}"
        done = {**done, len(blocks) - 1: Result(last, "fail", detail)}
    results = []
    stopped: Block | None = None
    for index, block in enumerate(blocks):
        if index in done:
            results.append(done[index])
        elif stopped is None:
            stopped = block
            results.append(Result(block, "fail", failure or "the process stopped"))
        else:
            results.append(
                Result(block, "skip", f"not run: {stopped.where} stopped the run")
            )
    return results


@dataclass(frozen=True)
class Run:
    base_url: str
    workdir: Path
    timeout: float

    def env(self) -> dict[str, str]:
        env = {
            key: value
            for key, value in os.environ.items()
            if key not in {"DFO_PROFILE", "DFO_OFFLINE"}
        }
        env.update(
            DFO_API_KEY="",
            DFO_CREDENTIALS_FILE=str(self.workdir / "no-credentials.toml"),
            DFO_CACHE_DIR=str(self.workdir / "cache"),
            DFO_PROGRESS="0",
            DFO_DOCS_CHECK_BASE_URL=self.base_url,
        )
        return env

    def cwd(self, path: str) -> Path:
        cwd = self.workdir / re.sub(r"[^\w.-]", "_", path)
        cwd.mkdir(parents=True, exist_ok=True)
        return cwd


def run_python(run: Run, blocks: Sequence[Block]) -> list[Result]:
    """Run one file's Python blocks in order in one process and namespace."""
    skipped = [
        Result(block, "skip", block.skip) for block in blocks if block.skip is not None
    ]
    todo = [block for block in blocks if block.skip is None]
    if not todo:
        return skipped
    cwd = run.cwd(todo[0].path)
    payload = cwd / "python-blocks.json"
    results_file = cwd / "python-results.jsonl"
    results_file.write_text("")
    payload.write_text(
        json.dumps(
            {
                "results": str(results_file),
                "blocks": [
                    {"path": b.path, "line": b.line, "code": b.code} for b in todo
                ],
            }
        )
    )
    failure = _run_process(
        [
            sys.executable,
            str(Path(__file__).resolve()),
            "--python-worker",
            str(payload),
        ],
        run=run,
        cwd=cwd,
    )
    done = {}
    for line in results_file.read_text().splitlines():
        entry = json.loads(line)
        done[entry["index"]] = Result(
            todo[entry["index"]], entry["outcome"], entry["detail"]
        )
    return _in_file_order(skipped + finish(todo, done, failure))


def run_typescript(
    run: Run, blocks: Sequence[Block], prelude: Path, entries: Mapping[str, str]
) -> list[Result]:
    """Run one file's TypeScript programs, one Node process each."""
    results: list[Result] = []
    for number, item in enumerate(plan_typescript(blocks)):
        if isinstance(item, Result):
            results.append(item)
            continue
        cwd = run.cwd(item[0].path)
        link = cwd / "node_modules"
        if not link.exists():
            link.symlink_to(TYPESCRIPT / "node_modules", target_is_directory=True)
        source, starts = program_source(item, entries)
        module = cwd / f"chain-{number}.mts"
        module.write_text(source)
        done_file = cwd / f"chain-{number}.done"
        done_file.write_text("")
        stderr = _run_process(
            ["node", "--import", prelude.as_uri(), str(module)],
            run=run,
            cwd=cwd,
            extra_env={"DFO_DOCS_CHECK_DONE": str(done_file)},
        )
        finished = {int(line) for line in done_file.read_text().split()}
        done = {index: Result(item[index], "pass") for index in finished}
        failure = node_error(stderr, item, starts) if stderr is not None else None
        results.extend(finish(item, done, failure))
    return _in_file_order(results)


def _run_process(
    command: list[str], *, run: Run, cwd: Path, extra_env: dict[str, str] | None = None
) -> str | None:
    """Run a block runner; return None on exit 0, else why it stopped."""
    try:
        completed = subprocess.run(
            command,
            cwd=cwd,
            env=run.env() | (extra_env or {}),
            capture_output=True,
            text=True,
            timeout=run.timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return f"timed out after {run.timeout:g} s"
    if completed.returncode == 0:
        return None
    return completed.stderr.strip() or f"exited with status {completed.returncode}"


def _in_file_order(results: Iterable[Result]) -> list[Result]:
    return sorted(results, key=lambda result: result.block.line)


PRELUDE = """\
import { appendFileSync } from "node:fs";

const base = new URL(process.env.DFO_DOCS_CHECK_BASE_URL).hostname;
const realFetch = globalThis.fetch;

globalThis.fetch = (input, init) => {
  const plain = typeof input === "string" || input instanceof URL;
  const host = new URL(plain ? String(input) : input.url).hostname;
  const production = host === "__PRODUCTION__" || host.endsWith(".__PRODUCTION__");
  if (production && host !== base) {
    return Promise.reject(
      new TypeError(`docs check: refused a request to ${host}; the examples reach ${base}`),
    );
  }
  return realFetch(input, init);
};

globalThis.__dfoDocsCheckDone = (index) =>
  appendFileSync(process.env.DFO_DOCS_CHECK_DONE, `${index}\\n`);
"""

# The package root a docs program imports: the source's exports, with a `Client`
# whose base URL defaults to the one under check.
CLIENT_SHIM = """\
import { Client as SourceClient } from __SOURCE__;

export * from __SOURCE__;

export class Client extends SourceClient {
  constructor(options = {}) {
    super({ baseUrl: process.env.DFO_DOCS_CHECK_BASE_URL, ...options });
  }
}

const expected = new SourceClient({ baseUrl: process.env.DFO_DOCS_CHECK_BASE_URL }).baseUrl;
const built = new Client().baseUrl;
if (built !== expected) {
  throw new Error(`docs check: new Client() targets ${built}, not ${expected}`);
}
"""


def python_worker(payload_path: Path) -> int:
    """Run the blocks of a payload in one namespace, recording each outcome.

    Requests to the client's default API go to `DFO_DOCS_CHECK_BASE_URL`. A
    request whose URL names a host `refused_host` refuses fails as httpx2 sends
    it, proxy or not, and any other connection to one fails at name resolution.
    """
    payload = json.loads(payload_path.read_text())
    try:
        _guard_python(os.environ["DFO_DOCS_CHECK_BASE_URL"])
    except RuntimeError as error:
        print(error, file=sys.stderr)
        return 1
    namespace: dict[str, object] = {"__name__": "__main__"}
    with Path(payload["results"]).open("a") as results:
        for index, block in enumerate(payload["blocks"]):
            outcome, detail = _exec_block(block, namespace)
            results.write(
                json.dumps({"index": index, "outcome": outcome, "detail": detail})
                + "\n"
            )
            results.flush()
    return 0


def _exec_block(
    block: dict[str, str | int], namespace: dict[str, object]
) -> tuple[Outcome, str]:
    path, line, code = str(block["path"]), int(block["line"]), str(block["code"])
    try:
        # Padding puts the block's first line at its docs line in tracebacks.
        exec(compile("\n" * line + code, path, "exec"), namespace)
    except KeyboardInterrupt:
        raise
    except BaseException as error:  # a block may raise anything, SystemExit included
        frames = [
            frame
            for frame in traceback.extract_tb(error.__traceback__)
            if frame.filename == path
        ]
        at = f"{path}:{frames[-1].lineno}: " if frames else ""
        return "fail", at + "".join(traceback.format_exception_only(error)).strip()
    return "pass", ""


def refused_host(host: str | None, base_host: str | None) -> bool:
    """Whether a docs block may not reach `host`: the public API, unless under check."""
    if host is None or host == base_host:
        return False
    return host == PRODUCTION_HOST or host.endswith(f".{PRODUCTION_HOST}")


class ProductionRequestError(RuntimeError):
    """A docs block sent a request to the public API. The SDK lets it through
    unwrapped and unretried, as it does any error that is not httpx2's."""


def _guard_python(base_url: str) -> None:
    """Point the clients' default base URL at `base_url`, check that every
    client the docs build without one uses it, and refuse the public API.

    Raises:
        RuntimeError: A client built without a base URL targets another one.
    """
    # Imported here so that parsing and listing blocks need no dfo or httpx2.
    import dfo  # noqa: PLC0415
    import httpx2  # noqa: PLC0415
    from dfo._client.default import default_client  # noqa: PLC0415
    from dfo._http import transport  # noqa: PLC0415
    from dfo._sync._http import transport as sync_transport  # noqa: PLC0415

    for module in (transport, sync_transport):
        if not hasattr(module, "DEFAULT_BASE_URL"):
            raise RuntimeError(
                f"{module.__name__} has no DEFAULT_BASE_URL to point at {base_url}"
            )
        vars(module)["DEFAULT_BASE_URL"] = base_url
    expected = dfo.Client(base_url=base_url).base_url
    built = {
        "dfo.Client()": dfo.Client().base_url,
        "dfo.AsyncClient()": dfo.AsyncClient().base_url,
        "the client of dfo.search and dfo.fetch": default_client().base_url,
    }
    for name, url in built.items():
        if url != expected:
            raise RuntimeError(f"docs check: {name} targets {url}, not {expected}")

    base_host = urlsplit(base_url).hostname

    def refuse(request: httpx2.Request) -> None:
        if refused_host(request.url.host, base_host):
            raise ProductionRequestError(
                f"docs check: refused a request to {request.url.host}; "
                f"the examples reach {base_host}"
            )

    send, send_async = httpx2.Client.send, httpx2.AsyncClient.send

    def guarded_send(
        self: httpx2.Client, request: httpx2.Request, **kwargs: Any
    ) -> httpx2.Response:
        refuse(request)
        return send(self, request, **kwargs)

    async def guarded_send_async(
        self: httpx2.AsyncClient, request: httpx2.Request, **kwargs: Any
    ) -> httpx2.Response:
        refuse(request)
        return await send_async(self, request, **kwargs)

    httpx2.Client.send = guarded_send
    httpx2.AsyncClient.send = guarded_send_async
    resolve = socket.getaddrinfo

    def guarded(host: bytes | str | None, *args: object, **kwargs: object) -> object:
        name = host.decode() if isinstance(host, bytes) else host
        if refused_host(name, base_host):
            raise OSError(
                f"docs check: refused a connection to {name}; the examples reach {base_host}"
            )
        return resolve(host, *args, **kwargs)  # ty: ignore[invalid-argument-type] - forwards getaddrinfo's own arguments

    socket.getaddrinfo = guarded  # ty: ignore[invalid-assignment] - same call shape


def collect(files: Sequence[str]) -> list[Block]:
    """Parse the named Markdown files, or the default set, relative to the repo root.

    Raises:
        UsageError: A named file or glob matches no file.
    """
    paths: list[Path] = []
    for pattern in files or DEFAULT_FILES:
        given = Path(pattern)
        if files and (given.is_absolute() or given.exists()):
            found = [given.resolve()] if given.exists() else []
        else:
            found = sorted(ROOT.glob(pattern))
        if files and not found:
            raise UsageError(f"{pattern} names no file")
        paths.extend(found)
    blocks: list[Block] = []
    for path in dict.fromkeys(paths):
        relative = (
            path.relative_to(ROOT).as_posix()
            if path.is_relative_to(ROOT)
            else str(path)
        )
        blocks.extend(parse_blocks(relative, path.read_text()))
    return blocks


def by_file(blocks: Iterable[Block]) -> dict[tuple[str, Language], list[Block]]:
    groups: dict[tuple[str, Language], list[Block]] = {}
    for block in blocks:
        groups.setdefault((block.path, block.language), []).append(block)
    return groups


def report(results: Sequence[Result], base_url: str) -> str:
    """Return the Markdown report: a row per block, then each failure's error."""
    counts = {
        outcome: sum(r.outcome == outcome for r in results)
        for outcome in ("pass", "fail", "skip")
    }
    lines = [
        "# Docs examples check",
        "",
        f"Base URL: {base_url}. Ran {counts['pass'] + counts['fail']} blocks: "
        f"{counts['pass']} passed, {counts['fail']} failed, {counts['skip']} skipped.",
        "",
        "| Block | Language | Outcome | Error or reason |",
        "| --- | --- | --- | --- |",
    ]
    for result in results:
        first = result.detail.splitlines()[0] if result.detail else ""
        cell = first.replace("|", "\\|")
        lines.append(
            f"| {result.block.where} | {result.block.language} | {result.outcome} | {cell} |"
        )
    failures = [result for result in results if result.outcome == "fail"]
    if failures:
        lines += ["", "## Failures"]
        for result in failures:
            lines += [
                "",
                f"### {result.block.where}",
                "",
                "```text",
                result.detail,
                "```",
            ]
    return "\n".join(lines) + "\n"


def _node_problem() -> str | None:
    node = shutil.which("node")
    if node is None:
        return "node is not on PATH"
    version = subprocess.run(
        [node, "--version"], capture_output=True, text=True, check=False
    ).stdout
    found = re.match(r"v(\d+)\.(\d+)", version)
    if found is None or (int(found[1]), int(found[2])) < MIN_NODE:
        return f"the TypeScript blocks need Node 22.18 or later, found {version.strip() or 'none'}"
    if not (TYPESCRIPT / "node_modules").is_dir():
        return "typescript/node_modules is missing; run `pnpm --dir typescript install`"
    return None


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "files", nargs="*", help="Markdown files or globs; the SDK docs by default"
    )
    parser.add_argument("--language", choices=("python", "typescript"))
    parser.add_argument("--report", type=Path, help="write the Markdown report here")
    parser.add_argument(
        "--timeout", type=float, default=1800.0, help="seconds per file or program"
    )
    parser.add_argument(
        "--list", action="store_true", help="list the blocks and stop, offline"
    )
    parser.add_argument(
        "--allow-production",
        action="store_true",
        help="let DFO_BASE_URL name developmentfinance.org, the public API",
    )
    parser.add_argument("--python-worker", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.python_worker:
        return python_worker(args.python_worker)

    try:
        blocks = collect(args.files)
    except (MarkerError, UsageError) as error:
        print(error, file=sys.stderr)
        return 2
    if args.language:
        blocks = [block for block in blocks if block.language == args.language]
    if args.list:
        for block in blocks:
            print(f"{block.where}\t{block.language}\t{_plan_label(block)}")
        print(f"{len(blocks)} blocks")
        return 0

    base_url = os.environ.get("DFO_BASE_URL", "").strip()
    if problem := _refusal(blocks, base_url, allow_production=args.allow_production):
        print(problem, file=sys.stderr)
        return 2
    print(f"checking against {base_url}", flush=True)
    results = check(blocks, base_url=base_url, timeout=args.timeout)
    ran = sum(result.outcome != "skip" for result in results)
    failed = sum(result.outcome == "fail" for result in results)
    skipped = len(results) - ran
    print(
        f"ran {ran} blocks: {ran - failed} passed, {failed} failed, {skipped} skipped"
    )
    if args.report:
        args.report.write_text(report(results, base_url))
    return 1 if failed or ran == 0 else 0


def _plan_label(block: Block) -> str:
    if block.skip is not None:
        return f"skip ({block.skip})"
    if block.language == "python":
        return "run"
    return "starts a program" if block.starts_program else "continues"


def _refusal(
    blocks: Sequence[Block], base_url: str, *, allow_production: bool
) -> str | None:
    """Say why the blocks cannot run here, or return None."""
    if not base_url:
        return "set DFO_BASE_URL to the API the examples should reach"
    host = urlsplit(base_url).hostname
    if refused_host(host, None) and not allow_production:
        return (
            f"DFO_BASE_URL names {host}, the public API; point it at dev, or "
            "pass --allow-production to spend production Search calls"
        )
    languages = {block.language for block in blocks}
    if "python" in languages and importlib.util.find_spec("dfo") is None:
        return "dfo is not importable; run through `uv run --directory python`"
    if "typescript" in languages:
        return _node_problem()
    return None


def check(blocks: Sequence[Block], *, base_url: str, timeout: float) -> list[Result]:
    """Run the blocks file by file in a scratch directory, printing each result."""
    results: list[Result] = []
    with tempfile.TemporaryDirectory(prefix="dfo-docs-check-") as scratch:
        run = Run(base_url=base_url, workdir=Path(scratch), timeout=timeout)
        prelude = run.workdir / "prelude.mjs"
        prelude.write_text(PRELUDE.replace("__PRODUCTION__", PRODUCTION_HOST))
        shim = run.workdir / "client.mjs"
        source = json.dumps((TYPESCRIPT / "src" / "index.node.ts").as_uri())
        shim.write_text(CLIENT_SHIM.replace("__SOURCE__", source))
        entries = package_entries(shim.as_uri())
        for (path, language), group in by_file(blocks).items():
            print(f"{path} ({language}): {len(group)} blocks", flush=True)
            if language == "python":
                found = run_python(run, group)
            else:
                found = run_typescript(run, group, prelude, entries)
            for result in found:
                first = result.detail.splitlines()[0] if result.detail else ""
                line = f"  {result.block.where}  {result.outcome}  {first}"
                print(line.rstrip(), flush=True)
            results.extend(found)
    return results


if __name__ == "__main__":
    sys.exit(main())
