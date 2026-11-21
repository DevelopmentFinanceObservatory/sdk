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
   returns a link when the version is pinned, and raises `version_not_pinned`
   while it is not, since an anonymous caller cannot pin. The script then builds
   the link from the client's own path and rendering query. Any other error from
   `file_url` fails the check. The script reads the link with a plain HTTP
   client, with no key, following redirects; the response must be a Parquet file
   with the member's row count. A failure means production does not serve the
   file route anonymously.
5. A ranking of three donors' aid to three recipients in 2023: a control rank of
   the top two donors overall, then the top two donors per recipient with
   `per="destination"` and `allow_sparse_breakdowns=True`, which post
   `partition_by` and `allow_sparse_breakdowns`. The control must return rows.
   The partitioned rank must return rows for more than one recipient and more
   rows than the control. A refusal, or a server that ignores `partition_by` and
   answers the control's ranking, means production does not rank per partition.

    cd python && uv run python ../scripts/release_preflight.py [--base-url URL]

`--base-url` runs the checks against another deployment, such as the dev
website's `/api/v1` proxy, in place of production. A non-empty
`DFO_E2E_ID_TOKEN`, a Google ID token, goes out as `X-Serverless-Authorization`,
as the e2e journeys send it to a private Cloud Run URL, on the client's requests
and on the file read.

It exits 0 when every check passes, and 1 otherwise, with the reason and the class
of any error the client raised.
"""

import argparse
import os
import sys

import httpx2
import pyarrow as pa
import pyarrow.parquet as pq
from dfo import Client
from dfo._core.refs import Member
from dfo._datasets.build import file_params
from dfo._datasets.resolve import selector_path
from dfo.errors import DfoError

QUESTION = "Kenya population, 2015 to 2024"
CODES = ["DT.TDS.MLAT.CD", "DT.TDS.BLAT.CD"]
RANKED = (
    "ODA from Germany, France and the United Kingdom to Kenya, Ghana and Nigeria, "
    "2018 to 2023"
)
# The frame column the `destination` role reads in the ranked data.
RECIPIENT = "financingRecipient"
CONTROL_FAILED = (
    "preflight stopped: production could not be reached or the control question"
    " did not answer definitely"
)
KEY_REFUSED = "production does not accept party_totals"
SEARCH_REFUSED = "production does not accept structured search"
FILE_REFUSED = "production does not serve the file route anonymously"
RANK_FAILED = (
    "preflight stopped: the control rank failed, so the partitioned rank has no verdict"
)
PER_REFUSED = "production does not rank per partition"


class PreflightError(Exception):
    """A check failed. The message says what production does not do."""


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


def check_file_route(
    client: Client, member: Member, rows: int, headers: dict[str, str]
) -> None:
    """Read the member's file with no key and compare its row count. `headers`
    carries the ID token a private Cloud Run URL needs, and is empty otherwise."""
    try:
        url = httpx2.URL(client.file_url(member))
        state = "pinned, file_url returned the link"
    except DfoError as error:
        if error.code != "version_not_pinned":
            raise PreflightError(
                f"{FILE_REFUSED}: file_url raised {type(error).__name__}"
                f" {error.code}: {error}"
            ) from error
        url = httpx2.URL(
            client.base_url + selector_path(member),
            params=file_params(member.rendering),
        )
        state = "not pinned, file_url raised version_not_pinned"
    try:
        response = httpx2.get(url, headers=headers, follow_redirects=True, timeout=60)
        response.raise_for_status()
        served = pq.read_table(pa.BufferReader(response.content)).num_rows
    except (httpx2.HTTPError, OSError, ValueError) as error:
        raise PreflightError(
            f"{FILE_REFUSED}: {type(error).__name__}: {error}"
        ) from error
    if served != rows:
        raise PreflightError(
            f"{FILE_REFUSED}: the file holds {served} rows, not {rows}"
        )
    print(
        f"production serves the file route anonymously: {state}; GET {url} gave"
        f" {served} rows"
    )


def check_rank_per(client: Client) -> None:
    """Rank donors overall, then per recipient, and compare the two."""
    window = (2023, 2023)
    try:
        data = client.search(RANKED).fetch()
        control = client.analysis.rank(
            data, by="origin", window=window, how="sum", limit=2
        )
    except DfoError as error:
        raise PreflightError(
            f"{RANK_FAILED}: {type(error).__name__}: {error}"
        ) from error
    control_rows = control.to_arrow().num_rows
    if control_rows == 0:
        raise PreflightError(f"{RANK_FAILED}: the control rank returned no rows")
    try:
        per = client.analysis.rank(
            data,
            by="origin",
            per="destination",
            window=window,
            how="sum",
            limit=2,
            allow_sparse_breakdowns=True,
        )
    except DfoError as error:
        raise PreflightError(
            f"{PER_REFUSED}: {type(error).__name__}: {error}"
        ) from error
    table = per.to_arrow()
    recipients = (
        set(table.column(RECIPIENT).to_pylist())
        if RECIPIENT in table.column_names
        else set()
    )
    if len(recipients) < 2 or table.num_rows <= control_rows:
        raise PreflightError(
            f"{PER_REFUSED}: the partitioned rank returned {table.num_rows} rows for"
            f" {len(recipients)} recipients, the control {control_rows} rows"
        )
    print(
        f"production ranks per partition: control {control_rows} rows,"
        f" per destination {table.num_rows} rows for {len(recipients)} recipients"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--base-url",
        help="the API to check, such as a dev URL; the client's default otherwise",
    )
    arguments = parser.parse_args()
    token = os.environ.get("DFO_E2E_ID_TOKEN")
    headers = {"X-Serverless-Authorization": f"Bearer {token}"} if token else {}
    # api_key=False skips DFO_API_KEY and the credentials file, so the run is
    # anonymous on every machine.
    with Client(
        api_key=False, cache=False, base_url=arguments.base_url, headers=headers
    ) as client:
        try:
            member, rows = check_party_totals(client)
            check_structured_search(client)
            check_file_route(client, member, rows, headers)
            check_rank_per(client)
        except PreflightError as error:
            print(error, file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
