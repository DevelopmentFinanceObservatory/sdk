"""Search: a question in, an answer of what DFO understood out."""

from dfo._answer import SEARCH_TIMEOUT, AsyncAnswer, TransportSource, resolve
from dfo._display import search_status


async def search(
    source: TransportSource, question: str, /, *, timeout: float | None = SEARCH_TIMEOUT
) -> AsyncAnswer:
    """Ask Search a question and return what it understood, part by part.

    Args:
        source: Returns the transport to post through, read when the call runs.
        question: The question, in the user's words.
        timeout: The longest the call waits, retries included, in seconds; None
            waits as long as Search takes.

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
