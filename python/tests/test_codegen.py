"""Tests for the code generators in `scripts/`."""

import http.client
import io
import tarfile
from pathlib import Path
from typing import Self

import gen_errors
import gen_sync
import pytest
import sync_contract

_WARNING_CODES = {
    "format_version": 1,
    "codes": [{"code": "a_notice", "class": "DfoWarning", "condition": "C."}],
}
_PROXY_CODES = {
    "format_version": 1,
    "codes": [{"code": "a_limit", "status": 429, "condition": "D."}],
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
        "from dfo._http.transport import AsyncTransport\n"
        "async def run(transport: AsyncTransport) -> None:\n"
        "    async with transport:\n"
        "        await transport.sleep(1)\n"
    )
    assert generator.convert(source, "x.py") == (
        "from dfo._sync._http.transport import Transport\n"
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
    ("line", "module"),
    [
        ("from dfo._datasets import fetch", "dfo._datasets.fetch"),
        ("from dfo._http import hooks, transport", "dfo._http.transport"),
    ],
)
def test_async_source_may_not_import_an_async_module_from_its_package(
    line: str, module: str
) -> None:
    generator = gen_sync.Generator()
    generator.convert(f'"""Doc."""\n{line}\n', "src.py")
    assert [problem.split(";")[0] for problem in generator.problems] == [
        f"src.py:2: imports {module} from its package"
    ]


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
    source = gen_errors.render(
        actions, schema, client_codes, _WARNING_CODES, _PROXY_CODES
    )
    namespace: dict[str, object] = {}
    exec(compile(source, "_error_map.py", "exec"), namespace)
    assert namespace["ACTIONS"] == {"a_code": "fix_request", "b_code": "choose"}
    assert namespace["GAP_KINDS"] == {"b_code": "choice"}
    assert '"new_action"' in source
    assert namespace["CLIENT_CODES"] == {"a_failure": ("ServerError", True)}
    assert namespace["NO_CODE"] == "no_code"
    assert namespace["WARNING_CODES"] == {"a_notice": "DfoWarning"}
    assert namespace["PROXY_STATUSES"] == {"a_limit": 429}


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
        gen_errors.render(
            _REPORT_ACTIONS, _REPORT_SCHEMA, client_codes, _WARNING_CODES, _PROXY_CODES
        )


_CLIENT_CODES = {
    "format_version": 1,
    "codes": [{**_BY_STATUS, "retryable": "by_status"}],
}
_LIMIT = {"code": "a_limit", "status": 429, "condition": "D."}


@pytest.mark.parametrize(
    ("rows", "match"),
    [
        ([_LIMIT, _LIMIT], "a_limit is listed twice"),
        ([{**_LIMIT, "code": "c"}], "c has a row in"),
    ],
    ids=["twice", "has-action"],
)
def test_the_error_map_refuses_proxy_codes_it_cannot_generate(
    rows: list[dict[str, object]], match: str
) -> None:
    proxy_codes = {"format_version": 1, "codes": rows}
    with pytest.raises(SystemExit, match=match):
        gen_errors.render(
            _REPORT_ACTIONS, _REPORT_SCHEMA, _CLIENT_CODES, _WARNING_CODES, proxy_codes
        )


_REV = "a" * 40
_OTHER_REV = "b" * 40
_ESCAPE = f"{sync_contract.PACKAGE_DATA}/../../ESCAPED.txt"


class _CutOffResponse:
    """A response whose connection drops mid-stream, as a cut chunked body does."""

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *exc_info: object) -> None:
        return None

    def read(self, size: int = -1) -> bytes:
        raise http.client.IncompleteRead(b"partial")


def _spec_kit_archive(
    tmp_path: Path, rev: str, extra: dict[str, bytes] | None = None
) -> str:
    """Write a spec-kit archive at `rev` and return a URL template that reaches it.

    `extra` maps member paths below the archive's top directory to file content.
    """
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
        for name, content in (extra or {}).items():
            member = tarfile.TarInfo(f"{top.name}/{name}")
            member.size = len(content)
            archive.addfile(member, io.BytesIO(content))
    return (tmp_path / "{rev}.tar.gz").as_uri().replace("%7Brev%7D", "{rev}")


def test_the_fetch_copies_the_contract_files_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    contract = tmp_path / "repo" / "contract"
    contract.mkdir(parents=True)
    (contract / "SOURCE").write_text(f"{_REV}\n")
    (contract / "stale.json").write_text("{}")
    monkeypatch.setattr(sync_contract, "CONTRACT", contract)
    monkeypatch.setattr(sync_contract, "ARCHIVE", _spec_kit_archive(tmp_path, _REV))

    assert sync_contract.ensure_current() == 3

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
    (tmp_path / f"{_REV}.tar.gz").unlink()
    assert sync_contract.ensure_current() is None
    assert (contract / ".synced").read_text() == f"{_REV}\n"


@pytest.mark.parametrize(
    ("source", "extra", "cut_off", "match"),
    [
        (_OTHER_REV, None, False, rf"{_OTHER_REV}\.tar\.gz"),
        (_REV, {_ESCAPE: b"x"}, False, r"ESCAPED\.txt"),
        (_REV, None, True, rf"{_REV}\.tar\.gz: IncompleteRead"),
        ("dev", None, False, "full commit SHA"),
    ],
    ids=["missing-archive", "escaping-member", "cut-off-response", "branch-name"],
)
def test_a_failed_fetch_leaves_the_copy_and_names_the_command(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    source: str,
    extra: dict[str, bytes] | None,
    cut_off: bool,
    match: str,
) -> None:
    contract = tmp_path / "contract"
    contract.mkdir()
    (contract / "SOURCE").write_text(f"{source}\n")
    (contract / "actions.json").write_text("[]")
    monkeypatch.setattr(sync_contract, "CONTRACT", contract)
    monkeypatch.setattr(
        sync_contract, "ARCHIVE", _spec_kit_archive(tmp_path, _REV, extra)
    )
    if cut_off:
        monkeypatch.setattr(
            sync_contract.urllib.request,
            "urlopen",
            lambda *args, **kwargs: _CutOffResponse(),
        )

    with pytest.raises(sync_contract.FetchError, match=match) as error:
        sync_contract.ensure_current()

    assert sync_contract.FETCH_COMMAND in str(error.value)
    assert sorted(path.name for path in tmp_path.iterdir()) == [
        f"{_REV}.tar.gz",
        "contract",
        f"spec-kit-{_REV}",
    ]
    assert sorted(path.name for path in contract.iterdir()) == [
        "SOURCE",
        "actions.json",
    ]
