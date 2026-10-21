"""Read decoded response bodies into the public data classes.

The parser reads the plain dicts `json.loads` returns. It checks the members the
client acts on through `dfo._strict.require`, which raises `ContractError` with the
JSON Pointer of the missing member, and reads
everything else tolerantly: an unknown member is ignored, an unknown enum value
passes through as a string, and a part with an unknown status becomes `UnknownPart`.
Server JSON the client posts back, such as a spec's `definition`, is kept as decoded.
"""

from collections.abc import Callable, Mapping
from typing import Any

from dfo import _strict
from dfo._error_map import CONTRACT_VIOLATION
from dfo._errors import ContractError, client_error
from dfo._strict import require
from dfo._types import (
    Assumption,
    Candidate,
    CandidatesPart,
    Citation,
    CitationSource,
    DefinitePart,
    Departure,
    NoDataPart,
    Notice,
    Option,
    RequestedOperation,
    Spec,
    UnknownPart,
    UnsupportedPart,
)

type Wire = Mapping[str, Any]

# A part as read, before an answer binds its candidates. The parts other than
# `CandidatesPart` are `Part[Never]`, so each fits an answer of either form.
type ParsedPart = (
    DefinitePart
    | CandidatesPart[Candidate]
    | NoDataPart
    | UnsupportedPart
    | UnknownPart
)


def parse_parts(resolution: Wire, /) -> tuple[ParsedPart, ...]:
    """The parts of a `resolution` answer, in query order.

    Args:
        resolution: A decoded Search response whose `kind` is `resolution`.

    Raises:
        ContractError: A member the client acts on is missing or null.
    """
    parts = require(resolution, "Resolution")["parts"]
    if not isinstance(parts, list):
        raise _violation("Resolution.parts is not an array in the response")
    return tuple(
        parse_part(part, f"/parts/{index}") for index, part in enumerate(parts)
    )


def parse_part(part: object, pointer: str = "", /) -> ParsedPart:
    """One answer part, read by its `status`.

    Args:
        part: The decoded part.
        pointer: The part's JSON Pointer in the response body.

    Raises:
        ContractError: The part is not an object, has no status, or lacks a
            member its status requires.
    """
    if not isinstance(part, Mapping):
        raise _violation(f"the part at {pointer or '/'} is not an object")
    status = part.get("status")
    if not isinstance(status, str):
        raise _violation(
            f"the part at {pointer or '/'} has no status, or one that is not a string",
            pointer=f"{pointer}/status",
        )
    reader = _PART_READERS.get(status)
    if reader is None:
        return UnknownPart(**_part_fields(part, status))
    return reader(part, pointer)


def parse_spec(spec: object, pointer: str = "", /) -> Spec:
    """A spec, with Search's sentence for it when the response carries one.

    Raises:
        ContractError: `spec_id` or `definition` is missing, null or inconsistent.
    """
    spec = require(spec, "Spec", pointer)
    definition = require(spec["definition"], "SpecDefinition", f"{pointer}/definition")
    if definition["spec_id"] != spec["spec_id"]:
        raise _violation(
            f"Spec.definition.spec_id is {definition['spec_id']}, "
            f"not the spec's {spec['spec_id']}"
        )
    resolved = _object(spec.get("resolved"))
    groups = resolved.get("entity_groups")
    return Spec(
        spec["spec_id"],
        definition,
        _optional_text(resolved.get("rendered_sentence")),
        groups if isinstance(groups, Mapping) and groups else None,
    )


