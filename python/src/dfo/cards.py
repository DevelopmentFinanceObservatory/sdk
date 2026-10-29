"""Cards DFO stores and draws: `line`, `bar`, `table`, `stat` and `source`.

`dfo.cards.line(data, title=...)` stores a line chart of a Dataset on the
default client, as `client.cards.line(...)` does on a client you build, and
returns a `Card`. A card draws every series of the one version it is given, so
narrow the rows with `dfo.analysis.filter` first. A window may hold
`dfo.latest_year(offset)`, which DFO settles each time the card is drawn.
`dfo.share(card, latest=True)` publishes cards as a link.
"""

from dfo._client.cards import bar, line, source, stat, table

__all__ = ["bar", "line", "source", "stat", "table"]
