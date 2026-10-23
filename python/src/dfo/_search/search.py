"""Search takes a question and returns what DFO understood."""

from dfo._core.codes import INVALID_ARGUMENT
from dfo._core.errors import client_error
from dfo._datasets.fetch import SessionSource
from dfo._search.answer import SEARCH_TIMEOUT, AsyncAnswer, resolve
from dfo._search.display import search_status


async def search(
    source: SessionSource, question: str, /, *, timeout: float | None = SEARCH_TIMEOUT
) -> AsyncAnswer:
    """Ask Search a question and return what it understood, part by part.

    Args:
        source: Returns the session to post through, read when each request runs.
        question: The question, in the user's words.
        timeout: The longest the call waits, retries included, in seconds; each
            attempt reads until then, and None waits as long as Search takes.

    Raises:
        InvalidRequestError: `question` is not text, is empty or only
            whitespace, or holds a lone surrogate, which UTF-8 cannot encode; or
            `timeout` is not None or a finite number above 0
            (`invalid_argument`). No request is sent.
        ContractError: The answer lacks a member the client acts on.
    """
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
            source,
            {"kind": "raw_text", "query": question},
            question=question,
            timeout=timeout,
        )
