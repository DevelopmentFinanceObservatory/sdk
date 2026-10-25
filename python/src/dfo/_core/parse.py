"""Read decoded response bodies into the public data classes.

The parser reads the plain dicts `json.loads` returns. It checks the members the
client acts on, as `dfo._generated.strict` lists them, through `require`, which
raises `ContractError` with the JSON Pointer of a member that is missing, null or
of another JSON type, and reads everything else tolerantly: an unknown member is
ignored, a member of another JSON type reads as absent, an unknown enum value
passes through as a string, and a part with an unknown status becomes
`UnknownPart`. Server JSON the client posts back, such as a spec's `definition`,
is kept as decoded.
"""

from collections.abc import Callable, Iterable, Mapping
from typing import Any, Final

from dfo._core.codes import CONTRACT_VIOLATION
from dfo._core.errors import ContractError, client_error
from dfo._core.types import (
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
    Wire,
    is_integer,
)
from dfo._generated import strict as _strict
from dfo._generated.strict import REQUIRED, JsonType, StrictSchema

# A part as read, before an answer binds its candidates. The parts other than
# `CandidatesPart` are `Part[Never]`, so each fits an answer of either form.
type ParsedPart = (
    DefinitePart
    | CandidatesPart[Candidate]
    | NoDataPart
    | UnsupportedPart
    | UnknownPart
)


# Whether a decoded JSON value has each type.
_IS_TYPE: Final[Mapping[JsonType, Callable[[object], bool]]] = {
    "string": lambda value: isinstance(value, str),
    "integer": is_integer,
    "array": lambda value: isinstance(value, list),
    "object": lambda value: isinstance(value, Mapping),
}


def require(
    obj: object, schema: StrictSchema, pointer: str = "", /
) -> Mapping[str, Any]:
    """Return `obj` when it is an object carrying `schema`'s required members.

    Args:
        obj: A value decoded from a response body.
        schema: The component schema `obj` is read as.
        pointer: The JSON Pointer of `obj` in the response body.

    Returns:
        `obj`, typed as an object.

    Raises:
        ContractError: `obj` is not an object, or a required member is missing,
            null or of another JSON type; the error's `pointer` names `obj` or
            that member.
    """
    return require_members(obj, schema, REQUIRED[schema], pointer)


def require_members(
    obj: object,
    schema: str,
    members: Iterable[tuple[str, JsonType]],
    pointer: str = "",
    /,
) -> Mapping[str, Any]:
    """Return `obj` when it is an object carrying each of `members` as its JSON type.

    `require` checks a schema that `dfo._generated.strict` lists. A lookup names
    the members of the schema its response has.

    Raises:
        ContractError: As `require` does.
    """
    if not isinstance(obj, Mapping):
        raise violation(
            f"{schema} at {pointer or '/'} is not an object in the response",
            pointer=pointer,
        )
    for member, json_type in members:
        value = obj.get(member)
        if value is None:
            raise violation(
                f"{schema}.{member} is missing or null at {pointer}/{member} in "
                "the response; upgrade development-finance",
                pointer=f"{pointer}/{member}",
            )
        if not _IS_TYPE[json_type](value):
            raise violation(
                f"{schema}.{member} is not an {json_type} at {pointer}/{member} "
                "in the response; upgrade development-finance",
                pointer=f"{pointer}/{member}",
            )
    return obj


