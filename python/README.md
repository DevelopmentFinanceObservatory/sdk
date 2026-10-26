# development-finance

Python client for the Development Finance Observatory (DFO) APIs at [developmentfinance.org](https://developmentfinance.org). Ask a question in your own words, check what DFO understood it to mean, and get a versioned table back.

```bash
pip install development-finance
```

The package imports as `dfo` and needs Python 3.12 or later. The table arrives as Arrow. Install an extra for the DataFrame library you use:

```bash
pip install "development-finance[pandas]"   # data.to_pandas()
pip install "development-finance[polars]"   # data.to_polars()
pip install "development-finance[xlsx]"     # dfo.open_bundle() on an XLSX bundle
```

Anonymous use works under a per-IP quota, so you can start without a key. [Keys and credentials](docs/keys.md) covers adding one.

## Quickstart

Ask a question. The answer leads with one sentence that names the measure, places, years, unit, and source DFO chose:

```text
Germany's gross ODA disbursements to Nigeria for basic health care, 1995 to 2024. Current US dollars · OECD Creditor Reporting System (CRS).
```

```python
import dfo

answer = dfo.search("ODA disbursements from Germany to Nigeria for basic health care")
print(answer)
```

Read that sentence before you fetch. Search is model-driven, and a wrong reading gives a plausible table for the wrong question.

Fetch the data. `fetch` builds the table on the server, downloads it, and checks the file against its digest:

```text
<Dataset Germany's gross ODA disbursements to Nigeria for basic health care, 1995 to 2024. Current US dollars · OECD Creditor Reporting System (CRS).
  Source: OECD Creditor Reporting System (CRS)
  Version: cv_b92d94774702c7f05f2075d0b03dd756
  Rows: 30
  Pinned>
```

```python
data = answer.fetch()
print(data)

df = data.to_pandas()
print(
    df[
        ["financingProvider_label", "financingRecipient_label", "time_period", "value"]
    ].head()
)
```

When a part of the question has several readings, `fetch` stops before it builds anything and says how to settle it. "government education spending Kenya" has one part with two readings of government education spending:

```python
answer = dfo.search("government education spending Kenya")
print(answer)  # lists the readings, numbered from 0

data = answer.choose(0).fetch()  # reading 0
print(data.members)  # one member, with its version
```

The choice makes one Search request, and the new answer's sentence is Search's. A question with several parts, such as "GDP of Kenya and health spending", builds one member per reading and stacks them into one long table with a `part` column. [Answers and choices](docs/answers.md) covers every shape an answer can take.

Keep the result. `data.ref` records the exact version of each reading. Save it beside your analysis, and fetching it later returns the same rows after DFO's data has moved on:

```python
from pathlib import Path

Path("education.ref.json").write_text(data.ref.to_json())

ref = dfo.DatasetRef.from_json(Path("education.ref.json").read_text())
same = dfo.fetch(ref)
assert [m.content_version for m in same.members] == [
    m.content_version for m in data.members
]
```

Store the ref, and leave the reading's index out of your notes. The order of readings can change between searches, and the ref names the version that was built.

## Scripts and services

`dfo.search` and `dfo.fetch` use a default client. A script that wants its own settings uses `dfo.Client`, which carries the same calls and closes its connections on exit:

```python
import dfo

with dfo.Client(timeout=60.0, max_retries=3) as client:
    answer = client.search("Kenya's external debt service")
    data = answer.fetch()
    print(data.rows)
```

`timeout` bounds one request attempt, 30 seconds by default, and is a finite number above 0. `max_retries` is an integer from 0 to 10. Any other value raises `InvalidRequestError` with the code `invalid_argument`. A call's own `timeout` bounds the whole call: 60 seconds for `search`, whose attempts each read until that deadline, and 1,800 for `fetch` and `result`, downloads included. `None` waits without limit. A build request reads for up to 150 seconds within it. In synchronous code, blocking platform name resolution can run past either limit; the connect, TLS handshake, reads and writes are bounded once resolution returns. The asynchronous client can cancel name resolution. `dfo.configure(...)` takes the same options and replaces the default client. `dfo.AsyncClient` has the same methods as coroutines, and its answers are `dfo.AsyncAnswer`. `base_url=` points the client at another DFO deployment.

A process forked from a threaded parent keeps the default client and the proxy settings the parent resolved. A client the child builds for itself reads the platform's proxy settings in the child, which can crash a macOS child forked from a process with running threads. Build the client in the parent, or start workers with `spawn`.

## Limits the client enforces

Both DFO clients apply these limits. The constant names are the ones in the source.

| Rule                | Value                                                                                                                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Retry-After` parse | ASCII digits (seconds) or an IMF-fixdate such as `Sun, 06 Nov 1994 08:49:37 GMT`. Any other value is ignored, and the client's own backoff applies. A date in the past means 0                                                                  |
| `Retry-After` wait  | The client waits when the value is at most 60 s (`RETRY_AFTER_MAX_S`) and fits the time left before the call's deadline. Otherwise it raises the refusal's typed error at once with `retry_after` set, and does not shorten the wait to retry   |
| Poll interval       | The server's value, or a refused poll's `Retry-After`, clamped to 1 s (`POLL_INTERVAL_MIN_S`) to 60 s (`POLL_INTERVAL_MAX_S`), then to the time left before the deadline, where the client polls once more                                      |
| Versions walk       | Pages of 100 versions, at most 20 pages (`VERSIONS_PAGE_BUDGET`). A page cursor seen before raises `contract_violation`. Over the budget, no newest version is reported                                                                         |
| Body size           | Decoded bytes are counted while the body streams, and the read stops at the limit with `response_too_large`. A file's limit is its manifest's `bytes`, else 2 GiB (`DOWNLOAD_MAX_BYTES`). A JSON body's limit is 16 MiB (`JSON_BODY_MAX_BYTES`) |
| Keys                | Visible ASCII only, 0x21 to 0x7E. The key-format check (prefix, base62, checksum) only warns                                                                                                                                                    |
| Header values       | Visible ASCII, space and tab. A control character, DEL or a non-ASCII character raises `header_invalid`                                                                                                                                         |
| `timeout`           | A finite number above 0                                                                                                                                                                                                                         |
| `max_retries`       | An integer from 0 to 10. A bool is refused                                                                                                                                                                                                      |
| Error messages      | Name the source and the position of the offending character, and leave the key or header value out                                                                                                                                              |

A key travels only to an https base URL, or to a loopback one over http: `localhost`, a name under `.localhost`, an address in 127.0.0.0/8 written as four decimal numbers, or `[::1]`. Any other plain-http base URL with a key raises `insecure_transport`. [Errors](docs/errors.md#client-codes) lists the code each rule raises.

## Differences from the TypeScript client

The two clients follow one contract and differ in these ways:

- A call's `timeout=None` waits without limit. The TypeScript client uses `Infinity`, and each client refuses the other's value with `invalid_argument`.
- Python decodes a downloaded Parquet file when `fetch` returns. TypeScript reads its footer and column types then and decodes the row values on first use. Both raise `unexpected_response` for bytes that do not read as Parquet and `contract_violation` for a file with the wrong schema.
- `ref.to_json()` writes `", "` and `": "` as separators, and TypeScript's `JSON.stringify` writes none. The content and the key order match, and each client reads the other's refs.

## Documentation

- [Answers and choices](docs/answers.md): parts, readings, `choose`, partial fetches, and declined questions.
- [Datasets and versions](docs/datasets.md): narrowing a fetch, conversions, refs, retention, `save` and `open_bundle`.
- [Long builds and operations](docs/long-builds.md): progress, deadlines, `client.mint`, and resuming a build from another process.
- [Errors](docs/errors.md): every error class and client code, by what you do next.
- [Keys and credentials](docs/keys.md): the key lookup order, `dfo auth login`, and the credentials file.
- [The cache](docs/cache.md): where downloads go, `DFO_OFFLINE`, and stale reads.

[llms.txt](llms.txt) summarises the package for language models.

## Development

The repository root holds the contract, the pre-commit configuration, and the CI workflows. See `CONTRIBUTING.md` there. From this directory:

```bash
uv sync
uv run pytest
uv run ruff check
uv run ruff format --check
uv run ty check
```
