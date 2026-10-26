# Datasets and versions

`fetch` returns a `Dataset`, a table with its provenance that holds one exact version of each reading. DFO data changes as sources publish, so `fetch` settles "latest" to one version when it builds, and the dataset keeps that version. `data.ref` records it, and fetching the ref later returns the same rows.

Each example on this page runs on its own.

## Fetch a spec

`answer.fetch()` builds every reading in an answer. `dfo.fetch(spec)` builds one spec's latest version, and takes the spec from an answer, a candidate, or a file `Spec.to_json` wrote:

```python
import dfo

answer = dfo.search("ODA to Ethiopia from each donor, 2015 to 2022")
spec = answer.specs[0]

data = dfo.fetch(spec)
print(data.rows)
```

`fetch` downloads the file through a signed URL and checks it against the digest its manifest names before it returns. A download stops at the artifact's size in the manifest or at 2 GiB, whichever is smaller. It then decodes the Parquet file. Bytes that do not decode as Parquet raise `ContractError` with `unexpected_response`. A file that decodes but lacks a `time_period` or numeric `value` column, repeats a column name, or holds no rows where the manifest counts some raises `contract_violation`. In both cases the cache drops the file. A spec id alone does not build: `fetch` takes a `Spec` or a `DatasetRef`, and anything else raises `InvalidRequestError` with `invalid_argument` before any request. A `Dataset` holds no client, and its conversions run offline. It pickles for transfer between processes that run the same version of `development-finance`, as `multiprocessing` does. Keep data with `save`, since another version may fail to load a pickle or load it wrong.

### Narrow before the build

Three arguments narrow a spec on the server, so a fetch of four years waits for four years of rows:

- `window`: `"all"`, `"latest"`, or a `(start_year, end_year)` pair.
- `entities`: roles rebound to place dcids, as `{"origin": ["country/DEU"]}`. The roles you name change and the spec's other roles keep their places; a role bound to None drops out.
- `facets`: the `provenance`, `measurementMethod` or `unit` axis bound to a ref; None binds the facets that declare no value on that axis.

```python
import dfo

answer = dfo.search("ODA to Ethiopia from each donor, 2015 to 2022")
spec = answer.specs[0]

data = dfo.fetch(
    spec,
    window=(2020, 2022),
    entities={"origin": ["country/DEU", "country/FRA"]},
)
print(data.sentence)
# Gross disbursements to Ethiopia from Germany and France for official development assistance, 2020 to 2022. ...
```

Rebinding `origin` keeps Ethiopia as the recipient, since the client posts the spec's own roles with `origin` replaced. The roles a spec binds are under `spec.definition["identity"]["entities"]`.

A narrowed spec is a new reading with its own `spec_id`, which `data.members[0].spec` holds.

A narrowing can leave no data. The fetch then returns a `Dataset` with no rows and the usual columns, and its sentence is Search's no-data sentence for the narrowed reading. The server's `empty_result` warning arrives as a `DataWarning`:

```text
<Dataset No data for official development assistance gross disbursements for basic health care (standard grant, core support to non-governmental organisations, other private bodies, public-private partnerships, and research institutes). Try a different place, time period, or indicator. The data covers only 1995 to 2024.
  Source: OECD Creditor Reporting System (CRS)
  Version: cv_b1a6fed0a63c26c17d344a2cca33e448
  Rows: 0
  Held until 11 November 2026, not pinned>
```

```python
import dfo

spec = dfo.search(
    "ODA disbursements from Germany to Nigeria for basic health care"
).specs[0]

empty = dfo.fetch(spec, window=(1900, 1901))
print(empty)
print(empty.rows, empty.to_arrow().schema.names[:4])
```

An empty member stacks beside the members that have rows and adds none.

### The two layouts

The default `layout="long"` gives the labelled long table, with one row per observation, each code beside its label (`financingProvider` and `financingProvider_label`), then `time_period`, `value` and the unit. `layout="frame"` gives the pipeline frame, with codes only:

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

### Leave out party totals

A provider or recipient column can hold a total beside its members. "DAC countries" sits in the same column as Germany, so summing `value` counts a donor more than once. For Ethiopia in 2022 the table has 110 rows that sum to 23.8 billion dollars, and 95 rows that sum to 5.55 billion without the totals.

`without_party_totals=True` builds the dataset without the rows of parties the code index declares totals, on each party role the spec leaves open. It takes the same place as `layout` on `answer.fetch`, `dfo.fetch`, `client.mint` and `client.operation`:

```text
110 95
23838279487.0 5553373816.0
['official', 'private']
```

```python
import warnings

import dfo

warnings.simplefilter("ignore", dfo.SearchWarning)
answer = dfo.search("top 5 donors to Ethiopia in 2022")

whole = answer.fetch()
cut = answer.fetch(without_party_totals=True)

print(whole.rows, cut.rows)
print(whole.to_pandas()["value"].sum(), cut.to_pandas()["value"].sum())
print(sorted(cut.to_pandas()["financingProvider_kind"].unique()))
```

