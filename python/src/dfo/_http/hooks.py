"""The callables a transport takes for its clock, its sleep and extra headers.

The async and sync transports take the same hooks in their own flavour, so the
async source names the `Async` alias and `scripts/gen_sync.py` swaps in the
sync one.
"""

import asyncio
import time
from collections.abc import Awaitable, Callable, Mapping

type Clock = Callable[[], float]
type Sleep = Callable[[float], None]
type AsyncSleep = Callable[[float], Awaitable[None]]
type HeaderProvider = Callable[[], Mapping[str, str]]
type AsyncHeaderProvider = Callable[[], Awaitable[Mapping[str, str]]]

monotonic: Clock = time.monotonic
sync_sleep: Sleep = time.sleep
async_sleep: AsyncSleep = asyncio.sleep