def parse_candidate(
    spec: object, pointer: str = "", /, *, reading_assumptions: Wire | None = None
) -> Candidate:
    """One reading of a candidates part, from its full spec.

    The label is the sentence's heading segment, and the unit is the byline's unit
    slot, so a label, unit and source read together say what the sentence says.
    `reading_assumptions` is the part's map of each reading's assumptions by
    `spec_id`.

    Raises:
        ContractError: `spec_id` or `definition` is missing, null or inconsistent.
    """
    spec = require(spec, "Spec", pointer)
    parsed = parse_spec(spec, pointer)
    resolved = _object(spec.get("resolved"))
    tokens = [
        token
        for token in _list(resolved.get("sentence_plan"))
        if isinstance(token, Mapping)
    ]
    heading = "".join(
        _text(token.get("text"))
        for token in tokens
        if token.get("segment", "heading") == "heading"
    ).strip()
    unit = next(
        (
            token["text"]
            for token in tokens
            if token.get("segment") == "byline"
            and token.get("kind") == "slot"
            and token.get("axis") == "unit"
            and _text(token.get("text"))
        ),
        None,
    )
    provenance = _object(_object(resolved.get("facets")).get("provenance"))
    return Candidate(
        spec=parsed,
        sentence=parsed.sentence,
        label=heading or parsed.sentence,
        source=_optional_text(provenance.get("label")),
        unit=unit,
        raw=spec,
        assumptions=parse_assumptions((reading_assumptions or {}).get(parsed.spec_id)),
    )


def parse_notices(warnings: object, /) -> tuple[Notice, ...]:
    """Search's or the datasets surface's warnings, from either's warning list."""
    return tuple(
        Notice(
            code=_text(warning.get("code")),
            severity=_text(warning.get("severity")),
            message=_text(warning.get("message")),
            spec_id=_optional_text(warning.get("spec_id")),
        )
        for warning in _objects(warnings)
    )


def parse_departures(departures: object, /) -> tuple[Departure, ...]:
    """A part's departures."""
    return tuple(
        Departure(
            code=_text(departure.get("code")),
            text=_text(departure.get("text")),
            asked=_optional_text(departure.get("asked")),
            shown=_optional_text(departure.get("shown")),
            binding_ref=_optional_text(departure.get("binding_ref")),
        )
        for departure in _objects(departures)
    )


def parse_assumptions(assumptions: object, /) -> tuple[Assumption, ...]:
    """What Search assumed for a reading, from a list of the wire's assumptions."""
    return tuple(
        Assumption(
            kind=_text(assumption.get("kind")),
            binding_ref=_text(assumption.get("binding_ref")),
            text=_text(assumption.get("text")),
            refs=tuple(
                ref for ref in _list(assumption.get("refs")) if isinstance(ref, str)
            ),
        )
        for assumption in _objects(assumptions)
    )


def parse_operations(operations: object, /) -> tuple[RequestedOperation, ...]:
    """The computations a part asked for."""
    return tuple(
        RequestedOperation(
            verb=_text(operation.get("verb")),
            phrase=_text(operation.get("phrase")),
            over=_optional_text(operation.get("over")),
            target_year=target_year
            if isinstance(target_year := operation.get("target_year"), int)
            else None,
        )
        for operation in _objects(operations)
    )


def parse_citation(citation: object, /) -> Citation:
    """A manifest's citation, with each source's licence."""
    obj = _object(citation)
    return Citation(
        text=_text(obj.get("text")),
        sources=tuple(
            CitationSource(
                ref=_text(source.get("ref")),
                label=_text(source.get("label")),
                licence=_optional_text(source.get("license")),
                licence_url=_optional_text(source.get("license_url")),
                url=_optional_text(source.get("url")),
            )
            for source in _objects(obj.get("sources"))
        ),
    )


def check_manifest(manifest: object, pointer: str = "", /) -> None:
    """Check the members of a manifest that a fetch acts on.

    Args:
        manifest: The decoded manifest.
        pointer: The manifest's JSON Pointer in the response body.

    Raises:
        ContractError: The definition, its `spec_id`, the `content_version`, the
            artifact list, or an artifact's digest, rendering or URL is missing or
            null.
    """
    manifest = require(manifest, "Manifest", pointer)
    require(manifest["definition"], "DefinitionModel", f"{pointer}/definition")
    artifacts = manifest["artifacts"]
    if not isinstance(artifacts, list):
        raise _violation("Manifest.artifacts is not an array in the response")
    for index, artifact in enumerate(artifacts):
        require(artifact, "ArtifactEntryModel", f"{pointer}/artifacts/{index}")


