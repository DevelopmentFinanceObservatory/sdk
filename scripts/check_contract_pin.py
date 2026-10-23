#!/usr/bin/env python3
"""Fail unless `contract/SOURCE` is the spec-kit rev dfo-apis pins, or an ancestor.

    scripts/check_contract_pin.py PATH_TO_SPEC_KIT PATH_TO_APIS_PYPROJECT

dfo-apis pins `dfo-spec-kit-client-contract` at a git rev. The scenarios in
`contract/` are only worth replaying here when dfo-apis checks them too, which holds
when `SOURCE` is that rev or an ancestor of it.
"""

import re
import subprocess
import sys
from pathlib import Path

SOURCE = Path(__file__).resolve().parent.parent / "contract" / "SOURCE"
PIN_RE = re.compile(
    r"dfo-spec-kit-client-contract\s*=\s*\{[^}]*\brev\s*=\s*\"([0-9a-f]{40})\""
)


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    spec_kit, apis_pyproject = Path(sys.argv[1]), Path(sys.argv[2])
    source = SOURCE.read_text().strip()
    match = PIN_RE.search(apis_pyproject.read_text())
    if match is None:
        print(
            f"no dfo-spec-kit-client-contract rev in {apis_pyproject}", file=sys.stderr
        )
        return 1
    pin = match.group(1)
    ancestor = subprocess.run(
        ["git", "-C", str(spec_kit), "merge-base", "--is-ancestor", source, pin],
        check=False,
    )
    if ancestor.returncode != 0:
        print(f"SOURCE {source} is not {pin} or an ancestor of it", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
