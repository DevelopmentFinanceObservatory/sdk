"""Tests for `KeyedLock` across a fork."""

import os
import subprocess
import sys
import textwrap

import pytest

FORK_INSIDE_GUARD = textwrap.dedent(
    """
    import os, signal, threading
    from dfo._http.hooks import KeyedLock

    lock = KeyedLock()
    held, release = threading.Event(), threading.Event()

    def inside_enter():
        # As a thread inside `_enter` or `_leave` holds the guard.
        with lock._guard:
            held.set()
            release.wait()

    thread = threading.Thread(target=inside_enter)
    thread.start()
    held.wait()
    pid = os.fork()
    if pid == 0:
        signal.alarm(3)  # kills the child if the hold hangs
        with lock.hold("k", timeout=1):
            pass
        os._exit(0)
    release.set()
    thread.join()
    _, status = os.waitpid(pid, 0)
    raise SystemExit(os.waitstatus_to_exitcode(status))
    """
)


@pytest.mark.skipif(not hasattr(os, "fork"), reason="needs os.fork")
def test_a_child_forked_while_a_thread_holds_the_guard_can_hold_a_key() -> None:
    # A fresh interpreter, since this one runs pyarrow's threads.
    result = subprocess.run(
        [sys.executable, "-c", FORK_INSIDE_GUARD],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
