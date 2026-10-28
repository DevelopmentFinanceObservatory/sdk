# development-finance

Ask the Development Finance Observatory (DFO) a question about aid, debt, or development indicators in your own words, and get a versioned table back.

```bash
pip install "development-finance[pandas]"
```

```python
import dfo

answer = dfo.search("ODA from Germany to Nigeria")
print(answer)
data = answer.fetch()
df = data.to_pandas()

growth = dfo.analysis.growth(data, window=(2015, 2024))
share = dfo.share(dfo.cards.line(data, title="German ODA to Nigeria"), latest=True)
print(share.url)
```

```text
Germany's gross disbursements to Nigeria for official development assistance, 1960 to 2024. Current US dollars · OECD DAC2a.
  Fetch: answer.fetch()
https://developmentfinance.org/s/k3Qx8vTa
```

`dfo.analysis.growth` computes the change from 2015 to 2024 on DFO, as a fraction where 0.25 is a 25% rise. `dfo.share` publishes a line chart of the data at a public URL that anyone with the link can open, and follows new data.

The package imports as `dfo` and needs Python 3.12 or later. It works without a key, under a per-IP quota. The table arrives as Arrow. The `pandas` extra adds `to_pandas()`, `polars` adds `to_polars()`, and `xlsx` lets `dfo.load` open an XLSX bundle from the website.

The code blocks on this page run in order, as cells of one notebook.

## Ask a question and read the answer

`dfo.search` returns an `Answer`, which says what DFO understood and holds no data yet. Printing it shows Search's sentence, naming the measure, places, years, unit, and source, and the line to type next. Read the sentence before you fetch. Search is model-driven, and a wrong reading gives a plausible table for the wrong question.

`answer.fetch()` builds the table on the server, downloads it, and checks the file against its digest. Printing the dataset shows what it is, how big, and how to keep it:

```text
<Dataset Germany's gross disbursements to Nigeria for official development assistance, 1960 to 2024. Current US dollars · OECD DAC2a.
  Source: OECD DAC2A
  Version: cv_1145ade0abb33920fefaf5daaeb8f3a9 (exact), held until 24 November 2026, not pinned
  Rows: 65
  Keep: data.save(path) · newest later: dfo.fetch(data.ref, latest=True)>
    time_period financingProvider_label financingRecipient_label        value
60         2020                 Germany                  Nigeria  123608639.0
61         2021                 Germany                  Nigeria  164254178.0
62         2022                 Germany                  Nigeria  122707200.0
63         2023                 Germany                  Nigeria  126863832.0
64         2024                 Germany                  Nigeria  100707102.0
```

```python
import dfo

answer = dfo.search("ODA from Germany to Nigeria")
data = answer.fetch()
print(data)

df = data.to_pandas()
print(df.iloc[:, :4].tail())
```

The `_label` columns of names come first, covering the year, the parties, the value, and its unit. The other columns follow, codes included, with those that tell the rows apart before those that hold one value throughout, and `stat_var` last. The years of each series read in order. `len(data)` is the row count, `data.to_polars()` gives a polars frame, and `pyarrow.table(data)` gives an Arrow table. While a build runs on the server, `fetch` shows its progress in a terminal or notebook. [Long builds](docs/long-builds.md) covers waiting, timeouts, and Ctrl-C.

## Choose a reading

Some questions have more than one reading. "government education spending Kenya" can mean a share of the budget or a share of GDP, and the answer lists both with the line that settles it:

```text
Answered 0 of 1 part of your question.
  missing  "government education spending": 2 readings
    [0] Kenya's percent of total government expenditure on education, 1980 to 2025 · World Development Indicators
    [1] Kenya's percent of nominal GDP spent on education, 1971 to 2024 · World Development Indicators
  Choose: answer.choose(0).fetch()
Kenya's percent of total government expenditure on education, 1980 to 2025. World Development Indicators.
```

