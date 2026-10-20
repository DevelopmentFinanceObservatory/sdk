"""The parser over recorded dev bodies, the contract's scenarios and edited copies."""

import json
from collections.abc import Callable
from typing import Any

import pytest

from dfo import _strict
from dfo._errors import ContractError
from dfo._parse import (
    check_manifest,
    check_operation,
    parse_citation,
    parse_notices,
    parse_parts,
)
from dfo._types import (
    CandidatesPart,
    DefinitePart,
    NoDataPart,
    Part,
    UnknownPart,
    UnsupportedPart,
)

from ._data import CONTRACT, load

NARROWED_SPEC_ID = "spec_cb5baa4161de718f18583060674dbca6"


def unsupported_answer() -> dict[str, Any]:
    """The mixed answer with its no_data part replaced by an unsupported one."""
    answer = load("search-4.json")
    part = answer["parts"][1]
    del part["no_data"]
    part["status"] = "unsupported"
    part["unsupported"] = {
        "code": "unit_request_unsupported",
        "pointer": "/identity",
        "detail": "Per-capita units are not supported.",
        "definition": {},
    }
    return answer


def operation_resource() -> dict[str, Any]:
    """A pending operation resource as the build route answers a long build."""
    return {
        "operation": {
            "operation_id": "op_0123456789abcdef",
            "status": "pending",
            "poll": "/api/datasets/operations/op_0123456789abcdef",
            "retry_after_ms": 1000,
        }
    }


def test_definite_answer_reads_its_spec_and_sentence() -> None:
    answer = load("search-1.json")
    (part,) = parse_parts(answer)
    assert isinstance(part, DefinitePart)
    wire_spec = answer["parts"][0]["spec"]
    assert part.spec.spec_id == wire_spec["spec_id"]
    assert part.spec.definition is wire_spec["definition"]
    assert (
        part.sentence
        == part.spec.sentence
        == wire_spec["resolved"]["rendered_sentence"]
    )
    assert part.variable_text == "ODA disbursements for basic health care"
    assert [n.code for n in part.warnings] == ["un_system_unavailable"]
    assert part.raw is answer["parts"][0]


def test_candidates_split_each_sentence_into_label_unit_and_source() -> None:
    (part,) = parse_parts(load("search-2.json"))
    assert isinstance(part, CandidatesPart)
    assert [(c.label, c.unit, c.source) for c in part.candidates] == [
        (
            "Germany's primary income for gross of fixed capital consumption, "
            "2015 to 2022.",
            "Current US dollars",
            "OECD DAC1",
        ),
        (
            "Germany's gross national income based on purchasing power parity in "
            "international dollars, 2015 to 2022.",
            None,
            "World Development Indicators",
        ),
        (
            "Germany's gross national income based on purchasing power parity per "
            "capita in international dollars, 2015 to 2022.",
            None,
            "World Development Indicators",
        ),
    ]
    for candidate in part.candidates:
        assert candidate.sentence == candidate.spec.sentence
        assert candidate.sentence is not None
        assert candidate.label is not None
        assert candidate.sentence.startswith(candidate.label)
    assert part.truncated is False


def test_no_data_part_reads_its_reason_and_message() -> None:
    (part,) = parse_parts(load("search-3.json"))
    assert isinstance(part, NoDataPart)
    assert part.reason == "entity_ambiguous"
    assert part.message is not None
    assert part.message.startswith('"Congo" matches more than one entity')
    assert part.options == ()


def test_place_options_keep_their_data_query_untouched() -> None:
    answer = load("search-3.json")
    no_data = answer["parts"][0]["no_data"]
    data_query = no_data.pop("data_query")
    no_data["options"] = [
        {"mentions": ["Congo"], "label": "Congo [DRC]", "data_query": data_query}
    ]
    (part,) = parse_parts(answer)
    assert isinstance(part, NoDataPart)
    (option,) = part.options
    assert (option.label, option.mentions) == ("Congo [DRC]", ("Congo",))
    assert option.data_query is data_query


def test_mixed_answer_keeps_query_order() -> None:
    parts = parse_parts(load("search-4.json"))
    assert [type(part) for part in parts] == [DefinitePart, NoDataPart]
    assert [part.variable_text for part in parts] == ["debt service", "price of tea"]
    assert isinstance(parts[1], NoDataPart)
    assert parts[1].reason == "variable_not_resolved"


