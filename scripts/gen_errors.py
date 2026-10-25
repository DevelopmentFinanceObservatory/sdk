#!/usr/bin/env python3
"""Generate the Python client's error map from the contract, or check it.

    scripts/gen_errors.py           write python/src/dfo/_generated/error_map.py
    scripts/gen_errors.py --check   exit 1 when the file differs

The map holds the caller's next step for each refusal code in
`contract/actions.json` and the gap kind of each no_data reason. The `Action` and
`GapKind` literals come from `contract/actions.schema.json`, so an action the
contract adds fails the type check of `dfo._core.refusals` until it maps to a class.

It also holds each row of `contract/client-codes.json` as its code, the name of its
error class and whether it is retryable, and each row of
`contract/warning-codes.json` as its code and the name of its warning class.
`dfo._core.codes` builds the `ClientCode` and `WarningCode` constants from these
rows. The one `by_status` row becomes a plain string constant, since its class and
retryable flag follow the refusal's HTTP status. Each row of
`contract/proxy-codes.json` becomes its code and the HTTP status the website proxy
answers it with, the status whose class the code raises. The module holds literals
only and imports nothing from `dfo`.
"""

import argparse
import json
import sys
from pathlib import Path

import sync_contract
from _codegen import ROOT, relative, write_or_check

ACTIONS = ROOT / "contract" / "actions.json"
SCHEMA = ROOT / "contract" / "actions.schema.json"
CLIENT_CODES = ROOT / "contract" / "client-codes.json"
WARNING_CODES = ROOT / "contract" / "warning-codes.json"
PROXY_CODES = ROOT / "contract" / "proxy-codes.json"
TARGET = ROOT / "python" / "src" / "dfo" / "_generated" / "error_map.py"


BY_STATUS = "by_status"


def _rows(document: dict, path: Path) -> list[dict]:
    """The `codes` rows of a contract file, refused unless it is format version 1
    and holds at least one row."""
    if document.get("format_version") != 1:
        raise SystemExit(f"{relative(path)}: format_version is not 1")
    if not document["codes"]:
        raise SystemExit(f"{relative(path)}: no codes")
    return document["codes"]


def _literal(values: list[str]) -> str:
    return "Literal[" + ", ".join(json.dumps(value) for value in values) + "]"


def _retryable_fits(row: dict) -> bool:
    """A by-status row is retryable by status. Any other row is true or false."""
    if row["class"] == BY_STATUS:
        return row["retryable"] == BY_STATUS
    return isinstance(row["retryable"], bool)


def _client_codes(client_codes: dict) -> tuple[str, list[str], str]:
    """The by-status code and the code names and rows of every other code."""
    rows = _rows(client_codes, CLIENT_CODES)
    by_status = [row["code"] for row in rows if row["class"] == BY_STATUS]
    if len(by_status) != 1:
        raise SystemExit(f"{relative(CLIENT_CODES)}: not exactly one {BY_STATUS} row")
    for row in rows:
        if not _retryable_fits(row):
            raise SystemExit(
                f"{relative(CLIENT_CODES)}: {row['code']} has retryable "
                f"{row['retryable']!r}"
            )
    own = [row for row in rows if row["class"] != BY_STATUS]
    lines = "".join(
        f"    {json.dumps(row['code'])}: ({json.dumps(row['class'])}, "
        f"{row['retryable']}),\n"
        for row in own
    )
    return by_status[0], [row["code"] for row in own], lines


def _warning_codes(warning_codes: dict) -> tuple[list[str], str]:
    """The warning code names and their rows."""
    rows = _rows(warning_codes, WARNING_CODES)
    lines = "".join(
        f"    {json.dumps(row['code'])}: {json.dumps(row['class'])},\n" for row in rows
    )
    return [row["code"] for row in rows], lines


def _proxy_codes(proxy_codes: dict, codes: set[str]) -> str:
    """The rows pairing each proxy code with its status. A proxy code that also
    has a row in `actions.json` (the `codes` set) is refused, since it would take
    that row's class in place of its status's."""
    rows = _rows(proxy_codes, PROXY_CODES)
    seen: set[str] = set()
    for row in rows:
        if row["code"] in seen:
            raise SystemExit(f"{relative(PROXY_CODES)}: {row['code']} is listed twice")
        if row["code"] in codes:
            raise SystemExit(
                f"{relative(PROXY_CODES)}: {row['code']} has a row in "
                f"{relative(ACTIONS)}"
            )
        seen.add(row["code"])
    return "".join(f"    {json.dumps(row['code'])}: {row['status']},\n" for row in rows)


