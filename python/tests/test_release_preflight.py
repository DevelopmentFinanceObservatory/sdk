"""`scripts/release_preflight.py` sends its ID token to the API's origin only."""

import httpx2
import pyarrow as pa
import pytest
from release_preflight import (
    DONOR,
    RECIPIENT,
    PreflightError,
    check_rank_per,
    on_origin,
    request_headers,
)

import dfo

TOKEN = {"X-Serverless-Authorization": "Bearer id-token"}


def test_a_redirect_off_the_api_origin_carries_no_id_token() -> None:
    seen: list[tuple[str, str | None]] = []

    def answer(request: httpx2.Request) -> httpx2.Response:
        seen.append(
            (str(request.url), request.headers.get("X-Serverless-Authorization"))
        )
        if request.url.host == "api.example":
            return httpx2.Response(
                302, headers={"location": "https://storage.example/file?sig=1"}
            )
        return httpx2.Response(200, content=b"bytes")

    hook = on_origin(httpx2.URL("https://api.example/api"), TOKEN)
    with httpx2.Client(
        transport=httpx2.MockTransport(answer),
        headers=TOKEN,
        follow_redirects=True,
        event_hooks={"request": [hook]},
    ) as http:
        http.get("https://api.example/api/datasets/spec_a/cv_a/file")
    assert seen == [
        ("https://api.example/api/datasets/spec_a/cv_a/file", "Bearer id-token"),
        ("https://storage.example/file?sig=1", None),
    ]


def test_every_request_names_the_release_check_and_the_sdk_version() -> None:
    seen: list[str | None] = []

    def answer(request: httpx2.Request) -> httpx2.Response:
        seen.append(request.headers.get("User-Agent"))
        return httpx2.Response(200)

    expected = f"dfo-release-check/{dfo.__version__}"
    for token in (None, "id-token"):
        headers = request_headers(token)
        assert headers["User-Agent"] == expected
        with httpx2.Client(
            transport=httpx2.MockTransport(answer), headers=headers
        ) as http:
            http.get("https://api.example/api")
    assert seen == [expected, expected]


def frame(totals: dict[str, dict[str, float]]) -> pa.Table:
    """Unranked rows with the 2023 value each donor gave each recipient."""
    rows = [
        (recipient, donor, value)
        for recipient, donors in totals.items()
        for donor, value in donors.items()
    ]
    return pa.table(
        {
            RECIPIENT: [row[0] for row in rows],
            DONOR: [row[1] for row in rows],
            "time_period": ["2023"] * len(rows),
            "value": [row[2] for row in rows],
        }
    )


class Result:
    def __init__(self, table: pa.Table) -> None:
        self.table = table

    def to_arrow(self) -> pa.Table:
        return self.table


class Client:
    """A client whose control rank returns two rows and whose partitioned rank
    returns `partitioned`."""

    def __init__(self, data: pa.Table, *, partitioned: pa.Table) -> None:
        self.data = data
        self.partitioned = partitioned
        self.analysis = self

    def search(self, _question: str) -> "Client":
        return self

    def fetch(self) -> Result:
        return Result(self.data)

    def rank(self, _data: Result, **arguments: object) -> Result:
        if "per" in arguments:
            return Result(self.partitioned)
        return Result(self.data.slice(0, 2))


THREE_BY_THREE = {
    "KEN": {"DEU": 30.0, "FRA": 20.0, "GBR": 10.0},
    "GHA": {"DEU": 10.0, "FRA": 30.0, "GBR": 20.0},
    "NGA": {"DEU": 20.0, "FRA": 10.0, "GBR": 30.0},
}
TOP_TWO = {
    "KEN": {"DEU": 30.0, "FRA": 20.0},
    "GHA": {"FRA": 30.0, "GBR": 20.0},
    "NGA": {"GBR": 30.0, "DEU": 20.0},
}


def run(data: dict[str, dict[str, float]], kept: dict[str, dict[str, float]]) -> None:
    check_rank_per(Client(frame(data), partitioned=frame(kept)))  # type: ignore[arg-type]


def test_a_server_that_ignores_the_limit_fails_the_partitioned_rank_check() -> None:
    with pytest.raises(PreflightError, match="does not rank per partition"):
        run(THREE_BY_THREE, THREE_BY_THREE)


def test_a_server_that_keeps_each_recipients_top_two_passes() -> None:
    run(THREE_BY_THREE, TOP_TWO)


def test_a_tie_for_second_place_keeps_every_tied_donor() -> None:
    tied = {**THREE_BY_THREE, "KEN": {"DEU": 30.0, "FRA": 20.0, "GBR": 20.0}}
    run(tied, {**TOP_TWO, "KEN": tied["KEN"]})
    with pytest.raises(PreflightError, match="does not rank per partition"):
        run(tied, TOP_TWO)