def test_identity_resubmit_names_the_narrowed_spec() -> None:
    (part,) = parse_parts(load("probe-resubmit-identity.json"))
    assert isinstance(part, DefinitePart)
    assert part.spec.spec_id == NARROWED_SPEC_ID
    assert part.sentence is not None
    assert "2020 to 2023" in part.sentence


def test_unsupported_part_reads_its_code_and_detail() -> None:
    parts = parse_parts(unsupported_answer())
    assert isinstance(parts[1], UnsupportedPart)
    assert (parts[1].reason, parts[1].message) == (
        "unit_request_unsupported",
        "Per-capita units are not supported.",
    )


def test_unknown_status_becomes_an_unknown_part_holding_the_raw_part() -> None:
    answer = load("search-4.json")
    answer["parts"][1]["status"] = "deferred"
    parts = parse_parts(answer)
    assert isinstance(parts[1], UnknownPart)
    assert parts[1].status == "deferred"
    assert parts[1].raw is answer["parts"][1]


def test_unknown_members_and_enum_values_pass_through() -> None:
    answer = load("search-4.json")
    answer["novel"] = {"nested": True}
    answer["parts"][0]["novel"] = [1, 2]
    answer["parts"][0]["spec"]["resolved"]["novel"] = None
    answer["parts"][1]["no_data"]["reason"] = "place_type_not_covered"
    answer["parts"][1]["warnings"][0]["severity"] = "fatal"
    parts = parse_parts(answer)
    assert isinstance(parts[1], NoDataPart)
    assert parts[1].reason == "place_type_not_covered"
    assert parts[1].warnings[0].severity == "fatal"


def test_omitted_nullable_members_read_as_absent() -> None:
    answer = load("search-2.json")
    part = answer["parts"][0]
    for key in ("rendered_sentence", "sentence_plan", "variable_text", "warnings"):
        part.pop(key, None)
    first = part["candidates"]["specs"][0]["resolved"]
    for key in ("rendered_sentence", "sentence_plan", "facets"):
        del first[key]
    (parsed,) = parse_parts(answer)
    assert isinstance(parsed, CandidatesPart)
    assert (parsed.sentence, parsed.variable_text, parsed.warnings) == (None, None, ())
    candidate = parsed.candidates[0]
    assert (candidate.sentence, candidate.label, candidate.source, candidate.unit) == (
        None,
        None,
        None,
        None,
    )


def test_parts_match_by_their_match_args() -> None:
    def describe(part: Part) -> str:
        match part:
            case DefinitePart(spec):
                return spec.spec_id
            case CandidatesPart(candidates):
                return str(len(candidates))
            case NoDataPart(reason) | UnsupportedPart(reason):
                return reason
            case UnknownPart(status, raw):
                return f"{status}:{len(raw)}"
            case _:
                return "unmatched"

    answer = load("search-4.json")
    parts = parse_parts(answer) + parse_parts(load("search-2.json"))
    answer["parts"][1]["status"] = "deferred"
    parts += parse_parts(answer)[1:] + parse_parts(unsupported_answer())[1:]
    assert [describe(part) for part in parts] == [
        answer["parts"][0]["spec"]["spec_id"],
        "variable_not_resolved",
        "3",
        f"deferred:{len(answer['parts'][1])}",
        "unit_request_unsupported",
    ]


def test_manifest_reads_its_citation_and_warnings() -> None:
    manifest = load("probe-mint-narrowed.json")
    check_manifest(manifest)
    citation = parse_citation(manifest["citation"])
    assert citation.text == manifest["citation"]["text"]
    assert [(s.ref, s.licence) for s in citation.sources] == [
        ("provenance/OECDCreditorReportingSystem", "OECD Terms and Conditions")
    ]
    assert [n.code for n in parse_notices(manifest["warnings"])] == [
        "coverage_below_scope"
    ]


def test_operation_resource_passes_its_checks() -> None:
    check_operation(operation_resource())


