"""`scripts/check_docs_examples.py` reads blocks and markers, and plans programs."""

import warnings
from pathlib import Path
from urllib.parse import urlsplit

import check_docs_examples as check
import pytest
from check_docs_examples import Block, MarkerError, Result

DOC = """\
# Title

```python
import dfo
```

<!-- docs-check: skip: needs a key -->

```py
key = 1
```

```text
<!-- docs-check: nonsense -->
```

<!-- docs-check: skip -->
```ts
import { Client } from "@developmentfinance/client";
```

```bash
pip install development-finance
```

```typescript
console.log(1);
```
"""


def test_blocks_carry_their_line_language_code_and_skip() -> None:
    blocks = check.parse_blocks("doc.md", DOC)

    assert [(b.line, b.language, b.skip) for b in blocks] == [
        (3, "python", None),
        (9, "python", "needs a key"),
        (18, "typescript", "marked skip"),
        (26, "typescript", None),
    ]
    assert blocks[0].code == "import dfo"
    assert blocks[3].where == "doc.md:26"


@pytest.mark.parametrize(
    ("text", "line"),
    [
        pytest.param("<!-- docs-check: run -->\n```python\n```\n", 1, id="unknown"),
        pytest.param("<!-- docs-check: skip -->\n```text\n```\n", 1, id="before-text"),
        pytest.param(
            "<!-- docs-check: skip -->\nprose\n```python\n```\n", 1, id="prose"
        ),
        pytest.param("```python\n```\n<!-- docs-check: skip -->\n", 3, id="at-end"),
        pytest.param(
            "<!-- docs-check: skip -->\n<!-- docs-check: skip -->\n```ts\n```\n",
            1,
            id="twice",
        ),
        pytest.param("x\n```python\nprint(1)\n", 2, id="unclosed"),
        pytest.param("  ```python\nx = 1\n  ```\n", 1, id="indented"),
        pytest.param("1. ```python\n   x = 1\n   ```\n", 1, id="in-a-list"),
        pytest.param("> ~~~ts\n> f();\n> ~~~\n", 1, id="in-a-quote"),
        pytest.param("```python\nx = 1\n  ```\n", 1, id="close-indent-differs"),
    ],
)
def test_a_bad_marker_or_fence_names_its_line(text: str, line: int) -> None:
    with pytest.raises(MarkerError, match=rf"^doc\.md:{line}: "):
        check.parse_blocks("doc.md", text)


def test_a_fence_closes_on_its_own_character_and_length() -> None:
    text = (
        "````markdown\n```python\nhidden = 1\n```\n````\n"
        "~~~python\nshown = 1\n```\n~~~~\n"
        "  ```text\n  <!-- docs-check: inside -->\n  ```\n"
    )

    blocks = check.parse_blocks("doc.md", text)

    assert [(b.line, b.code) for b in blocks] == [(6, "shown = 1\n```")]


def ts(line: int, code: str, skip: str | None = None) -> Block:
    return Block("doc.md", line, "typescript", code, skip)


def test_an_importing_block_starts_a_program_the_next_ones_continue() -> None:
    first = ts(1, 'import { Client } from "@developmentfinance/client";\nconst a = 1;')
    second = ts(5, "console.log(a);")
    typed = ts(9, 'import type { Part } from "@developmentfinance/client/wire";')
    alone = ts(13, "console.log(2);")

    assert check.typescript_programs([alone, first, second, typed]) == [
        [alone],
        [first, second],
        [typed],
    ]


def test_a_skipped_program_start_skips_its_continuations() -> None:
    head = ts(1, 'import "x";', skip="needs a key")
    after = ts(5, "use();")
    middle_skip = ts(9, "side_effect();", skip="writes a file")
    start = ts(13, 'import "y";')

    planned = check.plan_typescript([head, after, start, middle_skip])

    assert planned == [
        Result(head, "skip", "needs a key"),
        Result(after, "skip", "continues the skipped block at doc.md:1"),
        Result(middle_skip, "skip", "writes a file"),
        [start],
    ]


