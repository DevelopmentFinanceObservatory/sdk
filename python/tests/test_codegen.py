"""Tests for the code generators in `scripts/`."""

import sys
import tarfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

import gen_errors
import gen_sync
import sync_contract

from dfo._errors import ClientCode, DfoWarning, ServerError, WarningCode

_WARNING_CODES = {
    "format_version": 1,
    "codes": [{"code": "a_notice", "class": "DfoWarning", "condition": "C."}],
}
_REPORT_ACTIONS = {"format_version": 1, "codes": [{"code": "c", "action": "report"}]}
_REPORT_SCHEMA = {
    "properties": {
        "codes": {
            "items": {
                "properties": {
                    "action": {"enum": ["report"]},
                    "gap_kind": {"enum": []},
                }
            }
        }
    }
}


def test_the_token_map_rewrites_async_source() -> None:
    generator = gen_sync.Generator()
    source = (
        "from dfo._transport import AsyncTransport\n"
        "async def run(transport: AsyncTransport) -> None:\n"
        "    async with transport:\n"
        "        await transport.sleep(1)\n"
    )
    assert generator.convert(source, "x.py") == (
        "from dfo._sync._transport import Transport\n"
        "def run(transport: Transport) -> None:\n"
        "    with transport:\n"
        "        transport.sleep(1)\n"
    )
    assert generator.problems == []


def test_tokens_match_whole_names_only() -> None:
    generator = gen_sync.Generator()
    assert generator.convert("MyAsyncClientFactory = aclosed\n", "x.py") == (
        "MyAsyncClientFactory = aclosed\n"
    )


@pytest.mark.parametrize(
    "line",
    [
        "import asyncio",
        "from asyncio import gather",
        "import anyio.abc",
        "from trio import open_nursery",
    ],
)
def test_async_source_may_not_import_an_event_loop_library(line: str) -> None:
    generator = gen_sync.Generator()
    generator.convert(f'"""Doc."""\n{line}\n', "src.py")
    assert generator.problems
    assert generator.problems[0].startswith("src.py:2: imports")


@pytest.mark.parametrize(
    "source",
    [
        "async for item in items:\n    pass\n",
        "x = httpx2.AsyncByteStream\n",
        "await response.aread()\n",
        "def __aiter__(self): ...\n",
    ],
)
def test_an_async_name_left_in_the_output_is_refused(source: str) -> None:
    generator = gen_sync.Generator(subs=())
    generator.convert(source, "src.py")
    assert generator.problems
    assert "has no sync token" in generator.problems[0]


def test_async_names_in_strings_and_comments_pass() -> None:
    generator = gen_sync.Generator(subs=())
    generator.convert('x = "await the async result"  # async\n', "src.py")
    assert generator.problems == []


def test_an_unused_token_is_reported() -> None:
    generator = gen_sync.Generator(subs=(("aclose", "close"), ("aread", "read")))
    generator.convert("client.aclose()\n", "src.py")
    assert generator.unused() == [
        "SUBS token 'aread' is unused; remove it or fix the renamed name"
    ]


def test_the_error_map_takes_its_literals_from_the_schema() -> None:
    actions = {
        "format_version": 1,
        "codes": [
            {"code": "a_code", "action": "fix_request"},
            {"code": "b_code", "action": "choose", "gap_kind": "choice"},
        ],
    }
    schema = {
        "properties": {
            "codes": {
                "items": {
                    "properties": {
                        "action": {"enum": ["fix_request", "choose", "new_action"]},
                        "gap_kind": {"enum": ["choice"]},
                    }
                }
            }
        }
    }
    client_codes = {
        "format_version": 1,
        "codes": [
            {
                "code": "a_failure",
                "class": "ServerError",
                "retryable": True,
                "condition": "A.",
            },
            {
                "code": "no_code",
                "class": "by_status",
                "retryable": "by_status",
                "condition": "B.",
            },
        ],
    }
    source = gen_errors.render(actions, schema, client_codes, _WARNING_CODES)
    namespace: dict[str, object] = {}
    exec(compile(source, "_error_map.py", "exec"), namespace)
    assert namespace["ACTIONS"] == {"a_code": "fix_request", "b_code": "choose"}
    assert namespace["GAP_KINDS"] == {"b_code": "choice"}
    assert '"new_action"' in source
    assert namespace["A_FAILURE"] == ClientCode("a_failure", ServerError, True)
    assert namespace["NO_CODE"] == "no_code"
    assert namespace["A_NOTICE"] == WarningCode("a_notice", DfoWarning)


