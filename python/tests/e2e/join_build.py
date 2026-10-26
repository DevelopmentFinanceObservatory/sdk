"""Fetch a spec in a fresh process, and print what its build read.

    python join_build.py <base_url> < spec.json

Reads the spec's `spec_id` and `definition` from stdin and fetches it with no
timeout. Prints one JSON object: the operation id the build's 202 answer
named, or None when it answered 200; each poll's operation id, status, the
pacing the server asked for (`retry_after_ms` in the body, `Retry-After` in the
headers) and the rows it estimated; each wait the client took; and the
dataset's spec, version, digest and rows. Step 6 of the live journey runs it, so
the fetch that joins the build crosses a process boundary.
"""

import json
import sys
import time

import httpx2

from dfo._core.types import Spec
from dfo._sync._client.client import Client
from dfo._sync._datasets.fetch import Session
from dfo._sync._http.transport import Transport


class Recording(httpx2.BaseTransport):
    """An HTTP transport that notes every build answer and poll it passes on."""

    def __init__(self) -> None:
        self.inner = httpx2.HTTPTransport()
        self.posted: str | None = None
        self.polls: list[dict[str, object]] = []

    def handle_request(self, request: httpx2.Request) -> httpx2.Response:
        response = self.inner.handle_request(request)
        path = request.url.path
        if request.method == "POST" and path.endswith("/datasets"):
            response.read()
            if response.status_code == 202:
                self.posted = response.json()["operation"]["operation_id"]
        elif "/datasets/operations/" in path:
            response.read()
            operation = response.json().get("operation", {})
            self.polls.append(
                {
                    "http_status": response.status_code,
                    "operation_id": operation.get("operation_id"),
                    "status": operation.get("status"),
                    "retry_after_ms": operation.get("retry_after_ms"),
                    "retry_after": response.headers.get("retry-after"),
                    "estimate_rows": (operation.get("progress") or {}).get(
                        "estimate_rows"
                    ),
                }
            )
        return response

    def close(self) -> None:
        self.inner.close()


def main(base_url: str) -> None:
    given = json.load(sys.stdin)
    recording = Recording()
    waits: list[float] = []

    def sleep(seconds: float) -> None:
        waits.append(seconds)
        time.sleep(seconds)

    transport = Transport(base_url=base_url, http_transport=recording, sleep=sleep)
    with Client._over(Session(transport, None)) as client:
        data = client.fetch(Spec(given["spec_id"], given["definition"]), progress=False)
    member = data.members[0]
    print(
        json.dumps(
            {
                "posted": recording.posted,
                "polls": recording.polls,
                "waits": waits,
                "rows": len(data),
                "spec_id": member.spec.spec_id,
                "content_version": member.content_version,
                "digest": member.digest,
            }
        )
    )


if __name__ == "__main__":
    main(*sys.argv[1:])
