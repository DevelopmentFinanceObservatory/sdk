#!/usr/bin/env python3
"""Generate the sync client modules and tests from their async source, or check them.

    scripts/gen_sync.py           write python/src/dfo/_sync/ and python/tests/_sync/
    scripts/gen_sync.py --check   exit 1 when a generated file differs or is stale

Each async module in `ASYNC_MODULES`, such as `dfo/_http/transport.py`, becomes
`dfo/_sync/_http/transport.py`, and each `tests/_async/<layer>/test_*.py` becomes
`tests/_sync/<layer>/test_*.py`, by replacing the tokens in `SUBS` line by line and
then sorting imports and formatting with ruff. The generator refuses, naming the
file and line:

- an async source that imports asyncio, anyio or trio, since concurrency and
  timeouts have no sync form (members build one after another, and deadlines
  come from the transport's clock);
- an import of an async module from its package, such as
  `from dfo._datasets import fetch`, since no module name in that line points
  at the sync twin;
- a token in `SUBS` that no source uses, so a renamed async name in httpx2 or in
  this package fails here;
- an async name left in the output (`async`, `await`, `Async*`, `__aenter__`,
  `aclose`, ...), which means `SUBS` lacks a token;
- a sync directory without its hand-written `__init__.py`, without which the
  sync tests collide with the async ones of the same name.
"""

import argparse
import ast
import io
import re
import sys
import tokenize
from dataclasses import dataclass, field
from pathlib import Path

from _codegen import ROOT, relative, write_or_check

PACKAGE = ROOT / "python" / "src" / "dfo"
SYNC_PACKAGE = PACKAGE / "_sync"
ASYNC_TESTS = ROOT / "python" / "tests" / "_async"
SYNC_TESTS = ROOT / "python" / "tests" / "_sync"

# Async modules of the package by dotted name below `dfo`, each generating
# `dfo/_sync/<layer>/<module>.py`.
ASYNC_MODULES = (
    "_http.transport",
    "_search.answer",
    "_search.search",
    "_datasets.operation",
    "_datasets.fetch",
    "_datasets.analysis",
    "_datasets.pin",
    "_datasets.resolve",
    "_search.lookups",
    "_client.client",
)
ASYNC_NAMES = frozenset(f"dfo.{name}" for name in ASYNC_MODULES)

# Hand-written files the sync directories hold beside the generated ones.
KEPT_NAMES = frozenset({"__init__.py", "conftest.py"})

# (async token, sync token), matched on word boundaries. Add a token when a
# source first uses it. An unused token fails the run.
SUBS: tuple[tuple[str, str], ...] = (
    ("async def", "def"),
    ("async with", "with"),
    ("async for", "for"),
    ("await ", ""),
    ("AsyncTransport", "Transport"),
    ("AsyncAnswer", "Answer"),
    # The default client is synchronous, so only `Answer.from_json` defaults it.
    ("*, client: AsyncClient)", "*, client: Client | None = None)"),
    ("AsyncClient", "Client"),
    ("AsyncLookup", "Lookup"),
    ("AsyncAnalysis", "Analysis"),
    ("AsyncBaseTransport", "BaseTransport"),
    ("AsyncHTTPTransport", "HTTPTransport"),
    ("AsyncNetworkBackend", "NetworkBackend"),
    ("AsyncNetworkStream", "NetworkStream"),
    ("AsyncConnectionPool", "ConnectionPool"),
    ("AsyncHeaderProvider", "HeaderProvider"),
    ("AsyncSleep", "Sleep"),
    ("async_sleep", "sync_sleep"),
    ("async_offload", "sync_offload"),
    ("async_within", "sync_within"),
    ("async_interrupt_note", "sync_interrupt_note"),
    ("aclose", "close"),
    ("aread", "read"),
    ("aiter_bytes", "iter_bytes"),
    ("__aenter__", "__enter__"),
    ("__aexit__", "__exit__"),
    ("pytestmark = pytest.mark.anyio", ""),
)

FORBIDDEN_IMPORTS = frozenset({"asyncio", "anyio", "trio"})

ASYNC_NAME = re.compile(
    r"async|await|Async[A-Z]\w*|__a(enter|exit|iter|next)__|a(close|read|send|iter\w*)"
)


def _compile(token: str) -> re.Pattern[str]:
    """Match `token` where its word characters do not run into a longer name."""
    before = r"(?<!\w)" if re.match(r"\w", token) else ""
    after = r"(?!\w)" if re.search(r"\w$", token) else ""
    return re.compile(before + re.escape(token) + after)