```python
answer = dfo.search("government education spending Kenya")
print(answer)

data = answer.choose(0).fetch()
print(data.sentence)
```

`choose` takes the option's index or its full label, and makes one Search request. The new answer and its sentence are Search's. The order of readings can change between searches, so a script that runs again later keeps `data.ref` and fetches that. A place that matches several countries, such as "Congo", is settled the same way, with `answer.choose("Congo [DRC]")`. [Answers and choices](docs/answers.md) covers questions with several parts and answers that leave a part out.

## Fetch other years or places

The simplest way is to put the years and places in the question:

```text
Germany's gross disbursements to Ghana and Kenya for official development assistance, 2015 to 2022. Current US dollars · OECD DAC2a.
  Fetch: answer.fetch()
```

```python
answer = dfo.search("ODA from Germany to Kenya and Ghana, 2015 to 2022")
print(answer)
```

To vary a reading you already have without a new search, pass its spec to `dfo.fetch` with `window` and `entities`. `window` takes `(start_year, end_year)` with years from 1000 to 2200, `"latest"`, or `"all"`. `entities` maps each role the spec names to place codes, keyed `place` for the place a measure is about and `origin` and `destination` for a flow, and `spec.roles` lists those roles with the places each binds, or None for a role left open. `answer.fetch` takes the same arguments and narrows every reading in the answer:

```text
<Dataset Germany's gross disbursements to Ghana and Kenya for official development assistance, 2015 to 2022. Current US dollars · OECD DAC2a.
  Source: OECD DAC2A
  Version: cv_6cdec57990a5712642ad97ab58d9ea21 (exact), held until 24 November 2026, not pinned
  Rows: 16
  Keep: data.save(path) · newest later: dfo.fetch(data.ref, latest=True)>
```

```python
spec = dfo.search("ODA from Germany to Nigeria").specs[0]
print(spec.roles)
# {'destination': ('country/NGA',), 'origin': ('country/DEU',)}

data = dfo.fetch(
    spec,
    window=(2015, 2022),
    entities={"destination": ["country/KEN", "country/GHA"]},
)
print(data)
```

