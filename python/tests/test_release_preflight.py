"""`scripts/release_preflight.py` sends its ID token to the API's origin only."""

import httpx2
from release_preflight import on_origin

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