The cut has three limits:

- A party the spec's identity binds stays on its role. Asking for the DAC total by name returns it.
- A role where every row is a total keeps all its rows, so an answer that is a single total reads the same with or without the flag.
- A row the code index does not mark as a total stays. Some rows repeat another party's figures without carrying that mark, such as the IMF's trust funds in the tables that list them as parties. The remaining rows are not promised to sum to the published total.

A ref records the cut. `data.ref` of a cut dataset carries `without_party_totals` in each member's rendering, a plain ref is unchanged, and `dfo.fetch(ref)` returns the cut. Naming the other value raises `InvalidRequestError`, as a different `layout` does.

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
| `departures`, `requested_operations`, `assumptions` | How the readings differ from the question, and what Search assumed for them                    |
| `complete`, `missing`                               | Whether every part has a member, and the gaps a partial fetch left out                         |
| `held_until`, `pinned`                              | How long the server keeps the versions                                                         |
| `stale`                                             | Whether the data came from the cache without asking the server                                 |
| `layout_version`                                    | The table's column set: the long layout's version, or `frame`                                  |

A dataset of several readings stacks them into one long table with a leading `part` column, holding the question's words for each row's reading. Columns one reading lacks are null in its rows.

Warnings the server attaches to the data arrive as `DataWarning`, with a `code` and `severity`. `strict=True` raises the first one instead. A warning belongs to the version, so it is issued on every fetch of that version, a read from the cache included. The message says that coverage fell short and may not name the place that has no data. Compare the places in the table with the ones you asked for, and silence a warning you have read with `warnings.filterwarnings("ignore", category=dfo.DataWarning)`.

### Line up flows with indicators

A flow set names its places by role: `financingProvider` and `financingRecipient`, each beside `_label` and `_kind` columns. A World Development Indicators set names its place `observationAbout`. To put a flow beside an indicator, match the role column against `observationAbout` and `time_period`:

```text
   time_period  value_oda     value_gdp
0         2015   111870.0  4.930267e+11
1         2016    70773.0  4.046491e+11
2         2020    41880.0  5.985868e+11
```

```python
import dfo

oda = dfo.search(
    "ODA disbursements from Germany to Nigeria for basic health care"
).fetch()
gdp = dfo.search("GDP of Nigeria").fetch()

merged = oda.to_pandas().merge(
    gdp.to_pandas(),
    left_on=["financingRecipient", "time_period"],
    right_on=["observationAbout", "time_period"],
    suffixes=("_oda", "_gdp"),
)
print(merged[["time_period", "value_oda", "value_gdp"]].head())
```

A column that is null in every row, such as `base_year` on a series in current prices, marks a dimension that does not apply to the data. Read the `unit_label` of each side before you divide one by the other.

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

A ref fetch takes no narrowing and returns the layout and rendering the ref holds. `window`, `entities`, `facets`, another `layout` or another `without_party_totals` raise `InvalidRequestError`. The format is the same in every DFO client, so a ref saved from Python loads in TypeScript. `DatasetRef.from_json` raises `FormatError`, a `ValueError`, when the JSON breaks the format, with a `reason` and a JSON Pointer to the bad value.

A `Spec` has the same pair, for keeping a reading without a version: `spec.to_json()` and `dfo.Spec.from_json(text)`. Fetching a stored spec builds its latest version.

### Where a stored version comes from

`fetch(ref)` looks for each version in this order:

1. the local cache, by digest;
1. the version's stored file on the server;
1. the server's re-render of the version from its stored frame;
1. a fresh build, accepted when it returns the same version;
1. otherwise `VersionUnavailableError`.

A digest names one rendering of a version. The server can render a version's rows again to a file with another digest, and steps 1 to 3 then find no file with the ref's digest. When step 4 returns the ref's version, `fetch` returns the data with a `DfoWarning` coded `ref_digest_changed`, which names both digests, and `data.ref` carries the rebuilt file's digest. Save that ref to stop the warning. `strict=True` leaves it a warning, because the data is the version the ref names. When the stored version lists the ref's digest only under another rendering, the ref and its file disagree, and `fetch` raises `FormatError` with `format_invalid` at `/members/<i>/artifact/rendering` before it downloads anything.

The next example changes the digest in a saved ref to show the warning:

```text
DfoWarning ref_digest_changed
spec_774d6c001a6250aa67ca676ab067895e at cv_b92d94774702c7f05f2075d0b03dd756 was rebuilt as sha256:421efacc2dc010af38112a087b0b49ff5539f61d2afd12a88272b27e99b5f5db, not the ref's sha256:0000000000000000000000000000000000000000000000000000000000000000; the version is the same, and dataset.ref names the rebuilt file
```