def render(
    actions: dict,
    schema: dict,
    client_codes: dict,
    warning_codes: dict,
    proxy_codes: dict,
) -> str:
    """Return the source of `_generated/error_map.py` for the parsed contract files."""
    rows = _rows(actions, ACTIONS)
    item = schema["properties"]["codes"]["items"]["properties"]
    action_values = item["action"]["enum"]
    gap_values = item["gap_kind"]["enum"]
    code_actions = "".join(
        f"    {json.dumps(row['code'])}: {json.dumps(row['action'])},\n" for row in rows
    )
    gap_kinds = "".join(
        f"    {json.dumps(row['code'])}: {json.dumps(row['gap_kind'])},\n"
        for row in rows
        if "gap_kind" in row
    )
    by_status, client_names, client_rows = _client_codes(client_codes)
    warning_names, warning_rows = _warning_codes(warning_codes)
    proxy_rows = _proxy_codes(proxy_codes, {row["code"] for row in rows})
    return (
        '"""The caller\'s next step for each refusal code, each no_data reason\'s gap\n'
        "kind, the codes the client raises itself, the codes of the warnings it\n"
        "issues itself and the status of each code the website proxy answers itself.\n"
        "\n"
        "Generated by scripts/gen_errors.py from contract/actions.json,\n"
        "contract/client-codes.json, contract/warning-codes.json and\n"
        "contract/proxy-codes.json. Do not edit.\n"
        "`dfo._core.codes` builds the client's error and warning codes from these rows.\n"
        '"""\n'
        "\n"
        "from typing import Final, Literal\n"
        "\n"
        f"type Action = {_literal(action_values)}\n"
        f"type GapKind = {_literal(gap_values)}\n"
        f"type ClientCodeName = {_literal(client_names)}\n"
        "# Every code the client raises itself, the one whose class follows the status\n"
        "# among them.\n"
        f"type ClientErrorCode = ClientCodeName | {_literal([by_status])}\n"
        f"type WarningCodeName = {_literal(warning_names)}\n"
        "\n"
        f"ACTIONS: Final[dict[str, Action]] = {{\n{code_actions}}}\n"
        f"GAP_KINDS: Final[dict[str, GapKind]] = {{\n{gap_kinds}}}\n"
        "\n"
        "# The code of a refusal whose body carries none; its class follows the status.\n"
        f"{by_status.upper()}: Final = {json.dumps(by_status)}\n"
        "\n"
        "# Each code the client raises itself: its error class and whether it is\n"
        "# retryable.\n"
        "CLIENT_CODES: Final[dict[ClientCodeName, tuple[str, bool]]] = {\n"
        f"{client_rows}}}\n"
        "\n"
        "# Each code the client warns with itself: its warning class.\n"
        "WARNING_CODES: Final[dict[WarningCodeName, str]] = {\n"
        f"{warning_rows}}}\n"
        "\n"
        "# Each code the website proxy answers itself: the HTTP status it answers with,\n"
        "# whose class the code raises at any status.\n"
        "PROXY_STATUSES: Final[dict[str, int]] = {\n"
        f"{proxy_rows}}}\n"
    )


def main(argv: list[str] | None = None) -> int:
    """Write or check `_generated/error_map.py` and return the exit status."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="exit 1 on a difference")
    args = parser.parse_args(argv)
    sync_contract.require_current()
    source = render(
        *(
            json.loads(path.read_text(encoding="utf-8"))
            for path in (ACTIONS, SCHEMA, CLIENT_CODES, WARNING_CODES, PROXY_CODES)
        )
    )
    differs = write_or_check(TARGET, source, check=args.check)
    if differs and args.check:
        print(
            f"{relative(TARGET)} is out of date; run scripts/gen_errors.py",
            file=sys.stderr,
        )
        return 1
    if differs:
        print(f"wrote {relative(TARGET)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
