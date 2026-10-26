"""What Ctrl-C during a build tells the caller, in each client.

The sync client's `KeyboardInterrupt` passes through the build's call, which
notes that the build keeps running on the server. `asyncio.run` turns Ctrl-C
into a cancellation of the main task and raises `KeyboardInterrupt` outside the
coroutine, so the async client has nothing to note.
"""

from collections.abc import Generator
from contextlib import contextmanager, nullcontext

# The note a `KeyboardInterrupt` during a sync build carries.
INTERRUPT_NOTE = (
    "The build keeps running on the server. Run the same fetch again to join it."
)


def async_interrupt_note() -> nullcontext[None]:
    """Nothing to note, since no `KeyboardInterrupt` passes through a coroutine
    under `asyncio.run`."""
    return nullcontext()


@contextmanager
def sync_interrupt_note() -> Generator[None]:
    """Add `INTERRUPT_NOTE` to a `KeyboardInterrupt` raised inside the block."""
    try:
        yield
    except KeyboardInterrupt as interrupt:
        interrupt.add_note(INTERRUPT_NOTE)
        raise
