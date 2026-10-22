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
  Rows: 30>
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

When a part of the question has several readings, `fetch` stops before it builds anything and says how to settle it. "Germany's ODA and GNI" has two parts, and the second (index 1) has three readings of GNI:

```python
answer = dfo.search("Germany's ODA and GNI from 2015 to 2022")
print(answer)  # lists the readings, numbered from 0

data = answer.choose(1, 1).fetch()  # part 1, reading 1
print(data.members)  # one member per reading, each with its version
```

The choice makes one Search request, and the new answer's sentence is Search's. The two readings stack into one long table with a `part` column. [Answers and choices](docs/answers.md) covers every shape an answer can take.

Keep the result. `data.ref` records the exact version of each reading. Save it beside your analysis, and fetching it later returns the same rows after DFO's data has moved on:

```python
from pathlib import Path

Path("oda-gni.ref.json").write_text(data.ref.to_json())

ref = dfo.DatasetRef.from_json(Path("oda-gni.ref.json").read_text())
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

`timeout` bounds one request attempt, 30 seconds by default. A call's own `timeout` bounds the whole call: 60 seconds for `search`, whose attempts each read until that deadline, and 1,800 for `fetch` and `result`, downloads included. A build request reads for up to 150 seconds within it. In synchronous code, blocking platform name resolution can run past either limit; the connect, TLS handshake, reads and writes are bounded once resolution returns. The asynchronous client can cancel name resolution. `dfo.configure(...)` takes the same options and replaces the default client. `dfo.AsyncClient` has the same methods as coroutines, and its answers are `dfo.AsyncAnswer`. `base_url=` points the client at another DFO deployment.

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