@dataclass
class Generator:
    """Applies `subs` to sources and collects what it refuses."""

    subs: tuple[tuple[str, str], ...] = SUBS
    module_subs: tuple[tuple[str, str], ...] = tuple(
        (f"dfo.{name}", f"dfo._sync.{name}") for name in ASYNC_MODULES
    )
    used: set[int] = field(default_factory=set)
    problems: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        self._compiled = [(_compile(a), b) for a, b in self.subs]
        self._module_compiled = [(_compile(a), b) for a, b in self.module_subs]

    def convert(self, source: str, name: str) -> str:
        """Return the sync form of `source`, recording refusals under `name`."""
        self._check_imports(source, name)
        lines = []
        for original in source.splitlines(keepends=True):
            line = original
            for index, (pattern, replacement) in enumerate(self._compiled):
                line, count = pattern.subn(replacement, line)
                if count:
                    self.used.add(index)
            for pattern, replacement in self._module_compiled:
                line = pattern.sub(replacement, line)
            lines.append(line)
        output = "".join(lines)
        self._check_residue(output, name)
        return output

    def _check_imports(self, source: str, name: str) -> None:
        for node in ast.walk(ast.parse(source, filename=name)):
            if isinstance(node, ast.Import):
                modules = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module:
                modules = [node.module]
                self._check_from_package(node, name)
            else:
                continue
            for module in modules:
                if module.split(".")[0] in FORBIDDEN_IMPORTS:
                    self.problems.append(
                        f"{name}:{node.lineno}: imports {module}; async source "
                        "runs one call after another and takes its sleep from the "
                        "transport"
                    )

    def _check_from_package(self, node: ast.ImportFrom, name: str) -> None:
        for alias in node.names:
            module = f"{node.module}.{alias.name}"
            if module in ASYNC_NAMES:
                self.problems.append(
                    f"{name}:{node.lineno}: imports {module} from its package; "
                    f"write `from {module} import ...` so the sync file names "
                    "its twin"
                )

    def _check_residue(self, output: str, name: str) -> None:
        for token in tokenize.generate_tokens(io.StringIO(output).readline):
            if token.type == tokenize.NAME and ASYNC_NAME.fullmatch(token.string):
                self.problems.append(
                    f"{name}:{token.start[0]}: {token.string} has no sync token in SUBS"
                )

    def unused(self) -> list[str]:
        """Return a refusal for each token in `subs` no source used."""
        return [
            f"SUBS token {token!r} is unused; remove it or fix the renamed name"
            for index, (token, _) in enumerate(self.subs)
            if index not in self.used
        ]


def pairs() -> list[tuple[Path, Path]]:
    """Return each async source and the sync file it generates."""
    found = []
    for name in ASYNC_MODULES:
        path = Path(*name.split(".")).with_suffix(".py")
        found.append((PACKAGE / path, SYNC_PACKAGE / path))
    found += [
        (source, SYNC_TESTS / source.relative_to(ASYNC_TESTS))
        for source in sorted(ASYNC_TESTS.rglob("test_*.py"))
    ]
    return found


def stale(generated: set[Path]) -> list[Path]:
    """Return files in the sync directories that nothing generates."""
    return [
        path
        for directory in (SYNC_PACKAGE, SYNC_TESTS)
        for path in sorted(directory.rglob("*.py"))
        if path.name not in KEPT_NAMES and path not in generated
    ]


def missing_inits(targets: set[Path]) -> list[Path]:
    """Return the `__init__.py` each sync directory holding a target lacks."""
    directories = set()
    for target in targets:
        root = SYNC_PACKAGE if target.is_relative_to(SYNC_PACKAGE) else SYNC_TESTS
        directories.update(
            parent for parent in target.parents if parent.is_relative_to(root)
        )
    return [
        directory / "__init__.py"
        for directory in sorted(directories)
        if not (directory / "__init__.py").is_file()
    ]


def main(argv: list[str] | None = None) -> int:
    """Write or check the sync files and return the exit status."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="exit 1 on a difference")
    args = parser.parse_args(argv)

    generator = Generator()
    outputs: dict[Path, str] = {}
    for source, target in pairs():
        converted = generator.convert(
            source.read_text(encoding="utf-8"), relative(source)
        )
        header = f"# Generated by scripts/gen_sync.py from {relative(source)}. Do not edit.\n"
        outputs[target] = header + converted
    problems = generator.problems + generator.unused()
    problems += [
        f"{relative(path)} is missing; the sync directories keep a hand-written one"
        for path in missing_inits(set(outputs))
    ]
    if problems:
        print("\n".join(problems), file=sys.stderr)
        return 1

    differs = [
        target
        for target, text in outputs.items()
        if write_or_check(target, text, check=args.check)
    ]
    leftovers = stale(set(outputs))
    if args.check:
        messages = [f"{relative(path)} is out of date" for path in differs]
        messages += [f"{relative(path)} has no async source" for path in leftovers]
        if messages:
            print("\n".join(messages) + "\nRun scripts/gen_sync.py.", file=sys.stderr)
            return 1
        return 0
    for path in leftovers:
        path.unlink()
        print(f"removed {relative(path)}")
    for path in differs:
        print(f"wrote {relative(path)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
