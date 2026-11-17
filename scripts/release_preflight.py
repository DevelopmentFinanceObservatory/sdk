"""Refuse a release that production would break on a default call.

The clients post `party_totals: false` for the party totals cut a fetch makes by
default, which a server accepts only from dfo-apis 133262c5e on. They also search
by series code and link to a pinned member's file. This script runs the Python
client against the default base URL, which is production through the public proxy,
with no key:

1. A control fetch with `party_totals=True` posts no cut key, so every server
   accepts it. A failure means production could not be reached, and the release
   stops without a verdict on the key.
2. The default fetch posts `party_totals: false`. A failure means production does
   not accept the key yet.
3. A structured search by two series codes, for one destination, over 2015 to
   2023, must answer both parts definitely with no gap, and its fetch must return
   rows. A failure means production does not accept structured search.
4. The file route a `file_url` link points at. `file_url` of the control's member
   must raise `version_not_pinned` while the version is unpinned, since an
   anonymous caller cannot pin, or return a link when it happens to be pinned. The
   script then builds the link from the client's own path and rendering query and
   reads it with a plain HTTP client, with no key, following redirects; the
   response must be a Parquet file with the member's row count. A failure means
   production does not serve the file route anonymously.

    cd python && uv run python ../scripts/release_preflight.py

It exits 0 when every check passes, and 1 otherwise, with the reason and the class
of any error the client raised.
"""

import sys
from io import BytesIO

import httpx2
import pyarrow.parquet as pq
from dfo import Client
from dfo._core.refs import Member
from dfo._datasets.build import file_params
from dfo._datasets.resolve import selector_path
from dfo.errors import DfoError, InvalidRequestError

QUESTION = "Kenya population, 2015 to 2024"
CODES = ["DT.TDS.MLAT.CD", "DT.TDS.BLAT.CD"]
CONTROL_FAILED = (
    "preflight stopped: production could not be reached or the control question"
    " did not answer definitely"
)
KEY_REFUSED = "production does not accept party_totals"
SEARCH_REFUSED = "production does not accept structured search"
FILE_REFUSED = "production does not serve the file route anonymously"


class PreflightError(Exception):
    """A check failed; the message says what production does not do."""


def check_party_totals(client: Client) -> tuple[Member, int]:
    """The control's member and row count, once both fetches return rows."""
    try:
        answer = client.search(QUESTION)
        data = answer.fetch(party_totals=True)
        control = data.to_arrow().num_rows
    except DfoError as error:
        raise PreflightError(
            f"{CONTROL_FAILED}: {type(error).__name__}: {error}"
        ) from error
    if control == 0:
        raise PreflightError(f"{CONTROL_FAILED}: the control fetch returned no rows")
    member = data.members[0] if len(data.members) == 1 else None
    if not isinstance(member, Member):
        raise PreflightError(
            f"preflight stopped: the control holds {len(data.members)} members,"
            " not one stored member"
        )
    try:
        default = answer.fetch().to_arrow().num_rows
    except DfoError as error:
        raise PreflightError(
            f"{KEY_REFUSED}: {type(error).__name__}: {error}"
        ) from error
    if default == 0:
        raise PreflightError(
            "preflight stopped: the default fetch returned no rows, the control"
            f" {control}"
        )
    print(
        f"production accepts party_totals: control {control} rows,"
        f" default {default} rows"
    )
    return member, control


def check_structured_search(client: Client) -> None:
    """Search two series codes for one destination and fetch the rows."""
    try:
        answer = client.search(
            codes=CODES,
            entities={"destination": ["country/KEN"]},
            window=(2015, 2023),
        )
        definite = [part for part in answer.parts if part.status == "definite"]
        if len(definite) != len(CODES) or answer.gaps:
            raise PreflightError(
                f"{SEARCH_REFUSED}: {len(definite)} of {len(CODES)} parts definite,"
                f" {len(answer.gaps)} gaps"
            )
        rows = answer.fetch().to_arrow().num_rows
    except DfoError as error:
        raise PreflightError(
            f"{SEARCH_REFUSED}: {type(error).__name__}: {error}"
        ) from error
    if rows == 0:
        raise PreflightError(f"{SEARCH_REFUSED}: the fetch returned no rows")
    print(f"production accepts structured search: {rows} rows")


def check_file_route(client: Client, member: Member, rows: int) -> None:
    """Read the member's file with no key and compare its row count."""
    try:
        state = f"pinned, link {client.file_url(member)}"
    except InvalidRequestError as error:
        if error.code != "version_not_pinned":
            raise PreflightError(
                f"{FILE_REFUSED}: file_url raised {type(error).__name__}"
                f" {error.code}: {error}"
            ) from error
        state = "not pinned, file_url raised version_not_pinned"
    url = httpx2.URL(
        client.base_url + selector_path(member),
        params=file_params(member.rendering),
    )
    try:
        response = httpx2.get(url, follow_redirects=True, timeout=60)
        response.raise_for_status()
        served = pq.read_table(BytesIO(response.content)).num_rows
    except (httpx2.HTTPError, OSError, ValueError) as error:
        raise PreflightError(
            f"{FILE_REFUSED}: {type(error).__name__}: {error}"
        ) from error
    if served != rows:
        raise PreflightError(
            f"{FILE_REFUSED}: the file holds {served} rows, not {rows}"
        )
    print(f"production serves the file route anonymously: {state}; GET {served} rows")


def main() -> int:
    # api_key=False skips DFO_API_KEY and the credentials file, so the run is
    # anonymous on every machine.
    with Client(api_key=False, cache=False) as client:
        try:
            member, rows = check_party_totals(client)
            check_structured_search(client)
            check_file_route(client, member, rows)
        except PreflightError as error:
            print(error, file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
