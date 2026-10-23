"""Show a long build's progress as a line in a terminal or a display in a notebook.

In a terminal the line redraws in place with `\\r`. In IPython it updates one
display. Anywhere else the `dfo` logger records the operation id, the trace id
and the rows written. `progress=False`, or `DFO_PROGRESS=0` when the argument is
not given, silences all three.

Both clients call this module. It is sync and does no network I/O.
"""

import importlib
import logging
import os
import sys
from collections.abc import Mapping
from typing import Any, Literal, Self, TextIO

logger = logging.getLogger("dfo")

type Mode = Literal["silent", "terminal", "notebook", "log"]

_BAR_WIDTH = 20


def progress_mode(
    enabled: bool | None,
    *,
    stream: TextIO,
    env: Mapping[str, str] | None = None,
) -> Mode:
    """Where progress goes. The argument wins, then `DFO_PROGRESS`, then the context."""
    env = os.environ if env is None else env
    if enabled is False or (enabled is None and env.get("DFO_PROGRESS") == "0"):
        return "silent"
    if _in_notebook():
        return "notebook"
    if stream.isatty():
        return "terminal"
    return "log"


def progress_line(
    operation_id: str, rows_written: int | None, estimate_rows: int | None
) -> str:
    """The progress of one operation as one line of text."""
    if rows_written is None:
        return f"Building {operation_id}: waiting to start"
    if not estimate_rows:
        noun = "row" if rows_written == 1 else "rows"
        return f"Building {operation_id}: {rows_written:,} {noun}"
    share = min(rows_written / estimate_rows, 1.0)
    filled = round(share * _BAR_WIDTH)
    bar = "#" * filled + "-" * (_BAR_WIDTH - filled)
    return (
        f"Building {operation_id}: [{bar}] {share:.0%} "
        f"{rows_written:,} of about {estimate_rows:,} rows"
    )


class ProgressRenderer:
    """Renders one operation's progress until closed. It is a context manager.

    Args:
        enabled: True shows progress, False silences it, and None follows
            `DFO_PROGRESS`.
        stream: The terminal stream, `sys.stderr` by default.
        env: The environment, this process's by default.
    """

    __slots__ = ("_display", "_last", "_mode", "_stream", "_width")

    def __init__(
        self,
        *,
        enabled: bool | None = None,
        stream: TextIO | None = None,
        env: Mapping[str, str] | None = None,
    ) -> None:
        self._stream = sys.stderr if stream is None else stream
        self._mode: Mode = progress_mode(enabled, stream=self._stream, env=env)
        self._display: Any = None
        self._last: str | None = None
        self._width = 0

    @property
    def mode(self) -> Mode:
        """Where this renderer sends progress."""
        return self._mode

    def update(
        self,
        *,
        operation_id: str,
        rows_written: int | None = None,
        estimate_rows: int | None = None,
        trace_id: str | None = None,
    ) -> None:
        """Show the operation's latest progress, or nothing when it repeats the last."""
        line = progress_line(operation_id, rows_written, estimate_rows)
        if self._mode == "silent" or line == self._last:
            return
        self._last = line
        if self._mode == "terminal":
            padding = " " * max(self._width - len(line), 0)
            self._stream.write(f"\r{line}{padding}")
            self._stream.flush()
            self._width = len(line)
        elif self._mode == "notebook":
            self._show(line)
        else:
            logger.info(
                "operation %s, trace %s: %s rows written of an estimated %s",
                operation_id,
                trace_id,
                rows_written,
                estimate_rows,
            )

    def close(self) -> None:
        """End the terminal line, if one was drawn."""
        if self._mode == "terminal" and self._width:
            self._stream.write("\n")
            self._stream.flush()
            self._width = 0

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def _show(self, line: str) -> None:
        # IPython is loaded whenever the mode is "notebook", and is not a dependency.
        ipython_display = importlib.import_module("IPython.display")
        content = ipython_display.Pretty(line)
        if self._display is None:
            self._display = ipython_display.display(content, display_id=True)
        else:
            self._display.update(content)


def _in_notebook() -> bool:
    """Whether this process runs under an IPython kernel, without importing IPython."""
    ipython = sys.modules.get("IPython")
    get_ipython = getattr(ipython, "get_ipython", None)
    shell = get_ipython() if callable(get_ipython) else None
    return shell is not None and getattr(shell, "kernel", None) is not None