# Where each strict schema sits in a recorded body, and the call that reads it.
type Reader = Callable[[Any], object]
STRICT_SITES: dict[str, tuple[Callable[[], Any], tuple[str | int, ...], Reader]] = {
    "Resolution": (lambda: load("search-1.json"), (), parse_parts),
    "DefinitePart": (lambda: load("search-1.json"), ("parts", 0), parse_parts),
    "Spec": (lambda: load("search-1.json"), ("parts", 0, "spec"), parse_parts),
    "SpecDefinition": (
        lambda: load("search-1.json"),
        ("parts", 0, "spec", "definition"),
        parse_parts,
    ),
    "CandidatesPart": (lambda: load("search-2.json"), ("parts", 0), parse_parts),
    "CandidateSet": (
        lambda: load("search-2.json"),
        ("parts", 0, "candidates"),
        parse_parts,
    ),
    "NoDataPart": (lambda: load("search-3.json"), ("parts", 0), parse_parts),
    "NoData": (lambda: load("search-3.json"), ("parts", 0, "no_data"), parse_parts),
    "UnsupportedPart": (unsupported_answer, ("parts", 1), parse_parts),
    "Unsupported": (unsupported_answer, ("parts", 1, "unsupported"), parse_parts),
    "Manifest": (lambda: load("probe-mint-narrowed.json"), (), check_manifest),
    "DefinitionModel": (
        lambda: load("probe-mint-narrowed.json"),
        ("definition",),
        check_manifest,
    ),
    "ArtifactEntryModel": (
        lambda: load("probe-mint-narrowed.json"),
        ("artifacts", 0),
        check_manifest,
    ),
    "OperationResource": (operation_resource, (), check_operation),
    "OperationEnvelope": (operation_resource, ("operation",), check_operation),
}


def test_every_strict_schema_has_a_site() -> None:
    assert set(STRICT_SITES) == set(_strict.REQUIRED)


@pytest.mark.parametrize("edit", ["renamed", "null"])
@pytest.mark.parametrize(
    ("schema", "member"),
    [
        (schema, member)
        for schema, members in _strict.REQUIRED.items()
        for member in members
    ],
)
def test_a_missing_or_null_strict_member_raises(
    schema: str, member: str, edit: str
) -> None:
    make, path, reader = STRICT_SITES[schema]
    body = make()
    reader(body)  # the unedited body is the control
    target = body
    for step in path:
        target = target[step]
    value = target.pop(member)
    if edit == "renamed":
        target[f"{member}_v2"] = value
    else:
        target[member] = None
    with pytest.raises(ContractError):
        reader(body)


def test_a_part_without_status_raises() -> None:
    answer = load("search-4.json")
    del answer["parts"][1]["status"]
    with pytest.raises(ContractError):
        parse_parts(answer)


def test_a_spec_keeps_the_entity_groups_search_resolved() -> None:
    answer = load("search-1.json")
    groups = {"destination": {"text": "Sahel", "ref": "SahelRegion"}}
    answer["parts"][0]["spec"]["resolved"]["entity_groups"] = groups
    (part,) = parse_parts(answer)
    assert isinstance(part, DefinitePart)
    assert part.spec.entity_groups == groups
    assert parse_parts(load("search-1.json"))[0].spec.entity_groups is None


def test_a_spec_whose_definition_names_another_spec_raises() -> None:
    answer = load("search-1.json")
    answer["parts"][0]["spec"]["definition"]["spec_id"] = NARROWED_SPEC_ID
    with pytest.raises(ContractError):
        parse_parts(answer)


def scenario_bodies() -> list[tuple[str, str, int, Any]]:
    """Every successful JSON response body in the contract's scenarios.

    A scenario whose last call raises ends on the body the client refuses, so its
    last exchange is left out.
    """
    bodies = []
    for path in sorted((CONTRACT / "scenarios").glob("*.json")):
        record = json.loads(path.read_text())
        exchanges = record["exchanges"]
        if "error" in record["expect"][-1]:
            exchanges = exchanges[:-1]
        for exchange in exchanges:
            request, response = exchange["request"], exchange["response"]
            if "json" in response and "path" in request and response["status"] < 300:
                bodies.append(
                    (path.stem, request["path"], response["status"], response["json"])
                )
    return bodies


def test_scenarios_hold_json_bodies() -> None:
    routes = {(path, status) for _, path, status, _ in scenario_bodies()}
    assert ("/search/resolve", 200) in routes
    assert ("/datasets", 200) in routes


@pytest.mark.parametrize(
    ("name", "path", "status", "json_body"),
    scenario_bodies(),
    ids=lambda value: value if isinstance(value, str) else None,
)
def test_scenario_bodies_parse(
    name: str, path: str, status: int, json_body: Any
) -> None:
    del name
    if path == "/search/resolve":
        if json_body.get("kind", _strict.RESOLUTION_KIND) == _strict.RESOLUTION_KIND:
            assert parse_parts(json_body)
    elif path.startswith("/datasets/operations/") or (
        path == "/datasets" and status == 202
    ):
        check_operation(json_body)
    elif path.startswith("/datasets"):
        check_manifest(json_body)
    else:
        pytest.fail(f"no reader for {status} from {path}")
