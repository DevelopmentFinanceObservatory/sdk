# Fetch and keep a dataset

`dfo.fetch` builds a table and returns a `Dataset`: the rows, Search's sentence for them, the citation, and a ref that names the exact version you received. This page covers what comes after the search: narrowing a fetch, summing a column, moving the table into pandas, polars or Arrow, and keeping it so that a later run can tell whether the data changed.

The blocks on this page run in order, as cells of one notebook.

## Fetch a spec, narrowed

`answer.fetch()` builds every reading in an answer. `dfo.fetch(spec)` builds one of them, and narrows it on the server first, so a fetch of three years waits for three years of rows:

```text
<Dataset Gross disbursements to Ethiopia from Germany and France for official development assistance, 2020 to 2022. Current US dollars · OECD DAC2a.
  Source: OECD DAC2A
  Version: cv_10b015cf283096956338e98b97024857 (exact), held until 19 November 2026, not pinned
  Rows: 6
  Keep: data.save(path) · newest later: dfo.fetch(data.ref, latest=True)>
   time_period financingProvider_label        value
0         2020                 Germany  447440917.0
1         2021                 Germany  175013360.0
2         2022                 Germany  252521505.0
3         2020                  France   83268048.0
4         2021                  France   55879173.0
5         2022                  France  103160459.0
```

```python
import dfo

answer = dfo.search("ODA to Ethiopia from each donor, 2015 to 2022")
spec = answer.specs[0]

data = dfo.fetch(
    spec,
    window=(2020, 2022),
    entities={"origin": ["country/DEU", "country/FRA"]},
)
print(data)
print(data.to_pandas()[["time_period", "financingProvider_label", "value"]])
```

Three arguments narrow a spec:

- `window` takes `"all"`, `"latest"`, or a `(start_year, end_year)` pair of years from 1000 to 2200; `(2020, 2020)` is one year.
- `entities` binds roles to place dcids. The roles you name change, the spec's other roles keep their places, and a role set to None drops out. `spec.roles` lists the role keys a spec takes, each with the dcids it binds, or None for a role it leaves open. This spec binds only `destination`, so `origin` adds the two donors and Ethiopia stays the recipient. A key the spec does not take, such as the column name `financingProvider`, raises `InvalidRequestError` before any request, and the message lists the spec's roles.
- `facets` binds the `provenance`, `measurementMethod` or `unit` axis to a ref. None picks the facets that declare no value on that axis.

`answer.fetch` takes the same three arguments and narrows every reading of the answer with them. Each reading keeps the roles you leave out, and a role one reading does not take raises before any build, naming each part's roles.

A narrowed fetch is a reading of its own, with its own `spec_id` in `data.members[0].spec`. A narrowing that leaves no rows returns a dataset with zero rows and the usual columns, and issues a `DataWarning` with the code `empty_result`.

## Sum a column

A provider or recipient column in DFO data can hold group totals beside their members: "DAC countries" sits in the same column as Germany. `fetch` leaves those rows out, so a sum over `value` counts each donor once. `party_totals=True` keeps them, for when you want the published group figures:

```text
95 rows, 5.55 billion dollars
110 rows, 23.84 billion dollars
   financingProvider_label         value
14   official donors (DAC)  5.231667e+09
9            DAC countries  2.756195e+09
12     multilaterals (DAC)  2.272375e+09
```

```python
import dfo

spec = dfo.search("ODA to Ethiopia from each donor in 2022").specs[0]

donors = dfo.fetch(spec).to_pandas()
with_totals = dfo.fetch(spec, party_totals=True).to_pandas()

print(f"{len(donors)} rows, {donors['value'].sum() / 1e9:.2f} billion dollars")
print(
    f"{len(with_totals)} rows, {with_totals['value'].sum() / 1e9:.2f} billion dollars"
)

totals = with_totals[
    ~with_totals["financingProvider"].isin(donors["financingProvider"])
]
print(totals.nlargest(3, "value")[["financingProvider_label", "value"]])
```

