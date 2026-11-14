"""Refuse a release that production would answer with 400 on a default fetch.

Both clients post `party_totals: false` for the party totals cut, which a fetch makes
by default, and a server accepts that key only from dfo-apis 133262c5e on. This
script runs the Python client against the default base URL, which is production
through the public proxy, with no key:

1. A control fetch with `party_totals=True` posts no cut key, so every server
   accepts it. A failure means production could not be reached, and the release
   stops without a verdict on the key.
2. The default fetch posts `party_totals: false`. A failure means production does
   not accept the key yet.

    cd python && uv run python ../scripts/release_preflight.py

It exits 0 when both fetches return at least one row, and 1 otherwise, with the
reason and the class of any error the client raised.
"""

import sys

from dfo import Client
from dfo.errors import DfoError

QUESTION = "Kenya population, 2015 to 2024"
CONTROL_FAILED = (
    "preflight stopped: production could not be reached or the control question"
    " did not answer definitely"
)
KEY_REFUSED = "production does not accept party_totals"


def main() -> int:
    # api_key=False skips DFO_API_KEY and the credentials file, so the run is
    # anonymous on every machine.
    with Client(api_key=False, cache=False) as client:
        try:
            answer = client.search(QUESTION)
            control = answer.fetch(party_totals=True).to_arrow().num_rows
        except DfoError as error:
            print(f"{CONTROL_FAILED}: {type(error).__name__}: {error}", file=sys.stderr)
            return 1
        if control == 0:
            print(
                f"{CONTROL_FAILED}: the control fetch returned no rows", file=sys.stderr
            )
            return 1
        try:
            default = answer.fetch().to_arrow().num_rows
        except DfoError as error:
            print(f"{KEY_REFUSED}: {type(error).__name__}: {error}", file=sys.stderr)
            return 1
        if default == 0:
            print(
                f"preflight stopped: the default fetch returned no rows, the control"
                f" {control}",
                file=sys.stderr,
            )
            return 1
    print(
        f"production accepts party_totals: control {control} rows,"
        f" default {default} rows"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
