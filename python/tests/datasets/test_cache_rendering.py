"""Public reference restoration preserves a usable plain offline dataset."""

import copy
import io
from pathlib import Path

import httpx2
import pyarrow.parquet as pq
import pytest

from dfo import Client, DatasetRef
from dfo._datasets.cache import Cache, sha256_digest
from dfo._datasets.dataset import in_reading_order
from dfo._sync._datasets.fetch import Session
from dfo._sync._http.transport import Transport
from dfo.types import RefMember, Rendering
from tests._datasets import PARQUET, recorded_member


def test_restoring_a_plain_ref_from_a_multi_render_snapshot_works_offline(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    member = recorded_member()
    body = copy.deepcopy(member.manifest)
    plain = next(a for a in body["artifacts"] if a["artifact_digest"] == member.digest)
    snapshot = f"/api/v1/datasets/{member.spec.spec_id}/{member.content_version}"
    plain["url"] = f"{snapshot}/files/{member.digest}"
    table = pq.read_table(PARQUET)
    output = io.BytesIO()
    pq.write_table(table.select(["value"]), output)
    projected = copy.deepcopy(plain)
    projected["artifact_digest"] = sha256_digest(output.getvalue())
    projected["rendering"]["columns"] = ["value"]
    projected["url"] = f"{snapshot}/files/{projected['artifact_digest']}"
    body["artifacts"].insert(0, projected)
    requests = []

    def serve(request: httpx2.Request) -> httpx2.Response:
        requests.append(request.url.path)
        if request.url.path == snapshot:
            return httpx2.Response(200, json=body)
        assert request.url.path == plain["url"]
        return httpx2.Response(200, content=member.data)

    cache = Cache(tmp_path, env={})
    transport = Transport(
        api_key=False,
        base_url="https://api.example/api/v1",
        http_transport=httpx2.MockTransport(serve),
    )
    ref = DatasetRef(
        (
            RefMember(
                parts=(),
                sentence=member.sentence,
                spec=member.spec,
                content_version=member.content_version,
                digest=member.digest,
                # The recorded build is a default fetch, the party-totals cut.
                rendering=Rendering("parquet", False, without_party_totals=True),
            ),
        )
    )
    ordered = in_reading_order(table, member_rows=(table.num_rows,))
    with Client._over(Session(transport, cache)) as client:
        assert client.fetch(ref, progress=False).to_arrow().equals(ordered)
    monkeypatch.setenv("DFO_OFFLINE", "1")
    with Client(
        api_key=False, base_url="https://api.example/api/v1", cache_dir=tmp_path
    ) as client:
        restored = client.fetch(member.spec, progress=False)
    assert restored.stale
    assert restored.to_arrow().equals(ordered)
    assert requests == [snapshot, plain["url"]]
