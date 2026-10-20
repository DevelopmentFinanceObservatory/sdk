"""The progress renderer: where it writes, and what it writes."""

import io
import logging
import sys
import types
from typing import Any

import pytest

from dfo._progress import ProgressRenderer, progress_line, progress_mode


class Terminal(io.StringIO):
    def isatty(self) -> bool:
        return True


class Shell:
    kernel = object()


class Handle:
    def __init__(self, shown: list[str]) -> None:
        self.shown = shown

    def update(self, content: Any) -> None:
        self.shown.append(content.data)


@pytest.fixture
def notebook(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """An IPython kernel, faked: each displayed or updated line lands in the list."""
    shown: list[str] = []
    display = types.ModuleType("IPython.display")

    class Pretty:
        def __init__(self, data: str) -> None:
            self.data = data

    def show(content: Pretty, *, display_id: bool) -> Handle:
        assert display_id is True
        shown.append(content.data)
        return Handle(shown)

    display.Pretty = Pretty
    display.display = show
    ipython = types.ModuleType("IPython")
    ipython.get_ipython = Shell
    ipython.display = display
    monkeypatch.setitem(sys.modules, "IPython", ipython)
    monkeypatch.setitem(sys.modules, "IPython.display", display)
    return shown


@pytest.mark.parametrize(
    ("enabled", "env", "stream", "mode"),
    [
        (False, {}, Terminal(), "silent"),
        (None, {"DFO_PROGRESS": "0"}, Terminal(), "silent"),
        (True, {"DFO_PROGRESS": "0"}, Terminal(), "terminal"),
        (None, {"DFO_PROGRESS": "1"}, Terminal(), "terminal"),
        (None, {}, io.StringIO(), "log"),
    ],
)
def test_mode(
    enabled: bool | None, env: dict[str, str], stream: Any, mode: str
) -> None:
    assert progress_mode(enabled, stream=stream, env=env) == mode


def test_a_kernel_means_the_notebook(notebook: list[str]) -> None:
    assert progress_mode(None, stream=Terminal(), env={}) == "notebook"
    assert progress_mode(False, stream=Terminal(), env={}) == "silent"


def test_a_shell_without_a_kernel_is_not_a_notebook(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ipython = types.ModuleType("IPython")
    ipython.get_ipython = lambda: None
    monkeypatch.setitem(sys.modules, "IPython", ipython)
    assert progress_mode(None, stream=Terminal(), env={}) == "terminal"


@pytest.mark.parametrize(
    ("rows", "estimate", "line"),
    [
        (None, None, "Building op_1: waiting to start"),
        (1_500, None, "Building op_1: 1,500 rows"),
        (
            25_000,
            100_000,
            "Building op_1: [#####---------------] 25% 25,000 of about 100,000 rows",
        ),
        (
            150_000,
            100_000,
            "Building op_1: [####################] 100% 150,000 of about 100,000 rows",
        ),
    ],
)
def test_line(rows: int | None, estimate: int | None, line: str) -> None:
    assert progress_line("op_1", rows, estimate) == line


def test_the_terminal_redraws_one_line() -> None:
    stream = Terminal()
    with ProgressRenderer(stream=stream, env={}) as progress:
        progress.update(operation_id="op_1", rows_written=1_500)
        progress.update(operation_id="op_1", rows_written=1_500)
        progress.update(operation_id="op_1", rows_written=900)
    long, short = "Building op_1: 1,500 rows", "Building op_1: 900 rows"
    padding = " " * (len(long) - len(short))
    assert stream.getvalue() == f"\r{long}\r{short}{padding}\n"


def test_silent_writes_nothing(caplog: pytest.LogCaptureFixture) -> None:
    stream = Terminal()
    with (
        caplog.at_level(logging.DEBUG, logger="dfo"),
        ProgressRenderer(enabled=False, stream=stream, env={}) as progress,
    ):
        progress.update(operation_id="op_1", rows_written=10)
    assert stream.getvalue() == ""
    assert caplog.records == []


def test_elsewhere_the_logger_records_the_ids(caplog: pytest.LogCaptureFixture) -> None:
    stream = io.StringIO()
    with (
        caplog.at_level(logging.INFO, logger="dfo"),
        ProgressRenderer(stream=stream, env={}) as progress,
    ):
        progress.update(
            operation_id="op_1", rows_written=10, estimate_rows=40, trace_id="t-9"
        )
    assert stream.getvalue() == ""
    (record,) = caplog.records
    assert "op_1" in record.getMessage()
    assert "t-9" in record.getMessage()


def test_the_notebook_updates_one_display(notebook: list[str]) -> None:
    with ProgressRenderer(stream=Terminal(), env={}) as progress:
        assert progress.mode == "notebook"
        progress.update(operation_id="op_1", rows_written=1)
        progress.update(operation_id="op_1", rows_written=2)
    assert notebook == ["Building op_1: 1 row", "Building op_1: 2 rows"]
