"""The header that carries `DFO_E2E_ID_TOKEN`, a Google ID token, to Cloud Run.

Cloud Run reads `X-Serverless-Authorization` in preference to `Authorization`, which
stays free for the client's key. An unset or empty token sends no header, as on the
workflow's `website` target and in a local run.
"""

import os


def id_token_headers() -> dict[str, str]:
    """The headers that name this run to a private Cloud Run service, if any."""
    token = os.environ.get("DFO_E2E_ID_TOKEN")
    return {"X-Serverless-Authorization": f"Bearer {token}"} if token else {}