```python
import json
import warnings

import dfo

data = dfo.search(
    "ODA disbursements from Germany to Nigeria for basic health care"
).fetch()

saved = json.loads(data.ref.to_json())
saved["members"][0]["artifact"]["digest"] = "sha256:" + "0" * 64

with warnings.catch_warnings(record=True) as caught:
    warnings.simplefilter("always")
    again = dfo.fetch(dfo.DatasetRef.from_json(json.dumps(saved)))

for item in caught:
    print(item.category.__name__, item.message.code)
    print(item.message)
```

The error of step 5 names the newest version in its message and in `newest_version`: the version the fresh build returned, or else the newest version in the ref's rendering that the server lists, or None when it lists none. That version can be the ref's own, when the server lists it as the newest. The lookup reads the server's version list newest first, 100 to a page, for at most 20 pages. It considers only versions in the ref's own rendering, plain for a plain ref and party-totals cut for a cut ref, so a groupby collapse is ignored. A page cursor the walk has seen before raises `ContractError` with `contract_violation`. Any refusal of that lookup other than `NotFoundError` raises in its place. Fetch the spec for it, and save the new ref:

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

`data.save(path)` writes one Parquet file whose metadata carries the provenance and the ref. `dfo.open_bundle(path)` reads it back into a dataset with the same table, provenance and ref, without the network:

```python
import dfo

data = dfo.search(
    "ODA disbursements from Germany to Nigeria for basic health care"
).fetch()
data.save("health.parquet")

opened = dfo.open_bundle("health.parquet")
print(opened.sentence == data.sentence, opened.ref == data.ref)  # True True
```

`open_bundle` also reads a bundle downloaded from the website: the ZIP, the folder it extracts to, or its `datapackage.json` or data file. It types the CSV or XLSX columns from `datapackage.json` and checks each file's hash before it reads the data. Every resource that names a file needs a `hash` written as `sha256:` and 64 lower-case hex digits. The data table is the resource whose `name` equals the descriptor's own `name`, so a descriptor written by hand names its one table like the package. An XLSX bundle needs the `xlsx` extra, and a cell holding `inf` or `nan` reads as null, because openpyxl writes no value for it.

## `open_bundle` limits

`dfo.open_bundle(path, *, limits=dfo.BundleLimits())` streams the ZIP and its resources. `BundleLimits` is immutable and keyword-only:

```python
limits = dfo.BundleLimits(
    max_descriptor_bytes=1 * 1024**2,
    max_zip_entries=256,
    max_resources=128,
    max_archive_bytes=512 * 1024**2,
    max_resource_bytes=256 * 1024**2,
    max_total_bytes=512 * 1024**2,
    max_xlsx_entries=128,
    max_xlsx_expanded_bytes=32 * 1024**2,
    max_xlsx_rows=100_000,
    max_xlsx_cells=1_000_000,
)
opened = dfo.open_bundle("health.zip", limits=limits)
```

The descriptor, every resource, and the aggregate are checked against bytes actually read. ZIP entry count is checked after Python reads the ZIP central directory. Services that accept untrusted uploads should use a much smaller `max_archive_bytes` and an isolated worker with CPU and memory limits.

For an XLSX resource, `max_xlsx_entries` and `max_xlsx_expanded_bytes` check the inner ZIP's public entry metadata before `openpyxl` opens the workbook. The expanded-byte value is the ZIP entries' declared uncompressed size. `max_xlsx_rows` limits data rows, and `max_xlsx_cells` limits header and data cells that the reader visits before it retains another row. These limits reduce the workbook work, but do not provide hard memory or CPU guarantees for CSV conversion or XLSX parsing.

It raises `BundleError`, a `ValueError`, with a `reason`:

- `not_a_bundle`: a Parquet file without a saved dataset's provenance.
- `no_descriptor`: a CSV or XLSX with no `datapackage.json` beside it. Download the whole bundle, or fetch the dataset with `dfo.fetch`.
- `no_data_resource`: a descriptor with no resource named like the package.
- `missing_file`: a file the descriptor lists and the bundle lacks.
- `hash_mismatch`: a file whose bytes differ from its hash. Download the bundle again.
- `resource_limit`: a bundle exceeded a `BundleLimits` bound.

`open_bundle` raises `FormatError` for a descriptor that is not a JSON object, lists a file outside the bundle by an absolute path or one that climbs out with `..`, or lists a file without a `sha256:` hash. Those checks run before any file is read. It raises the same error for data that does not fit the columns the descriptor types, and for a saved dataset whose provenance is damaged.

A website bundle opened from a folder has no members, because the folder names no stored file, and reading its `ref` raises `ValueError`. Open the ZIP to keep them.

## Next

- [Long builds and operations](long-builds.md): what `fetch` does while a large table builds.
- [The cache](cache.md): where downloads go, and reading refs offline.