The 15 extra rows are group totals worth 18.3 billion dollars, and each one counts donors that the other 95 rows already hold. The cut applies to the party roles a spec leaves open, and a role the spec binds keeps what it binds. `answer.fetch(party_totals=True)` keeps the totals for every reading in an answer.

## Read the columns

Every table leads with the columns a reader looks at, in this order:

1. `time_period`
1. the provider, as `financingProvider_label`
1. the recipient, as `financingRecipient_label`
1. the place a measure is about, as `observationAbout_label`
1. the CRS purpose, as `crsPurpose_label`
1. `value`
1. the unit, as `unit_label`
1. the flow or aid type, as `crsTypeOfFlow_label` or `dac2aAidType_label`
1. the source, as `provenance_label`

A table without a column skips its slot. Where a table has no label column, the code column takes its place. The columns whose values differ between rows come next, so you see what tells the rows apart, then the columns that hold one value in every row, with `stat_var` last. A dataset of several readings adds a `part` column first, naming the part of the question each row answers, and judges which columns vary over all its rows.

The rows sort by the leading columns other than `value` and `time_period`, then by the columns that vary, then by `time_period`, so the years of each series read together. Each reading of a dataset keeps its own rows, in the order of its readings. Text sorts by Unicode code point and an empty cell sorts last. The ref and the digest name the file the server wrote, before the client reordered it.

```text
['time_period', 'financingProvider_label', 'financingRecipient_label', 'value', 'unit_label', 'dac2aAidType_label', 'provenance_label', 'financingProvider', 'financingProvider_kind', 'financingRecipient', 'financingRecipient_kind', 'dac2aAidType', 'unit', 'currency', 'price_basis', 'base_year', 'measurementMethod', 'measurementMethod_label', 'provenance', 'stat_var']
```

```python
import dfo

data = dfo.search("ODA to Ethiopia from each donor in 2022").fetch()
print(data.to_arrow().schema.names)
```

## Get the pipeline frame

`layout="frame"` returns the table the pipeline wrote, which has code columns and no label columns:

```text
frame 95
['time_period', 'financingProvider', 'financingRecipient', 'value', 'unit', 'stat_var_dac2aAidType', 'provenance', 'measurementMethod', 'status', 'stat_var']
```

```python
import dfo

spec = dfo.search("ODA to Ethiopia from each donor in 2022").specs[0]
frame = dfo.fetch(spec, layout="frame")
print(frame.layout_version, len(frame))
print(frame.to_arrow().schema.names)
```

A frame holds one reading. `answer.fetch(layout="frame")` on an answer with several readings raises `InvalidRequestError` with the code `invalid_argument`, so fetch each spec on its own.

## Convert to pandas, polars or Arrow

```text
OECD Creditor Reporting System (CRS)
30 30
```

```python
import pyarrow as pa

import dfo

data = dfo.search(
    "ODA disbursements from Germany to Nigeria for basic health care"
).fetch()

frame = data.to_pandas()  # needs development-finance[pandas]
print(frame.attrs["citation"])

lazy = data.to_polars().lazy()  # needs development-finance[polars]
table = pa.table(data)  # any library that reads the Arrow C stream
print(len(data), table.num_rows)
```

`to_pandas()` puts the provenance in `frame.attrs`: `sentence`, `citation`, `sources`, `licence`, `ref` as JSON, `complete`, and `missing`. A merge or a concat drops `attrs`, and the dataset keeps them. `to_arrow()` returns a `pyarrow.Table` with the provenance in its schema metadata. `pa.table(data)`, `polars.from_arrow(data)` and DuckDB read the dataset through `__arrow_c_stream__`. `len(data)` is the row count. A dataset holds no Python rows, so `for row in data` and `data["value"]` raise `TypeError` naming the conversions.

## Keep it, and check later for new data

