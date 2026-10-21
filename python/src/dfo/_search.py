"""Search: a question in, an answer of what DFO understood out."""

from dfo._answer import SEARCH_TIMEOUT, AsyncAnswer, resolve
from dfo._display import search_status
from dfo._fetch import SessionSource


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
        ContractError: The answer lacks a member the client acts on.
    """
    with search_status(question):
        return await resolve(
            source,
            {"kind": "raw_text", "query": question},
            question=question,
            timeout=timeout,
        )
