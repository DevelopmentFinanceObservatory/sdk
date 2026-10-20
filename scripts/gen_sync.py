#!/usr/bin/env python3
"""Generate the sync client modules and tests from their async source, or check them.

    scripts/gen_sync.py           write python/src/dfo/_sync/ and python/tests/_sync/
    scripts/gen_sync.py --check   exit 1 when a generated file differs or is stale

Each async module in `ASYNC_MODULES` becomes `dfo/_sync/<module>.py`, and each
`tests/_async/test_*.py` becomes `tests/_sync/test_*.py`, by replacing the tokens
in `SUBS` line by line and then sorting imports and formatting with ruff. The
generator refuses, naming the file and line:

- an async source that imports asyncio, anyio or trio, since concurrency and
  timeouts have no sync form (members build one after another, and deadlines
  come from the transport's clock);
- a token in `SUBS` that no source uses, so a renamed async name in httpx2 or in
  this package fails here rather than slipping through;
- an async name left in the output (`async`, `await`, `Async*`, `__aenter__`,
  `aclose`, ...), which means `SUBS` lacks a token.
"""

import argparse
import ast
import io
import re
import sys
import tokenize
from dataclasses import dataclass, field
from pathlib import Path

from _codegen import ROOT, format_python, relative, write_or_check

PACKAGE = ROOT / "python" / "src" / "dfo"
SYNC_PACKAGE = PACKAGE / "_sync"
ASYNC_TESTS = ROOT / "python" / "tests" / "_async"
SYNC_TESTS = ROOT / "python" / "tests" / "_sync"

# Async modules of the package, each generating `dfo/_sync/<name>.py`.
ASYNC_MODULES = (
    "_transport",
    "_answer",
    "_search",
    "_operation",
    "_fetch",
    "_lookups",
    "_client",
)

# Hand-written files the sync directories hold beside the generated ones.
KEPT_NAMES = frozenset({"__init__.py", "conftest.py"})

# (async token, sync token), matched on word boundaries. Add a token when a
# source first uses it; an unused token fails the run.
SUBS: tuple[tuple[str, str], ...] = (
    ("async def", "def"),
    ("async with", "with"),
    ("await ", ""),
    ("AsyncTransport", "Transport"),
    ("AsyncAnswer", "Answer"),
    ("AsyncClient", "Client"),
    ("AsyncOperation", "Operation"),
    ("AsyncGraph", "Graph"),
    ("AsyncCodes", "Codes"),
    ("AsyncBaseTransport", "BaseTransport"),
    ("AsyncHeaderProvider", "HeaderProvider"),
    ("AsyncSleep", "Sleep"),
    ("async_sleep", "sync_sleep"),
    ("aclose", "close"),
    ("_afetch", "_fetch"),
    ("afetch", "fetch"),
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
            else:
                continue
            for module in modules:
                if module.split(".")[0] in FORBIDDEN_IMPORTS:
                    self.problems.append(
                        f"{name}:{node.lineno}: imports {module}; async source "
                        "runs one call after another and takes its sleep from the "
                        "transport"
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
    found = [
        (PACKAGE / f"{name}.py", SYNC_PACKAGE / f"{name}.py") for name in ASYNC_MODULES
    ]
    found += [
        (source, SYNC_TESTS / source.name)
        for source in sorted(ASYNC_TESTS.glob("test_*.py"))
    ]
    return found


def stale(generated: set[Path]) -> list[Path]:
    """Return files in the sync directories that nothing generates."""
    return [
        path
        for directory in (SYNC_PACKAGE, SYNC_TESTS)
        for path in sorted(directory.glob("*.py"))
        if path.name not in KEPT_NAMES and path not in generated
    ]


def main(argv: list[str] | None = None) -> int:
    """Write or check the sync files; return the exit status."""
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
    if problems:
        print("\n".join(problems), file=sys.stderr)
        return 1

    differs = [
        target
        for target, text in outputs.items()
        if write_or_check(target, format_python(text, target), check=args.check)
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
