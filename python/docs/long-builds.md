# Long builds and operations

Most tables build while `fetch` waits on one request. A large table builds in the background on the server, as an operation, and `fetch` polls it until it is done. You need this page when a build outlasts your process, or when a pipeline should start builds and collect them later.

Each example on this page runs on its own.

## What fetch does while it waits

The server answers a build within its synchronous limits (up to 100,000 rows) with the finished manifest. A larger build becomes an operation with an `op_` id, which `fetch` polls at the pace the server asks for, backing off from 1 to 8 seconds when it names none. A build above 2,000,000 rows is refused with `over_ceiling`, an `InvalidRequestError`: narrow the spec with `window` or `entities`.

While it waits, `fetch` shows progress: a bar in a terminal, a live display in a notebook, and log records on the `dfo` logger anywhere else, naming the operation id, the trace id and the rows written. `progress=False` silences it for one call, and `DFO_PROGRESS=0` for the process.

```python
import logging

import dfo

logging.basicConfig(level=logging.INFO)

answer = dfo.search(
    "ODA disbursements from every donor to every African country for basic education, 2010 to 2023"
)
data = answer.fetch(timeout=600, progress=False)
print(data.rows)
```

## Deadlines

`timeout` bounds the whole fetch, polls and downloads included, in seconds. It defaults to 1,800 (30 minutes), and None waits without limit. When the deadline passes on a running operation, `fetch` raises `DfoTimeoutError` with the code `deadline_exceeded`, and the message names the call that resumes the build:

```text
dfo.DfoTimeoutError: The build is still running at the deadline. Resume it with client.operation("op_...").result()
```

The build keeps running on the server. Resuming it costs nothing extra: the server deduplicates builds, so fetching the same spec again joins the running operation.

## Start a build and collect it later

`client.mint(spec)` starts a build and returns an `Operation` without waiting for it:

```python
import dfo

with dfo.Client() as client:
    spec = client.search(
        "CRS commitments from France to every recipient for agriculture"
    ).specs[0]
    operation = client.mint(spec, progress=False)

    print(operation.status)  # pending, running, done or failed
    print(operation.operation_id)  # op_..., or None when the server built it at once
    data = operation.result(timeout=900)
    print(data.rows)
```

An `Operation` has:

- `operation_id`: the `op_` id to resume it by, or None for a build the server finished inline.
- `status`: `pending`, `running`, `done` or `failed`, as last read.
- `progress`: a `Progress` with `rows_written` and `estimate_rows`, or None before the server reports any.
- `done()`: polls once when the build was not done, and returns whether it is now.
- `result(timeout=1800.0)`: waits for the build and returns its dataset.

`mint` takes `layout="long"` or `layout="frame"`. It builds the spec as given; narrow a spec through `fetch` instead.

### Resume from another process

Store the operation id, and `client.operation(op_id)` picks the build up in any process. Pass the layout the build was started with:

```python
import dfo

with dfo.Client() as client:
    spec = client.search(
        "CRS commitments from France to every recipient for agriculture"
    ).specs[0]
    operation = client.mint(spec, progress=False)
    op_id = operation.operation_id

    if op_id is None:
        data = operation.result()
    else:
        # In another process, a later job, or after a DfoTimeoutError:
        data = client.operation(op_id, layout="long").result(timeout=1800)
    print(data.sentence)
```

`client.operation` raises `NotFoundError` with the code `operation_not_found` when the server holds no operation with that id. A build that failed raises the error its failure maps to.

## Retries the client makes

The client retries a failure that can clear, twice by default (`max_retries`), and waits for the response's `Retry-After` when it gives one. One layer owns build retries: every refusal of a build shares the same retries, a build the server cut off with a 504 is posted once more only, whatever that post answers, and an operation that failed retryably is resubmitted once. A 429 during a poll waits inside the deadline without spending a retry. You see an error only after these run out.

## Async

`dfo.AsyncClient` has the same calls as coroutines. `await client.mint(spec)` returns a `dfo.AsyncOperation`, whose `done()` and `result()` are awaited:

```python
import asyncio

import dfo


async def main() -> None:
    async with dfo.AsyncClient() as client:
        answer = await client.search("Kenya's external debt service")
        operation = await client.mint(answer.specs[0], progress=False)
        data = await operation.result(timeout=900)
        print(data.rows)


asyncio.run(main())
```

## Next

- [Errors](errors.md): `DfoTimeoutError` and the other classes a build can raise.
- [Datasets and versions](datasets.md): narrowing a spec so it builds within the synchronous limits.
