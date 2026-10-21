# Datasets and versions

`fetch` returns a `Dataset`: a table with its provenance, holding one exact version of each reading. DFO data changes as sources publish, so `fetch` settles "latest" to one version when it builds, and the dataset keeps that version. `data.ref` records it, and fetching the ref later returns the same rows.

Each example on this page runs on its own.

## Fetch a spec

`answer.fetch()` builds every reading in an answer. `dfo.fetch(spec)` builds one spec's latest version, and takes the spec from an answer, a candidate, or a file `Spec.to_json` wrote:

```python
import dfo

answer = dfo.search(
    "Gross ODA disbursements to Ethiopia from every provider, 2015 to 2022"
)
spec = answer.specs[0]

data = dfo.fetch(spec)
print(data.rows)
```

`fetch` downloads the file through a signed URL and checks it against the digest its manifest names before it returns. A `Dataset` holds no client, its conversions never touch the network, and it pickles.

### Narrow before the build

Three arguments narrow a spec on the server, so a fetch of four years waits for four years of rows:

- `window`: `"all"`, `"latest"`, or a `(start_year, end_year)` pair.
- `entities`: role names bound to place dcids, as `{"destination": ["country/ETH"]}`.
- `facets`: the `provenance`, `measurementMethod` or `unit` axis bound to a ref; None binds the facets that declare no value on that axis.

```python
import dfo

answer = dfo.search(
    "Gross ODA disbursements to Ethiopia from every provider, 2015 to 2022"
)
spec = answer.specs[0]

data = dfo.fetch(
    spec,
    window=(2020, 2022),
    entities={"destination": ["country/ETH"], "origin": ["country/DEU", "country/FRA"]},
)
print(data.sentence)
# Gross disbursements to Ethiopia from Germany and France for official development assistance, 2020 to 2022. ...
```

> [!WARNING]
> `entities` replaces every role the spec binds. Binding only `origin` in the example above drops Ethiopia and returns all 225 recipients. Name every role you want to keep. The roles a spec binds are under `spec.definition["identity"]["entities"]`.

A narrowed spec is a new reading with its own `spec_id`, which `data.members[0].spec` holds.

### The two layouts

The default `layout="long"` gives the labelled long table: one row per observation, each code beside its label (`financingProvider` and `financingProvider_label`), then `time_period`, `value` and the unit. `layout="frame"` gives the pipeline frame, with codes only:

```python
import dfo

spec = dfo.search(
    "ODA disbursements from Germany to Nigeria for basic health care"
).specs[0]

frame = dfo.fetch(spec, layout="frame")
print(frame.layout_version)  # frame
print(frame.to_arrow().schema.names[:5])
```

The frame holds one reading. `layout="frame"` on an answer with several readings raises `InvalidRequestError`, so fetch each spec on its own.

## Use the data

```python
import duckdb

import dfo

data = dfo.search(
    "ODA disbursements from Germany to Nigeria for basic health care"
).fetch()

arrow_table = data.to_arrow()  # pyarrow.Table, provenance in the schema metadata
df = data.to_pandas()  # needs the pandas extra; provenance in df.attrs
pl = data.to_polars()  # needs the polars extra

print(
    duckdb.sql(
        "select time_period, value from arrow_table order by time_period desc limit 3"
    )
)
```

`to_pandas()` copies the sentence, citation, sources, licence and ref into `df.attrs`. A merge or a concat drops `attrs`, and the provenance stays on the dataset. The dataset also implements the Arrow PyCapsule stream, so any library that reads `__arrow_c_stream__` takes it directly, such as `polars.DataFrame(data)`. The DuckDB query above needs `pip install duckdb`.

A missing extra raises `ImportError` with the install line, such as `pip install 'development-finance[pandas]'`.

### What a dataset carries

| Attribute                                           | Holds                                                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `sentence`                                          | What the data shows, in Search's words                                                         |
| `members`                                           | One `Member` per reading: `spec`, `content_version`, `sentence`, `citation`, `digest`, `parts` |
| `ref`                                               | The `DatasetRef` to fetch these versions again                                                 |
| `citation`, `sources`, `licence`                    | How to cite the data, and the sources behind it                                                |
| `rows`                                              | The row count; `len(data)` gives the same                                                      |
| `warnings`                                          | The datasets surface's warnings about the data, as `Notice` objects                            |
| `departures`, `requested_operations`, `assumptions` | How the readings differ from the question                                                      |
| `complete`, `missing`                               | Whether every part has a member, and the gaps a partial fetch left out                         |
| `held_until`, `pinned`                              | How long the server keeps the versions                                                         |
| `stale`                                             | Whether the data came from the cache without asking the server                                 |
| `layout_version`                                    | The table's column set: the long layout's version, or `frame`                                  |

