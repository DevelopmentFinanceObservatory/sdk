"""Search takes a question, or publisher series codes, and returns what DFO
understood."""

from collections.abc import Sequence

from dfo._core.codes import INVALID_ARGUMENT
from dfo._core.errors import client_error
from dfo._core.timeouts import CLIENT_TIMEOUT, CallTimeout
from dfo._core.types import Window
from dfo._datasets.build import Entities
from dfo._datasets.fetch import SessionSource
from dfo._search.answer import AsyncAnswer, resolve
from dfo._search.display import search_status
from dfo._search.structured import parsed_input


async def search(
    session_source: SessionSource,
    question: str | None = None,
    /,
    *,
    codes: Sequence[str] | None = None,
    variable: str | None = None,
    entities: Entities | None = None,
    window: Window | None = None,
    open_roles: Sequence[str] | None = None,
    source: str | None = None,
    timeout: CallTimeout = CLIENT_TIMEOUT,
) -> AsyncAnswer:
    """Ask Search a question, or for publisher series codes, and return what it
    understood, part by part.

    A search by codes posts one part per code, which Search answers on its own
    from the code's series; `variable`, `entities`, `window`, `open_roles` and
    `source` apply to every code. A definite part whose reading is not its
    code's series alone is a gap.

    Args:
        session_source: Returns the session to post through, read when each
            request runs.
        question: The question, in the user's words.
        codes: Publisher series codes, such as `["DT.TDS.DEGG.CD"]`.
        variable: Words that choose among a code's variables; each code by
            default.
        entities: Role keys bound to dcids or to what `lookup.resolve` returns,
            as `fetch` takes them.
        window: `"all"`, `"latest"` or `(start_year, end_year)`, as `fetch`
            takes it.
        open_roles: Flow role keys, `origin` or `destination`, to answer member
            by member.
        source: The source to read the codes from, in words, such as `"IDS"`.
        timeout: The longest the call waits, retries included, in seconds; each
            attempt reads until then, and None waits as long as Search takes.
            `CLIENT_TIMEOUT` takes the client's `timeout`, else `SEARCH_TIMEOUT`.

    Raises:
        InvalidRequestError: `question` is not text, is empty or only
            whitespace, or holds a lone surrogate, which UTF-8 cannot encode; a
            question comes with a keyword of a search by codes, or such a
            keyword comes without `codes`; a keyword breaks its rule; or
            `timeout` is not None or a finite number above 0
            (`invalid_argument`). No request is sent.
        ContractError: The answer lacks a member the client acts on; or a search
            by codes is answered with another number of parts than codes, or
            Search could not read the years sent (`contract_violation`).
    """
    structured = {
        "codes": codes,
        "variable": variable,
        "entities": entities,
        "window": window,
        "open_roles": open_roles,
        "source": source,
    }
    given = [name for name, value in structured.items() if value is not None]
    if isinstance(question, list | tuple):
        raise client_error(
            INVALID_ARGUMENT,
            "search reads a positional argument as a question in words; pass "
            "series codes by keyword: search(codes=[...])",
        )
    if question is not None and given:
        raise client_error(
            INVALID_ARGUMENT,
            f"search takes a question in words or series codes, not both; Search "
            f"does not read a question beside {_listed(given)}. Name the places "
            "and years in the keywords: search(codes=[...], entities=..., "
            "window=...)",
        )
    if given:
        if codes is None:
            verb = "qualifies" if len(given) == 1 else "qualify"
            raise client_error(
                INVALID_ARGUMENT,
                f"{_listed(given)} {verb} the series codes a search asks for; "
                "pass codes=[...], or ask a question in words",
            )
        request = parsed_input(
            codes,
            variable=variable,
            entities=entities,
            window=window,
            open_roles=open_roles,
            source=source,
        )
        asked = [part["source_code"] for part in request["parts"]]
        with search_status(", ".join(asked)):
            return await resolve(
                session_source, request, question=None, timeout=timeout, codes=asked
            )
    if question is None:
        raise client_error(
            INVALID_ARGUMENT,
            "search takes a question in words, or series codes: search(codes=[...])",
        )
    if not isinstance(question, str) or not question.strip():
        raise client_error(
            INVALID_ARGUMENT, f"question is the text to search for, not {question!r}"
        )
    try:
        question.encode()
    except UnicodeEncodeError as error:
        raise client_error(
            INVALID_ARGUMENT,
            f"question holds the lone surrogate {question[error.start]!r} at "
            f"position {error.start}, which UTF-8 cannot encode",
        ) from error
    with search_status(question):
        return await resolve(
            session_source,
            {"kind": "raw_text", "query": question},
            question=question,
            timeout=timeout,
        )


def _listed(names: Sequence[str]) -> str:
    """Names as a sentence lists them: `a`, `a and b`, `a, b and c`."""
    if len(names) == 1:
        return names[0]
    return f"{', '.join(names[:-1])} and {names[-1]}"
