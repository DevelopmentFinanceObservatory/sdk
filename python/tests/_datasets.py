"""Fetched members built from the contract's recorded fetch, for the dataset tests."""

import copy
import io
import json
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq

from dfo._cache import sha256_digest
from dfo._dataset import FetchedMember
from dfo._types import Spec

from ._data import CONTRACT

SCENARIO = CONTRACT / "scenarios" / "fetch-spec-known-sentence.json"
PARQUET = CONTRACT / "scenarios" / "fetch-spec-known-sentence.parquet"


def scenario() -> dict[str, Any]:
    """The recorded fetch, decoded afresh."""
    return json.loads(SCENARIO.read_text())


def manifest() -> dict[str, Any]:
    """The recorded build's manifest, decoded afresh."""
    return scenario()["exchanges"][0]["response"]["json"]


def recorded_member(**changes: Any) -> FetchedMember:
    """The recorded build as a fetched member, with any field replaced."""
    call = scenario()["call"][0]
    body = manifest()
    data = PARQUET.read_bytes()
    fields: dict[str, Any] = {
        "parts": (),
        "spec": Spec(
            call["spec"]["spec_id"],
            call["spec"]["definition"],
            call["spec"]["sentence"],
        ),
        "sentence": call["spec"]["sentence"],
        "content_version": body["content_version"],
        "manifest": body,
        "digest": sha256_digest(data),
        "data": data,
    }
    fields.update(changes)
    return FetchedMember(**fields)


def other_member(**changes: Any) -> FetchedMember:
    """A second member with another spec, version and column set than the recorded one.

    Its table drops the provider columns and adds `observationAbout`, so stacking
    it with the recorded member exercises the column union.
    """
    table = pq.read_table(PARQUET).replace_schema_metadata(None)
    table = table.drop_columns(
        ["financingProvider", "financingProvider_label", "financingProvider_party_kind"]
    )
    table = table.append_column(
        "observationAbout", pa.array(["country/KEN"] * table.num_rows)
    )
    sink = io.BytesIO()
    pq.write_table(table, sink)
    data = sink.getvalue()
    digest = sha256_digest(data)
    spec_id = "spec_" + "1" * 32
    body = copy.deepcopy(manifest())
    body["definition"]["spec_id"] = spec_id
    body["content_version"] = "cv_" + "2" * 32
    body["artifacts"][0]["artifact_digest"] = digest
    body["citation"] = {
        "text": "World Development Indicators (2026), via the Development Finance Observatory",
        "sources": [
            {
                "ref": "provenance/WorldDevelopmentIndicators",
                "label": "World Development Indicators",
                "license": "CC BY 4.0",
            }
        ],
    }
    body["warnings"] = []
    fields: dict[str, Any] = {
        "parts": ("GDP",),
        "spec": Spec(spec_id, body["definition"]),
        "sentence": "GDP in Kenya, 2020 to 2023. Current US dollars · World Development Indicators.",
        "content_version": body["content_version"],
        "manifest": body,
        "digest": digest,
        "data": data,
    }
    fields.update(changes)
    return FetchedMember(**fields)
