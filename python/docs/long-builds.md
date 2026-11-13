# Wait for a large build

A table above the server's synchronous budget, 100,000 rows, builds in the background on the server, and `fetch` waits for it. It shows progress while it waits and has no deadline unless you set one. Ctrl-C, a deadline, or a cancelled task leaves the build running, and the same fetch run again joins it.

Each example on this page runs on its own. The first run of a large build on the server takes minutes. Once it is built, the same fetch returns in seconds.

## Fetch a large table

A fetch of every donor's spending on social infrastructure since 1995 builds about a million rows. In a terminal the progress line redraws in place until the build is done:

```text
Building op_72daea81df3f067b98662314f0b9d29d48750c6afd5592aeecc058a7f68bcc9c: [####################] 100% 978,349 of about 978,349 rows
<Dataset Gross ODA disbursements to 203 recipients from 105 providers for social infrastructure and services, 1995 to 2024. Current US dollars · OECD Creditor Reporting System (CRS).
  Source: OECD Creditor Reporting System (CRS)
  Version: cv_20544079b69c43123a2be8d45a26747f (exact), held until 24 November 2026, not pinned
  Rows: 978,349
  Keep: data.save(path) · newest later: dfo.fetch(data.ref, latest=True)>
```

```python
import dfo

answer = dfo.search(
    "ODA disbursements from every donor to every recipient for social infrastructure and services, 1995 to 2024"
)
spec = answer.specs[0]
data = dfo.fetch(spec)
print(data)
```

Search notes that the question named no donor and no recipient, so the answer covers every one with data, which is the reading wanted here. `answer.fetch()` repeats that note as a `SearchWarning`, and `dfo.fetch(spec)` fetches the reading without it. Both wait for the build the same way.

The progress goes to a bar on stderr in a terminal, to one live display in a notebook, and to INFO records on the `dfo` logger anywhere else, each naming the operation id, the trace id, and the rows written. `progress=False` silences it for one call, and `DFO_PROGRESS=0` for the process.

`fetch` polls at the pace the server asks for, held between 1 and 60 seconds, and backs off from 1 to 8 seconds when the server names none. With no `timeout` it waits until the server ends the build, which the server always does. Each build has a deadline on the server, and a build whose worker stops is marked failed, which `fetch` raises.

## Set a deadline

`timeout=` bounds the whole fetch in seconds, downloads included, on the call or for every call on the client. When it passes, `fetch` raises `DfoTimeoutError` with the code `deadline_exceeded`, and the build carries on:

```text
Building op_72daea81df3f067b98662314f0b9d29d48750c6afd5592aeecc058a7f68bcc9c: [--------------------] 0% 0 of about 978,349 rows
The build is still running on the server after 10 s. The same fetch joins it if one started. [deadline_exceeded]
Building op_72daea81df3f067b98662314f0b9d29d48750c6afd5592aeecc058a7f68bcc9c: [####################] 100% 978,349 of about 978,349 rows
<Dataset Gross ODA disbursements to 203 recipients from 105 providers for social infrastructure and services, 1995 to 2024. Current US dollars · OECD Creditor Reporting System (CRS).
  Source: OECD Creditor Reporting System (CRS)
  Version: cv_20544079b69c43123a2be8d45a26747f (exact), held until 24 November 2026, not pinned
  Rows: 978,349
  Keep: data.save(path) · newest later: dfo.fetch(data.ref, latest=True)>
```

```python
import dfo
from dfo.errors import DfoTimeoutError

spec = dfo.search(
    "ODA disbursements from every donor to every recipient for social infrastructure and services, 1995 to 2024"
).specs[0]
try:
    data = dfo.fetch(spec, timeout=10)
except DfoTimeoutError as error:
    print(error)
    data = dfo.fetch(spec)  # joins the build the first call started
print(data)
```

The server names a build by a hash of its request, so a second identical fetch, from this process or another, joins the running build and waits for the rest of it. A build that finished returns at once.

A fetch can run past its `timeout` by a little. When the last poll before the deadline reads the build done, the poll and each request that collects the file get one attempt of the client's `attempt_timeout`, so the call returns the data. In the synchronous client, platform name resolution can also run past the bound. The asynchronous client can cancel it.

## Stop with Ctrl-C

Ctrl-C stops the wait and leaves the build running. The `KeyboardInterrupt` carries a note saying so:

```text
  File ".../dfo/_sync/_http/transport.py", line 875, in sleep
    self._sleep(seconds)
    ~~~~~~~~~~~^^^^^^^^^^
KeyboardInterrupt
The build keeps running on the server. Run the same fetch again to join it.
```

Run the same fetch again, in the same session or a new one, and it picks up the build where it is.

## Cancel in async code

In `dfo.AsyncClient`, a cancelled fetch leaves the build running too, so `asyncio.wait_for`, `asyncio.timeout`, and a task group's cancellation are safe to use around it:

```text
Cancelled; the build keeps running.
201465
```

```python
import asyncio

import dfo

QUESTION = "ODA disbursements from every donor to every recipient for economic infrastructure and services, 1995 to 2024"


async def main() -> None:
    async with dfo.AsyncClient() as client:
        spec = (await client.search(QUESTION)).specs[0]
        try:
            data = await asyncio.wait_for(
                client.fetch(spec, progress=False), timeout=10
            )
        except TimeoutError:
            print("Cancelled; the build keeps running.")
            data = await client.fetch(spec, progress=False)
        print(len(data))


asyncio.run(main())
```

## Limits

The server sets the limits a build runs under, and lists them at `GET /datasets/capabilities`:

```text
100000 2000000
```

```python
import json

import dfo

with dfo.Client() as client:
    response = client.request("GET", "/datasets/capabilities")
caps = json.loads(response.content)["caps"]
print(caps["sync_budget_rows"], caps["async_max_rows"])
```

A build up to `sync_budget_rows` returns within its request. A larger one runs in the background, up to `async_max_rows`, and a build above that is refused with the code `over_ceiling`. Narrow the fetch with `window` or `entities`, as [Fetch and keep a dataset](datasets.md) shows.

The client's own timeouts sit underneath:

- `Client(timeout=...)` bounds every call that passes no `timeout` of its own, so `Client(timeout=300)` lets each fetch wait five minutes. None, the default, leaves `fetch` waiting for the whole build and `search` stopping after 60 seconds.
- A call's `timeout=` overrides the client's, and `timeout=None` on the call waits without a bound.
- `Client(attempt_timeout=30.0)` bounds one request attempt, and `max_retries=2` sets the further attempts after a failure that can clear. A build request reads for up to 150 seconds within the fetch's deadline.

[Settings](settings.md#timeouts) lists both options with the others.

## Next

- [The cache](cache.md) shows how a built table downloads once and later fetches read it from disk.
- [Errors](errors.md) covers `DfoTimeoutError` and the other errors a build can raise.
