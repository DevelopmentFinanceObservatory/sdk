"""`id_token_headers`. Only the live run sends the header, so this pins the header's shape and the empty case the `website` target relies on."""

import pytest

from tests.e2e.cloud_run import id_token_headers


@pytest.mark.parametrize(
    ("token", "expected"),
    [
        ("", {}),
        ("signed", {"X-Serverless-Authorization": "Bearer signed"}),
    ],
)
def test_id_token_headers(
    monkeypatch: pytest.MonkeyPatch, token: str, expected: dict[str, str]
) -> None:
    monkeypatch.setenv("DFO_E2E_ID_TOKEN", token)
    assert id_token_headers() == expected
