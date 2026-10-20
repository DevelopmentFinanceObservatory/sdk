"""Tests for the code generators in `scripts/`."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

import gen_errors
import gen_sync

from dfo._errors import ClientCode, ServerError


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
            {"code": "a_failure", "class": "ServerError", "condition": "A."},
            {"code": "no_code", "class": "by_status", "condition": "B."},
        ],
    }
    source = gen_errors.render(actions, schema, client_codes)
    namespace: dict[str, object] = {}
    exec(compile(source, "_error_map.py", "exec"), namespace)
    assert namespace["ACTIONS"] == {"a_code": "fix_request", "b_code": "choose"}
    assert namespace["GAP_KINDS"] == {"b_code": "choice"}
    assert '"new_action"' in source
    assert namespace["A_FAILURE"] == ClientCode("a_failure", ServerError)
    assert namespace["NO_CODE"] == "no_code"


def test_the_error_map_refuses_client_codes_without_one_by_status_row() -> None:
    client_codes = {
        "format_version": 1,
        "codes": [{"code": "a_failure", "class": "ServerError", "condition": "A."}],
    }
    with pytest.raises(SystemExit, match="by_status"):
        gen_errors.render(
            {"format_version": 1, "codes": [{"code": "c", "action": "report"}]},
            {
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
            },
            client_codes,
        )