def test_a_program_points_package_imports_at_its_entries_and_marks_each_block() -> None:
    entries = {"": "file:///shim.mjs", "/wire": "file:///src/wire.ts"}
    blocks = [
        ts(10, 'import { Client } from "@developmentfinance/client";\nconst c = 1;'),
        ts(20, "import type { P } from '@developmentfinance/client/wire';"),
        ts(30, 'import "@developmentfinance/client/nope";\nboom();'),
    ]

    source, starts = check.program_source(blocks, entries)

    assert source.splitlines() == [
        'import { Client } from "file:///shim.mjs";',
        "const c = 1;",
        "globalThis.__dfoDocsCheckDone(0);",
        'import type { P } from "file:///src/wire.ts";',
        "globalThis.__dfoDocsCheckDone(1);",
        'import "@developmentfinance/client/nope";',
        "boom();",
        "globalThis.__dfoDocsCheckDone(2);",
    ]
    assert starts == [1, 4, 6]
    assert check.doc_line(blocks, starts, 7) == "doc.md:32"


def test_a_node_error_leads_with_the_docs_line_and_the_error() -> None:
    blocks = [ts(10, "const a = 1;"), ts(20, "throw new Error('x');")]
    stderr = (
        "file:///tmp/run/chain-0.mts:3\n"
        "throw new Error('x');\n"
        "^\n\n"
        "Error: x\n"
        "    at file:///tmp/run/chain-0.mts:3:7\n"
        "    at ModuleJob.run (node:internal/modules/esm/module_job:1:1)\n\n"
        "Node.js v25.8.1\n"
    )

    detail = check.node_error(stderr, blocks, [1, 3])

    assert detail.splitlines() == [
        "doc.md:21: Error: x",
        "doc.md:21",
        "throw new Error('x');",
        "^",
        "Error: x",
        "    at doc.md:21",
    ]


BLOCKS = [ts(1, "a"), ts(2, "b"), ts(3, "c")]


@pytest.mark.parametrize(
    ("finished", "failure", "outcomes"),
    [
        pytest.param(1, "timed out after 5 s", ["pass", "fail", "skip"], id="stopped"),
        pytest.param(1, None, ["pass", "fail", "skip"], id="exited-0-early"),
        pytest.param(3, "unhandled rejection", ["pass", "pass", "fail"], id="after"),
        pytest.param(3, None, ["pass", "pass", "pass"], id="clean"),
    ],
)
def test_a_failed_or_short_process_fails_a_block_and_the_rest_did_not_run(
    finished: int, failure: str | None, outcomes: list[str]
) -> None:
    done = {index: Result(BLOCKS[index], "pass") for index in range(finished)}

    results = check.finish(BLOCKS, done, failure)

    assert [result.outcome for result in results] == outcomes
    if failure is not None:
        assert failure in next(r.detail for r in results if r.outcome == "fail")


def test_python_blocks_share_a_namespace_and_fail_at_their_docs_line() -> None:
    namespace: dict[str, object] = {}

    first = check._exec_block({"path": "doc.md", "line": 4, "code": "x = 2"}, namespace)
    second = check._exec_block(
        {"path": "doc.md", "line": 9, "code": "y = x * 3\nraise ValueError(y)"},
        namespace,
    )

    assert first == ("pass", "")
    assert second == ("fail", "doc.md:11: ValueError: 6")


def test_a_python_block_reports_its_warnings_and_keeps_its_filters() -> None:
    namespace: dict[str, object] = {}
    warn = "import warnings\nwarnings.warn('a\\n  b', stacklevel=1)"

    with warnings.catch_warnings():
        warnings.simplefilter("always")
        shown = check._exec_block(
            {"path": "doc.md", "line": 2, "code": warn}, namespace
        )
        check._exec_block(
            {"path": "doc.md", "line": 6, "code": "warnings.simplefilter('ignore')"},
            namespace,
        )
        hidden = check._exec_block(
            {"path": "doc.md", "line": 9, "code": warn}, namespace
        )

    assert shown == ("pass", "warning: doc.md:4: UserWarning: a b")
    assert hidden == ("pass", "")


def test_the_report_counts_blocks_and_lists_each_warning_and_failure() -> None:
    passed, failed, warned = ts(1, "a"), ts(5, "b"), ts(9, "c")
    results = [
        Result(passed, "pass"),
        Result(failed, "fail", "doc.md:6: Error: a | b\nstack"),
        Result(warned, "pass", "warning: doc.md:10: SearchWarning: x"),
    ]

    text = check.report(results, "https://dev.example/api")

    assert "Ran 3 blocks: 2 passed, 1 failed, 0 skipped." in text
    assert "## Warnings\n\n### doc.md:9\n\n```text\nwarning: doc.md:10:" in text
    assert "### doc.md:1\n" not in text
    assert "| doc.md:5 | typescript | fail | doc.md:6: Error: a \\| b |" in text
    assert "### doc.md:5\n\n```text\ndoc.md:6: Error: a | b\nstack\n```" in text