[Look up a place code](#look-up-a-place-code) finds the code for a name. [Datasets and versions](docs/datasets.md) covers `facets` and the frame layout.

## Keep group and total rows

A table of flows leaves out the rows for groups and totals, such as "DAC countries" or "official donors (DAC)", so a sum over it counts each donor once. Pass `party_totals=True` to keep them. For ODA to Ethiopia in 2022, the default table has 95 rows, one per donor, and the full one has 110:

```python
answer = dfo.search("ODA to Ethiopia in 2022 by donor")
by_donor = answer.fetch()
with_totals = answer.fetch(party_totals=True)

print(len(by_donor), len(with_totals))  # 95 110
print(with_totals.to_pandas()["financingProvider_kind"].value_counts())
```

```text
financingProvider_kind
official       72
private        23
total          13
whole total     2
Name: count, dtype: int64
```

`financingProvider_kind` tells the rows apart: `official` and `private` for one donor, `total` for a group, and `whole total` for the source's figure across every donor. Both fetches issue a `SearchWarning` that no donor was named, which is the reading wanted here. `dfo.fetch(spec, party_totals=True)` does the same for a spec.

## Save the data and load it later

`data.save(path)` writes one Parquet file that carries the table, the citation, and the ref. `dfo.load(path)` reads it back offline:

```python
data = dfo.search("Kenya's external debt service").fetch()
data.save("kenya-debt.parquet")

saved = dfo.load("kenya-debt.parquet")
print(saved.ref == data.ref, len(saved))  # True 55
print(saved.citation.text)
```

The file is the record of what you analysed. The Parquet file reads in any Arrow tool, and its provenance sits in the file's metadata under `dfo.*` keys.

## Refresh later and tell if the data changed

`data.ref` names the exact version a dataset holds. `dfo.fetch(ref)` returns those rows again, and `dfo.fetch(ref, latest=True)` builds the newest version of the same reading. Two refs are equal when they name the same versions:

```python
old = dfo.load("kenya-debt.parquet")
new = dfo.fetch(old.ref, latest=True)

if new.ref != old.ref:
    print("DFO's data has changed since you saved it")
    new.save("kenya-debt.parquet")
```

A version marked "held until" in the dataset's display can be fetched by its ref until that date, and one marked "pinned" is kept without a limit. The saved file keeps its rows either way. [Datasets and versions](docs/datasets.md) covers refs and retention.

## Share an answer

`answer.to_json()` writes the answer as JSON, and `dfo.Answer.from_json(text)` reads it back, ready to choose and fetch. A web app uses this to show the readings on one request and build the reader's choice on the next:

```python
answer = dfo.search("government education spending Kenya")
text = answer.to_json()

restored = dfo.Answer.from_json(text)
data = restored.choose(1).fetch()
print(data.sentence)
```

Answer JSON that comes back from a browser can carry any reading, and its build runs on your key. [Answers and choices](docs/answers.md) says how to keep a web app safe with it.

## Look up a place code

`dfo.lookup.resolve` turns names into the codes `entities` takes. It returns one `Match` per name, which prints what the name resolved to. A name that matches several places lists them, and a misspelt name names the nearest:

```python
for match in dfo.lookup.resolve("Nigeria", "Congo", "Germny"):
    print(match)
```

```text
Nigeria -> Nigeria  country/NGA  (country)
Congo -> ambiguous: Congo [DRC]  country/COD | Congo [Republic]  country/COG
Germny -> not found; nearest: Germany  country/DEU
```

`match.entity.dcid` holds the code of a resolved name, `match.candidates` the places an ambiguous one could mean, and `match.near_matches` the nearest spellings. `match.raw` keeps the server's result. `resolve` also takes `kinds`, such as `["country"]`, to limit the node kinds a name may match, `code_system` with `kinds=["code"]` to match one code system's codes, such as `CRSPurposeCodeEnum`, and `expand_members=True` to inline each group's members. `dfo.lookup.node("country/NGA")` returns one place, with the regions it belongs to in `node.raw`, and `as_of=` reads the graph on a past date. `dfo.lookup.code("spec_not_found")` explains a code from an error, and `dfo.lookup.catalogue()` lists what Search holds data on, with example questions. The result types live in `dfo.types`.

## Settings, keys, and errors

`dfo.search` and `dfo.fetch` use a default client that reads `DFO_BASE_URL` and your stored key. `dfo.Client` carries the same calls with its own settings, and closes its connections on exit:

```python
with dfo.Client(timeout=60.0, max_retries=3) as client:
    data = client.search("Kenya's external debt service").fetch()
    print(len(data))
```

`Client` takes `api_key`, `base_url`, `timeout` (one request attempt, 30 seconds by default), `max_retries` (0 to 10, default 2), `cache_dir`, `cache`, `headers`, and `header_provider`. `dfo.configure(...)` takes the same options and replaces the default client. `dfo.AsyncClient` has the same methods as coroutines. `client.lookup` holds the lookups. `client.with_options(timeout=..., max_retries=...)` returns a copy with other limits that shares the client's connections and cache.

Run `dfo auth login` to store a key, and `dfo auth status` to see which key the client sends. [Keys and credentials](docs/keys.md) covers the lookup order.

Every error derives from `dfo.errors.DfoError`, carries a `code`, and ends its message with `[code]`, or `[code · trace id]` when a response carried one. A refusal names the fix, such as the call that settles an incomplete answer. [Errors](docs/errors.md) lists every class by what you do next. The types answers and datasets contain live in `dfo.types`.

## Limits the client enforces

The Python and TypeScript clients both apply these limits. The constant names are those in the Python source.

| Rule                | Value                                                                                                                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Retry-After` parse | ASCII digits (seconds) or an IMF-fixdate such as `Sun, 06 Nov 1994 08:49:37 GMT`. Any other value is ignored, and the client's own backoff applies. A date in the past means 0                                                                  |
| `Retry-After` wait  | The client waits when the value is at most 60 s (`RETRY_AFTER_MAX_S`) and fits the time left before the call's deadline. Otherwise it raises the refusal's typed error at once with `retry_after` set                                           |
| Poll interval       | The server's value, or a refused poll's `Retry-After`, clamped to 1 s (`POLL_INTERVAL_MIN_S`) to 60 s (`POLL_INTERVAL_MAX_S`), then to the time left before the deadline, where the client polls once more                                      |
| Versions walk       | Pages of 100 versions, at most 20 pages (`VERSIONS_PAGE_BUDGET`). A page cursor seen before raises `contract_violation`. Over the budget, no newest version is reported                                                                         |
| Body size           | Decoded bytes are counted while the body streams, and the read stops at the limit with `response_too_large`. A file's limit is its manifest's `bytes`, else 2 GiB (`DOWNLOAD_MAX_BYTES`). A JSON body's limit is 16 MiB (`JSON_BODY_MAX_BYTES`) |
| Keys                | Visible ASCII only, 0x21 to 0x7E. The key-format check (prefix, base62, checksum) only warns                                                                                                                                                    |
| Header values       | Visible ASCII, space, and tab. A control character, DEL, or a non-ASCII character raises `header_invalid`                                                                                                                                       |
| `timeout`           | A finite number above 0. A call's own `timeout` bounds the whole call (60 seconds for `search`, and no limit for `fetch` unless you pass one)                                                                                                   |
| `max_retries`       | An integer from 0 to 10. A bool is refused                                                                                                                                                                                                      |
| Error messages      | Name the source and the position of the offending character, and leave the key or header value out                                                                                                                                              |

A key travels only to an https base URL, or to a loopback one over http: `localhost`, a name under `.localhost`, an address in 127.0.0.0/8 written as four decimal numbers, or `[::1]`. Any other plain-http base URL with a key raises `insecure_transport`. In synchronous code, platform name resolution can run past a deadline, and the asynchronous client can cancel it.

A process forked from a threaded parent keeps the default client and the proxy settings the parent resolved. A client the child builds for itself reads the platform's proxy settings in the child, which can crash a macOS child forked from a process with running threads. Build the client in the parent, or start workers with `spawn`.

The TypeScript client follows the same contract. It spells "no limit" as `Infinity` where Python uses `None`, decodes a Parquet file's row values on first use where Python decodes them when `fetch` returns, and writes refs without spaces after separators. Each client reads the other's refs.

## Documentation

- [Answers and choices](docs/answers.md): parts, readings, `choose`, partial fetches, shared answers, and declined questions.
- [Datasets and versions](docs/datasets.md): narrowing a fetch, layouts, conversions, refs, retention, `save`, and `load`.
- [Long builds](docs/long-builds.md): progress, deadlines, and what Ctrl-C leaves running.
- [Compute a figure on DFO](docs/compute.md): `dfo.analysis`, recipes, `latest_year`, recomputing on new data, and the series an operation leaves out.
- [Cards and shares](docs/shares.md): charts, tables and headline numbers, public share links, write tokens, snapshots, and what a share showed on a date.
- [Errors](docs/errors.md): every error class and code, by what you do next.
- [Keys and credentials](docs/keys.md): the key lookup order, `dfo auth login`, and the credentials file.
- [The cache](docs/cache.md): where downloads go, `DFO_OFFLINE`, and stale reads.

[llms.txt](llms.txt) summarises the package for language models.

## Development

The repository root holds the contract, the pre-commit configuration, and the CI workflows, and [`CONTRIBUTING.md`](../CONTRIBUTING.md) there explains them. From this directory:

```bash
uv sync
uv run pytest
uv run ruff check
uv run ruff format --check
uv run ty check
```
