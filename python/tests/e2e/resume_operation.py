"""Resume a long build by its id in a fresh process, and print what it read.

    python resume_operation.py <base_url> <operation_id>

Prints one JSON object: each poll's status and the pacing the server asked for
(`retry_after_ms` in the body, `Retry-After` in the headers), each wait the client
took, and the finished dataset's spec, version, digest and rows. Step 6 of the
live journey runs it, so the resume crosses a process boundary.
"""

import json
import sys
import time

import httpx2

from dfo._sync._client import Client
from dfo._sync._fetch import Session
from dfo._sync._transport import Transport


class Recording(httpx2.BaseTransport):
    """An HTTP transport that notes every poll response it passes on."""

    def __init__(self) -> None:
        self.inner = httpx2.HTTPTransport()
        self.polls: list[dict[str, object]] = []

    def handle_request(self, request: httpx2.Request) -> httpx2.Response:
        response = self.inner.handle_request(request)
        if "/datasets/operations/" in request.url.path:
            response.read()
            operation = response.json().get("operation", {})
            self.polls.append(
                {
                    "http_status": response.status_code,
                    "status": operation.get("status"),
                    "retry_after_ms": operation.get("retry_after_ms"),
                    "retry_after": response.headers.get("retry-after"),
                }
            )
        return response

    def close(self) -> None:
        self.inner.close()


def main(base_url: str, operation_id: str) -> None:
    recording = Recording()
    waits: list[float] = []

    def sleep(seconds: float) -> None:
        waits.append(seconds)
        time.sleep(seconds)

    transport = Transport(base_url=base_url, http_transport=recording, sleep=sleep)
    with Client._over(Session(transport, None)) as client:
        data = client.operation(operation_id).result(timeout=1500.0)
    member = data.members[0]
    print(
        json.dumps(
            {
                "polls": recording.polls,
                "waits": waits,
                "rows": data.rows,
                "spec_id": member.spec.spec_id,
                "content_version": member.content_version,
                "digest": member.digest,
            }
        )
    )


if __name__ == "__main__":
    main(*sys.argv[1:])