def test_listing_needs_no_base_url_and_counts_the_blocks(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    doc = tmp_path / "doc.md"
    doc.write_text(DOC)

    assert check.main([str(doc), "--list", "--language", "typescript"]) == 0

    lines = capsys.readouterr().out.splitlines()
    assert lines[-1] == "2 blocks"
    assert lines[0].endswith("doc.md:18\ttypescript\tskip (marked skip)")
    assert lines[1].endswith("doc.md:26\ttypescript\tcontinues")


@pytest.mark.parametrize(
    "base_url",
    [
        pytest.param(None, id="unset"),
        pytest.param("https://developmentfinance.org/api/v1", id="production"),
        pytest.param("https://api.developmentfinance.org/v1", id="subdomain"),
    ],
)
def test_a_run_without_a_base_url_or_against_production_refuses(
    base_url: str | None,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    if base_url is None:
        monkeypatch.delenv("DFO_BASE_URL", raising=False)
    else:
        monkeypatch.setenv("DFO_BASE_URL", base_url)

    assert check.main(["--language", "python"]) == 2
    assert "DFO_BASE_URL" in capsys.readouterr().err


@pytest.mark.parametrize("name", ["nope.md", "python/docs/answer.md", "nope/*.md"])
def test_a_named_file_that_matches_nothing_is_a_usage_error(
    name: str, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    doc = tmp_path / "doc.md"
    doc.write_text(DOC)

    assert check.main([str(doc), name, "--list"]) == 2
    assert name in capsys.readouterr().err


def test_the_python_worker_points_clients_at_the_base_url_and_refuses_production(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A proxy that resolves no production name, so only the send guard can refuse.
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:9")
    production = "https://developmentfinance.org/api/v1"
    blocks = [
        Block(
            "doc.md",
            1,
            "python",
            "import dfo\nassert dfo.Client().base_url.startswith('http://127.0.0.1:9')",
        ),
        Block(
            "doc.md",
            5,
            "python",
            f"dfo.Client(base_url={production!r}).lookup.catalogue()",
        ),
        Block(
            "doc.md",
            9,
            "python",
            "import asyncio\n"
            f"asyncio.run(dfo.AsyncClient(base_url={production!r}).lookup.catalogue())",
        ),
    ]
    run = check.Run(base_url="http://127.0.0.1:9/api", workdir=tmp_path, timeout=60)

    results = check.run_python(run, blocks)

    assert [result.outcome for result in results] == ["pass", "fail", "fail"]
    assert all("ProductionRequestError" in result.detail for result in results[1:])


def test_the_sdk_docs_parse_and_hold_blocks_of_both_languages() -> None:
    blocks = check.collect([])

    assert {block.language for block in blocks} == {"python", "typescript"}
    assert all(block.path.endswith(".md") and block.path[0] != "/" for block in blocks)
    assert {"README.md", "python/README.md", "typescript/README.md"} <= {
        block.path for block in blocks
    }


def test_the_package_subpaths_load_source_files_that_exist() -> None:
    entries = check.package_entries()

    assert entries.pop("") == check.NODE_ENTRY.as_uri()
    assert sorted(entries) == ["/arrow", "/errors", "/types", "/wire"]
    assert all(Path(urlsplit(url).path).is_file() for url in entries.values())


@pytest.mark.parametrize(
    ("host", "base_host", "refused"),
    [
        ("developmentfinance.org", "dev.run.app", True),
        ("api.developmentfinance.org", "dev.run.app", True),
        ("notdevelopmentfinance.org", "dev.run.app", False),
        ("storage.googleapis.com", "dev.run.app", False),
        ("dev.run.app", "dev.run.app", False),
        ("developmentfinance.org", "developmentfinance.org", False),
    ],
)
def test_only_the_public_api_is_refused_unless_it_is_under_check(
    host: str, base_host: str, refused: bool
) -> None:
    assert check.refused_host(host, base_host) is refused