def check_operation(resource: object, /) -> None:
    """Check the members of an operation resource that polling acts on.

    Raises:
        ContractError: The operation, its id or its status is missing or null.
    """
    resource = require(resource, "OperationResource")
    require(resource["operation"], "OperationEnvelope", "/operation")


def _violation(message: str, /, *, pointer: str | None = None) -> ContractError:
    error = client_error(CONTRACT_VIOLATION, message)
    error.pointer = pointer
    return error


def _definite(part: Wire, pointer: str) -> DefinitePart:
    spec = parse_spec(require(part, "DefinitePart", pointer)["spec"], f"{pointer}/spec")
    fields = _part_fields(part, _strict.DEFINITE_PART_STATUS)
    fields["sentence"] = spec.sentence
    return DefinitePart(spec=spec, **fields)


def _candidates(part: Wire, pointer: str) -> CandidatesPart[Candidate]:
    candidate_set = require(
        require(part, "CandidatesPart", pointer)["candidates"],
        "CandidateSet",
        f"{pointer}/candidates",
    )
    specs = candidate_set["specs"]
    if not isinstance(specs, list):
        raise _violation("CandidateSet.specs is not an array in the response")
    reading_assumptions = _object(part.get("reading_assumptions"))
    return CandidatesPart(
        candidates=tuple(
            parse_candidate(
                spec,
                f"{pointer}/candidates/specs/{index}",
                reading_assumptions=reading_assumptions,
            )
            for index, spec in enumerate(specs)
        ),
        truncated=candidate_set.get("truncated") is True,
        **_part_fields(part, _strict.CANDIDATES_PART_STATUS),
    )


def _no_data(part: Wire, pointer: str) -> NoDataPart:
    no_data = require(
        require(part, "NoDataPart", pointer)["no_data"], "NoData", f"{pointer}/no_data"
    )
    return NoDataPart(
        reason=_text(no_data["reason"]),
        message=_optional_text(no_data.get("message")),
        options=tuple(_option(option) for option in _objects(no_data.get("options"))),
        **_part_fields(part, _strict.NO_DATA_PART_STATUS),
    )


def _unsupported(part: Wire, pointer: str) -> UnsupportedPart:
    unsupported = require(
        require(part, "UnsupportedPart", pointer)["unsupported"],
        "Unsupported",
        f"{pointer}/unsupported",
    )
    return UnsupportedPart(
        reason=_text(unsupported["code"]),
        message=_optional_text(unsupported.get("detail")),
        **_part_fields(part, _strict.UNSUPPORTED_PART_STATUS),
    )


_PART_READERS: Mapping[str, Callable[[Wire, str], ParsedPart]] = {
    _strict.DEFINITE_PART_STATUS: _definite,
    _strict.CANDIDATES_PART_STATUS: _candidates,
    _strict.NO_DATA_PART_STATUS: _no_data,
    _strict.UNSUPPORTED_PART_STATUS: _unsupported,
}


def _part_fields(part: Wire, status: str) -> dict[str, Any]:
    """The members every part status shares, as `Part` keyword arguments."""
    return {
        "status": status,
        "variable_text": _optional_text(part.get("variable_text")),
        "sentence": _optional_text(part.get("rendered_sentence")),
        "separate": part.get("separate") is True,
        "warnings": parse_notices(part.get("warnings")),
        "departures": parse_departures(part.get("departures")),
        "operations": parse_operations(part.get("operations")),
        "assumptions": parse_assumptions(part.get("assumptions")),
        "raw": part,
    }


def _option(option: Wire) -> Option:
    return Option(
        label=_text(option.get("label")),
        mentions=tuple(_text(mention) for mention in _list(option.get("mentions"))),
        data_query=_object(option.get("data_query")),
    )


def _text(value: object) -> str:
    return value if isinstance(value, str) else ""


def _optional_text(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _object(value: object) -> Wire:
    return value if isinstance(value, Mapping) else {}


def _list(value: object) -> list[Any]:
    return value if isinstance(value, list) else []


def _objects(value: object) -> list[Wire]:
    return [item for item in _list(value) if isinstance(item, Mapping)]