`data.save(path)` writes one Parquet file that carries the provenance and the ref. `dfo.load(path)` reads it back without the network. `dfo.fetch(saved.ref, latest=True)` builds the newest version of the same readings, and comparing the two refs tells you whether anything changed:

```text
True
DatasetRef(1 member: spec_7778beed72f8433bb7fde4293acfd175 at cv_c17d6a131cb4556543b91556e46814e9, exact)
```

```python
import dfo

data = dfo.search("ODA to Ethiopia from each donor in 2022").fetch()
data.save("ethiopia.parquet")

saved = dfo.load("ethiopia.parquet")
print(saved.ref == data.ref)

newest = dfo.fetch(saved.ref, latest=True)
if newest.ref != saved.ref:
    newest.save("ethiopia.parquet")
print(newest.ref)
```

Two refs are equal when they name the same specs at the same versions in the same form, so `newest.ref == saved.ref` means the server holds no newer data. `dfo.fetch(saved.ref)` without `latest` returns the exact versions the ref names, from the cache when it holds them. A ref also travels on its own as JSON, through `data.ref.to_json()` and `dfo.DatasetRef.from_json(text)`, in a format the TypeScript client reads too.

Compare refs, and leave the version strings alone. A table with party totals left out is a cut of the server's plain build, and the cut has a version id of its own. The same data therefore carries two ids:

```text
cv_c17d6a131cb4556543b91556e46814e9
cv_534dd4c2bf9bdafc837d51a3ba4bcf3e
```

```python
import dfo

answer = dfo.search("ODA to Ethiopia from each donor in 2022")
cut = answer.fetch()
plain = answer.fetch(party_totals=True)
print(cut.members[0].content_version)
print(plain.members[0].content_version)
```

`VersionUnavailableError.newest_version` names the newest plain build. A ref whose member is a cut therefore names a version that differs from `newest_version` even when no new data exists.

### When a version is gone

The server keeps a version's file for 30 days, then rebuilds it from stored data where it can. `data.held_until` gives the earliest date any member can still be fetched without being pinned, and `data.pinned` is True when every member is kept without a limit. The client's cache keeps its own copy, so a version you fetched once loads from disk. When neither can supply a version, `dfo.fetch(ref)` raises `VersionUnavailableError`. Fetch the newest version and keep that:

```text
95
```

```python
import dfo
from dfo.errors import VersionUnavailableError

saved = dfo.load("ethiopia.parquet")
try:
    data = dfo.fetch(saved.ref)
except VersionUnavailableError:
    data = dfo.fetch(saved.ref, latest=True)
    data.save("ethiopia.parquet")
print(len(data))
```

## What a dataset holds

- `sentence`: what the data shows, in Search's words.
- `members`: one per reading, each with its `spec`, `content_version` and `citation`.
- `ref`: the exact versions, to fetch the same rows again.
- `citation`, `sources` and `licence`: how to cite the data and under which terms.
- `warnings`, `departures`, `requested_operations` and `assumptions`: how the data differs from the question and what Search assumed.
- `complete` and `missing`: whether every part of the question has a member, and the parts a partial fetch left out.
- `held_until` and `pinned`: how long the server keeps the versions.
- `stale`: True when the rows came from the cache under `DFO_OFFLINE=1`.
- `layout_version`: the column set, or `frame` for the pipeline frame that `layout="frame"` returns for one reading.

`dfo.load` also opens a bundle downloaded from the website: the ZIP, the folder it extracts to, or its `datapackage.json`. It checks each file against its hash before it reads the data, and raises `dfo.errors.BundleError` when a file is missing or its bytes differ. `dfo.load(path, limits=dfo.types.BundleLimits(...))` changes the size bounds it enforces on a bundle.

## Next

- [Wait for a large build](long-builds.md): progress, deadlines and Ctrl-C while a big table builds.
- [The cache](cache.md): what the client keeps on disk, and working offline.