def parse_parts(resolution: Wire, /) -> tuple[ParsedPart, ...]:
    """The parts of a `resolution` answer, in query order.

    Args:
        resolution: A decoded Search response whose `kind` is `resolution`.

    Raises:
        ContractError: A member the client acts on is missing, null or of another
            JSON type, or the answer has no parts.
    """
    parts = require(resolution, "Resolution")["parts"]
    if not parts:
        raise violation("Resolution.parts is empty in the response", pointer="/parts")
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
        raise violation(
            f"the part at {pointer or '/'} is not an object", pointer=pointer
        )
    status = part.get("status")
    if not isinstance(status, str):
        raise violation(
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
        ContractError: `spec_id`, `definition`, `resolved` or `definition.identity`
            is missing, null or of another JSON type, or `definition.spec_id` is
            not the spec's `spec_id`.
    """
    spec = require(spec, "Spec", pointer)
    definition = require(spec["definition"], "SpecDefinition", f"{pointer}/definition")
    if definition["spec_id"] != spec["spec_id"]:
        raise violation(
            f"Spec.definition.spec_id is {definition['spec_id']}, "
            f"not the spec's {spec['spec_id']}",
            pointer=f"{pointer}/definition/spec_id",
        )
    resolved = spec["resolved"]
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
        ContractError: `spec_id`, `definition`, `resolved` or `definition.identity`
            is missing, null or of another JSON type, or `definition.spec_id` is
            not the spec's `spec_id`.
    """
    spec = require(spec, "Spec", pointer)
    parsed = parse_spec(spec, pointer)
    resolved = spec["resolved"]
    tokens = [
        token
        for token in _list(resolved.get("sentence_plan"))
        if isinstance(token, Mapping)
    ]
    heading = "".join(
        _text(token.get("text")) for token in tokens if _segment(token) == "heading"
    ).strip()
    unit = next(
        (
            token["text"]
            for token in tokens
            if _segment(token) == "byline"
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
        label=heading or parsed.sentence or None,
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
            kind=read["kind"],
            binding_ref=read["binding_ref"],
            text=read["text"],
            refs=tuple(read.get("refs", ())),
        )
        for read in read_items(assumptions, read_assumption)
    )


def parse_operations(operations: object, /) -> tuple[RequestedOperation, ...]:
    """The computations a part asked for."""
    return tuple(
        RequestedOperation(
            verb=read["verb"],
            phrase=read["phrase"],
            over=read.get("over"),
            target_year=read.get("target_year"),
        )
        for read in read_items(operations, read_requested_operation)
    )


def read_assumption(item: object, /) -> dict[str, Any] | None:
    """An `Assumption` item as the client reads it, or None when it does not read.

    The item reads when it is an object whose `kind`, `binding_ref` and `text` are
    strings. The read form holds those members, and `refs` as its string items when
    the item holds `refs` as a list. A resubmit posts this form back.
    """
    if (
        not isinstance(item, Mapping)
        or (read := _required_strings(item, "kind", "binding_ref", "text")) is None
    ):
        return None
    if isinstance(refs := item.get("refs"), list):
        read["refs"] = [ref for ref in refs if isinstance(ref, str)]
    return read


def read_requested_operation(item: object, /) -> dict[str, Any] | None:
    """An `Operation` item as the client reads it, or None when it does not read.

    The item reads when it is an object whose `verb` and `phrase` are strings. The
    read form holds those members, `over` when the item holds it as a string or
    null, and `target_year` when the item holds it as null or as a number other
    than a boolean with no fractional part, read as that integer, so `2020.0`
    reads as `2020`. A resubmit posts this form back.
    """
    if (
        not isinstance(item, Mapping)
        or (read := _required_strings(item, "verb", "phrase")) is None
    ):
        return None
    if "over" in item and ((over := item["over"]) is None or isinstance(over, str)):
        read["over"] = over
    if "target_year" in item:
        year = item["target_year"]
        if year is None or is_integer(year):
            read["target_year"] = None if year is None else int(year)
    return read


def read_items(
    value: object, read: Callable[[object], dict[str, Any] | None], /
) -> list[dict[str, Any]]:
    """The read forms of a wire list's items that `read` reads, in order; none when
    the value is not a list."""
    return [found for item in _list(value) if (found := read(item)) is not None]


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
        ContractError: The definition, its `spec_id`, its `identity`, the
            `content_version`, the artifact list, or an artifact's digest,
            rendering or URL is missing, null or of another JSON type.
    """
    manifest = require(manifest, "Manifest", pointer)
    require(manifest["definition"], "DefinitionModel", f"{pointer}/definition")
    for index, artifact in enumerate(manifest["artifacts"]):
        require(artifact, "ArtifactEntryModel", f"{pointer}/artifacts/{index}")


def check_operation(resource: object, /) -> None:
    """Check the members of an operation resource that polling acts on.

    Raises:
        ContractError: The operation, its id or its status is missing or null.
    """
    resource = require(resource, "OperationResource")
    require(resource["operation"], "OperationEnvelope", "/operation")


def violation(message: str, /, *, pointer: str | None = None) -> ContractError:
    """A `contract_violation` error, naming the member at fault by `pointer`."""
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
        mentions=tuple(
            mention
            for mention in _list(option.get("mentions"))
            if isinstance(mention, str)
        ),
        data_query=_object(option.get("data_query")),
        entity_choice=_optional_index(option.get("entity_choice")),
    )


def _segment(token: Wire) -> str:
    """A sentence-plan token's segment, or the heading when it is missing or not a
    string."""
    segment = token.get("segment")
    return segment if isinstance(segment, str) else "heading"


def _text(value: object) -> str:
    return value if isinstance(value, str) else ""


def _optional_text(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _optional_index(value: object) -> int | None:
    """A non-negative JSON integer as an int, or None for any other value."""
    if isinstance(value, int | float) and is_integer(value) and value >= 0:
        return int(value)
    return None


def _object(value: object) -> Wire:
    return value if isinstance(value, Mapping) else {}


def _list(value: object) -> list[Any]:
    return value if isinstance(value, list) else []


def _objects(value: object) -> list[Wire]:
    return [item for item in _list(value) if isinstance(item, Mapping)]


def _required_strings(item: Wire, *names: str) -> dict[str, Any] | None:
    """`item`'s members `names`, or None when one is not a string."""
    if not all(isinstance(item.get(name), str) for name in names):
        return None
    return {name: item[name] for name in names}