_FAILURE = {"code": "a_failure", "class": "ServerError", "condition": "A."}
_BY_STATUS = {"code": "no_code", "class": "by_status", "condition": "B."}


@pytest.mark.parametrize(
    ("rows", "match"),
    [
        ([{**_FAILURE, "retryable": False}], "by_status row"),
        (
            [
                {**_FAILURE, "retryable": "by_status"},
                {**_BY_STATUS, "retryable": "by_status"},
            ],
            "a_failure has retryable",
        ),
        (
            [{**_FAILURE, "retryable": False}, {**_BY_STATUS, "retryable": True}],
            "no_code has retryable",
        ),
    ],
    ids=["no-by-status-row", "flag-by-status", "by-status-flag-bool"],
)
def test_the_error_map_refuses_client_codes_it_cannot_generate(
    rows: list[dict[str, object]], match: str
) -> None:
    client_codes = {"format_version": 1, "codes": rows}
    with pytest.raises(SystemExit, match=match):
        gen_errors.render(_REPORT_ACTIONS, _REPORT_SCHEMA, client_codes, _WARNING_CODES)


def _spec_kit_archive(tmp_path: Path, rev: str) -> str:
    """Write a spec-kit archive at `rev` and return a URL template that reaches it."""
    top = tmp_path / f"spec-kit-{rev}"
    package = top / sync_contract.PACKAGE_DATA
    (package / "rules").mkdir(parents=True)
    (package / "rules" / "paths.json").write_text("{}")
    (package / "actions.json").write_text("[]")
    (package / "__init__.py").write_text("")
    (package / "py.typed").write_text("")
    (top / sync_contract.PACKAGE_README).write_text("# Rules\n")
    (top / "README.md").write_text("# spec-kit\n")
    with tarfile.open(tmp_path / f"{rev}.tar.gz", "w:gz") as archive:
        archive.add(top, arcname=top.name)
    return (tmp_path / "{rev}.tar.gz").as_uri().replace("%7Brev%7D", "{rev}")


def test_the_fetch_copies_the_contract_files_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    contract = tmp_path / "repo" / "contract"
    contract.mkdir(parents=True)
    (contract / "SOURCE").write_text("abc\n")
    (contract / "stale.json").write_text("{}")
    monkeypatch.setattr(sync_contract, "CONTRACT", contract)
    monkeypatch.setattr(sync_contract, "ARCHIVE", _spec_kit_archive(tmp_path, "abc"))

    sync_contract.ensure_current()

    files = sorted(
        path.relative_to(contract).as_posix()
        for path in contract.rglob("*")
        if path.is_file()
    )
    assert files == [
        ".synced",
        "README.md",
        "SOURCE",
        "actions.json",
        "rules/paths.json",
    ]
    assert (contract / "README.md").read_text() == "# Rules\n"
    (tmp_path / "abc.tar.gz").unlink()
    sync_contract.ensure_current()
    assert (contract / ".synced").read_text() == "abc\n"


def test_a_failed_fetch_leaves_the_copy_and_names_the_command(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    contract = tmp_path / "contract"
    contract.mkdir()
    (contract / "SOURCE").write_text("missing\n")
    (contract / "actions.json").write_text("[]")
    monkeypatch.setattr(sync_contract, "CONTRACT", contract)
    monkeypatch.setattr(sync_contract, "ARCHIVE", _spec_kit_archive(tmp_path, "abc"))

    with pytest.raises(sync_contract.FetchError, match=r"missing\.tar\.gz") as error:
        sync_contract.ensure_current()

    assert sync_contract.FETCH_COMMAND in str(error.value)
    assert sorted(path.name for path in tmp_path.iterdir()) == [
        "abc.tar.gz",
        "contract",
        "spec-kit-abc",
    ]
    assert sorted(path.name for path in contract.iterdir()) == [
        "SOURCE",
        "actions.json",
    ]