A dataset of several readings stacks them into one long table with a leading `part` column, holding the question's words for each row's reading. Columns one reading lacks are null in its rows.

Warnings the server attaches to the data arrive as `DataWarning`, with a `code` and `severity`. `strict=True` raises the first one instead.

## Keep a result

`data.ref` is a short JSON record of each reading's spec, version and file digest. Save it beside your analysis:

```python
from pathlib import Path

import dfo

data = dfo.search(
    "ODA disbursements from Germany to Nigeria for basic health care"
).fetch()
Path("health.ref.json").write_text(data.ref.to_json())
```

Months later, the ref returns the same rows:

```python
from pathlib import Path

import dfo

ref = dfo.DatasetRef.from_json(Path("health.ref.json").read_text())
data = dfo.fetch(ref)
print(data.members[0].content_version)
```

A ref fetch takes no narrowing and returns the layout the ref holds. `window`, `entities`, `facets` or another `layout` raise `InvalidRequestError`. The format is the same in every DFO client, so a ref saved from Python loads in TypeScript. `DatasetRef.from_json` raises `FormatError`, a `ValueError`, when the JSON breaks the format, with a `reason` and a JSON Pointer to the bad value.

A `Spec` has the same pair, for keeping a reading without a version: `spec.to_json()` and `dfo.Spec.from_json(text)`. Fetching a stored spec builds its latest version.

### Where a stored version comes from

`fetch(ref)` looks for each version in this order:

1. the local cache, by digest;
2. the version's stored file on the server;
3. the server's re-render of the version from its stored frame;
4. a fresh build, accepted only when it returns the same version;
5. otherwise `VersionUnavailableError`.

The error names the newest version in its message and in `newest_version`. Fetch the spec for it, and save the new ref:

```python
from pathlib import Path

import dfo

ref = dfo.DatasetRef.from_json(Path("health.ref.json").read_text())
try:
    data = dfo.fetch(ref)
except dfo.VersionUnavailableError as error:
    print(error.newest_version)
    data = dfo.fetch(ref.members[0].spec)
    Path("health.ref.json").write_text(data.ref.to_json())
```

A version the server never built raises `NotFoundError` at once, with the code `snapshot_not_found`.

### Retention

The server keeps a version's file for 30 days, and after that rebuilds it from stored data where it can. `held_until` is the earliest date any member can still be fetched without being pinned, and None when the server does not say. `pinned` is True when every member is kept without a time limit. The display shows both, as "Held until 18 November 2026, not pinned". The client's own cache holds a copy too, so a version you fetched once loads without the server.

## Save and open a file

`data.save(path)` writes one Parquet file whose metadata carries the provenance and the ref. `dfo.open_bundle(path)` reads it back into an equal dataset, without the network:

```python
import dfo

data = dfo.search(
    "ODA disbursements from Germany to Nigeria for basic health care"
).fetch()
data.save("health.parquet")

opened = dfo.open_bundle("health.parquet")
print(opened.sentence == data.sentence, opened.ref == data.ref)  # True True
```

`open_bundle` also reads a bundle downloaded from the website: the ZIP, the folder it extracts to, or its `datapackage.json` or data file. It types the CSV or XLSX columns from `datapackage.json` and checks each file's hash before it reads the data. An XLSX bundle needs the `xlsx` extra.

It raises `BundleError`, a `ValueError`, with a `reason`:

- `not_a_bundle`: a Parquet file without a saved dataset's provenance.
- `no_descriptor`: a CSV or XLSX with no `datapackage.json` beside it. Download the whole bundle, or fetch the dataset with `dfo.fetch`.
- `no_data_resource`: a descriptor that names no data table.
- `missing_file`: a file the descriptor lists and the bundle lacks.
- `hash_mismatch`: a file whose bytes differ from its hash. Download the bundle again.

A website bundle opened from a folder has no members and no `ref`, because the folder names no stored file. Open the ZIP to keep them.

## Next

- [Long builds and operations](long-builds.md): what `fetch` does while a large table builds.
- [The cache](cache.md): where downloads go, and reading refs offline.
