"""Each public class accounts for every member of the wire type it is read from.

A member the server adds to one of these schemas fails this test until someone maps
it to an attribute or records that the class leaves it out.
"""

from dataclasses import fields

import pytest

from dfo import _types, _wire

# For each public class and the wire type it reads: every wire member, mapped to the
# attribute that carries it, or to None when the class leaves it out (the part's
# `raw` keeps it).
PART_MEMBERS: dict[str, str | None] = {
    "variable_text": "variable_text",
    "separate": "separate",
    "warnings": "warnings",
    "timing_ms": None,
    "rendered_sentence": "sentence",
    "sentence_plan": None,
    "restatement": None,
    "operations": "operations",
    "departures": "departures",
    "assumptions": "assumptions",
    "status": "status",
}
COVERAGE: list[tuple[type, type, dict[str, str | None]]] = [
    (_types.DefinitePart, _wire.DefinitePart, PART_MEMBERS | {"spec": "spec"}),
    (
        _types.CandidatesPart,
        _wire.CandidatesPart,
        PART_MEMBERS
        | {"candidates": "candidates", "reading_assumptions": "candidates"},
    ),
    (
        _types.CandidatesPart,
        _wire.CandidateSet,
        {
            "ordering": None,
            "max_candidates": None,
            "specs": "candidates",
            "truncated": "truncated",
        },
    ),
    (_types.NoDataPart, _wire.NoDataPart, PART_MEMBERS | {"no_data": "reason"}),
    (
        _types.NoDataPart,
        _wire.NoData,
        {
            "reason": "reason",
            "message": "message",
            "cause": None,
            "category": None,
            "nearest_real": None,
            "gate": None,
            "flagged_match": None,
            "alternate_match": None,
            "elected_count": None,
            "entity_terms": None,
            "ambiguous_entities": None,
            "source_terms": None,
            "ambiguous_sources": None,
            "unit_alternatives": None,
            "unbound_qualifiers": None,
            "denominator": None,
            "options": "options",
        },
    ),
    (
        _types.Option,
        _wire.NoDataOption,
        {"label": "label", "mentions": "mentions", "data_query": "data_query"},
    ),
    (
        _types.UnsupportedPart,
        _wire.UnsupportedPart,
        PART_MEMBERS | {"unsupported": "reason"},
    ),
    (
        _types.UnsupportedPart,
        _wire.Unsupported,
        {
            "code": "reason",
            "detail": "message",
            "pointer": None,
            "cause": None,
            "definition": None,
        },
    ),
    (
        _types.Spec,
        _wire.Spec,
        {"spec_id": "spec_id", "definition": "definition", "resolved": "sentence"},
    ),
    (
        _types.Candidate,
        _wire.Spec,
        {"spec_id": "spec", "definition": "spec", "resolved": "label"},
    ),
    (
        _types.Notice,
        _wire.Warning,
        {
            "code": "code",
            "severity": "severity",
            "message": "message",
            "spec_id": "spec_id",
            "params": None,
        },
    ),
    (
        _types.Notice,
        _wire.WarningModel,
        {
            "code": "code",
            "severity": "severity",
            "message": "message",
            "contributing_member_count": None,
            "stat_var_ref": None,
            "stat_var_label": None,
        },
    ),
    (
        _types.Departure,
        _wire.Departure,
        {
            "code": "code",
            "text": "text",
            "asked": "asked",
            "shown": "shown",
            "binding_ref": "binding_ref",
        },
    ),
    (
        _types.Assumption,
        _wire.Assumption,
        {"kind": "kind", "binding_ref": "binding_ref", "text": "text", "refs": "refs"},
    ),
    (
        _types.RequestedOperation,
        _wire.Operation,
        {
            "verb": "verb",
            "phrase": "phrase",
            "over": "over",
            "target_year": "target_year",
        },
    ),
    (_types.Citation, _wire.CitationModel, {"text": "text", "sources": "sources"}),
    (
        _types.CitationSource,
        _wire.CitationSource,
        {
            "ref": "ref",
            "label": "label",
            "license": "licence",
            "license_url": "licence_url",
            "url": "url",
            "processing_level": None,
            "license_type": None,
            "source": None,
            "data_commons": None,
            "documentation": None,
        },
    ),
]


@pytest.mark.parametrize(
    ("public", "wire", "members"),
    COVERAGE,
    ids=[f"{public.__name__}-{wire.__name__}" for public, wire, _ in COVERAGE],
)
def test_public_class_covers_its_wire_type(
    public: type, wire: type, members: dict[str, str | None]
) -> None:
    wire_members = wire.__required_keys__ | wire.__optional_keys__
    assert set(members) == wire_members
    attributes = {f.name for f in fields(public)}
    assert {a for a in members.values() if a is not None} <= attributes
