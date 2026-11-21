# Fetch and keep a dataset

`dfo.fetch` builds a table and returns a `Dataset`: the rows, Search's sentence for them, the citation, and a ref that names the exact version you received.

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
0         2020                  France   83268048.0
1         2021                  France   55879173.0
2         2022                  France  103160459.0
3         2020                 Germany  447440917.0
4         2021                 Germany  175013360.0
5         2022                 Germany  252521505.0
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

- `window` takes `"all"`, `"latest"`, or a `(start_year, end_year)` pair of years from 1000 to 2200. `(2020, 2020)` is one year.
- `entities` binds roles to place dcids, or to the matches `dfo.lookup.resolve` returns, as in `{"origin": dfo.lookup.resolve("Germany", "France")}`. A match that did not resolve raises `InvalidRequestError` before any request. The roles you name change, the spec's other roles keep their places, and a role set to None drops out. `spec.roles` lists the role keys a spec takes, each with the dcids it binds, or None for a role it leaves open: `place` for the place a measure is about, as in `{"place": ["country/NGA", "country/GHA"]}` for GDP, and `origin` and `destination` for a flow. This spec binds only `destination`, so `origin` adds the two donors and Ethiopia stays the recipient. A key the spec does not take, such as the column name `financingProvider`, raises `InvalidRequestError` before any request, and the message lists the spec's roles.
- `facets` binds the `provenance`, `measurementMethod`, or `unit` axis to a ref. None picks the facets that declare no value on that axis.

`answer.fetch` takes the same three arguments and narrows every reading of the answer with them. Each reading keeps the roles you leave out, and a role one reading does not take raises `InvalidRequestError` before any build, naming each part's roles.

A narrowed fetch is a reading of its own, with its own `spec_id` in `data.members[0].spec`. A narrowing that leaves no rows returns a dataset with zero rows and the usual columns, and issues a `DataWarning` with the code `empty_result`.

A question that leaves the donor open, such as "ODA to Ethiopia from each donor", comes back with Search's note that no provider was named, so the answer covers every provider. `answer.fetch()` repeats that note as a `SearchWarning`. `dfo.fetch(spec)` fetches the same reading and issues no `SearchWarning`, so the examples below that leave the donor open fetch the spec.

## Fetch in another currency

Amounts arrive in the unit Search read, usually current US dollars. `currency`, `price_basis` and `base_year` ask for another, named after the row columns they set:

```text
ConversionCurrency(EUR "euros", current 2015-2022, constant 2015-2022, base 1973-2025)
<Dataset Germany's net disbursements (bilateral flows) to Kenya for official development assistance, 2015 to 2022. Constant 2022 euros, donor prices · OECD DAC2a.
  Source: OECD DAC2A
  Version: cv_dd7b2e411a7cb88d1c35dab96a9eb2db (exact), pinned
  Rows: 8, time_period as integer years
  Keep: data.save(path) · newest later: dfo.fetch(data.ref, latest=True)>
   time_period         value currency price_basis  base_year
0         2015  5.011898e+07      EUR    constant       2022
1         2016  3.075620e+07      EUR    constant       2022
2         2017  7.778941e+07      EUR    constant       2022
```

```python
import dfo

answer = dfo.search("bilateral ODA from Germany to Kenya 2015 to 2022")
offer = answer.specs[0].unit_conversion
print(next(c for c in offer.currencies if c.code == "EUR"))

data = answer.fetch(currency="EUR", price_basis="constant", base_year=2022)
print(data)
print(
    data.to_pandas()[
        ["time_period", "value", "currency", "price_basis", "base_year"]
    ].head(3)
)
```

- `currency` takes an ISO 4217 code in capitals, such as `"EUR"`.
- `price_basis` takes `"current"`, each year at its own exchange rate, or `"constant"`, every year at the prices of one base year. Left out, it is `"current"`.
- `base_year` names that base year. `"constant"` needs one and `"current"` takes none. You name it each time. `offer.default_base_year` is the one Search reads when a question names none.

A conversion is another reading of the same question, with its own `spec_id` and sentence, so `data.members[0].spec`, `data.sentence` and `data.ref` name the converted reading. Every row's `currency`, `price_basis` and `base_year` hold what you asked for. `dfo.fetch(spec, currency="EUR")` converts one spec, and `answer.fetch` converts every reading of the answer in one Search request.

`spec.unit_conversion` lists the currencies a spec converts to, as a `dfo.types.UnitConversion`. Each `dfo.types.ConversionCurrency` holds the years the amounts convert at current prices (`current_years`) and at constant prices (`constant_years`), and the range of base years (`base_years`). Those years are the spec's own window, so a fetch with another `window` can convert other years. The offer is None for a spec that did not come from a search, such as a dataset member's spec, and for a series that converts to no currency, such as a debt stock. A fetch with `currency` still goes to the server, which decides.

The conversion applies to the reading as `window`, `entities` and `facets` narrow it, so Search checks the rates for the years and places the build reads. `facets={"unit": ...}` beside `currency` raises `InvalidRequestError` before any request, since both set the unit. A ref, a share and a recipe hold their units already and refuse all three arguments.

When the server cannot convert, the fetch raises with its code, even under `partial=True`:

- `rate_coverage_gap`, an `InvalidRequestError`, when the rate or price tables lack a year the request needs. The message names what is missing, such as `CurrencyEUR@1900`, and `error.problem["cause"]` holds it as data.
- `recipe_not_declared`, an `InvalidRequestError`, for a series no recipe converts, such as a debt stock.

A conversion that leaves some rows out, such as an entity the deflators do not cover, keeps the rest and issues a `SearchWarning` with the code `deflator_missing_omitted`. `strict=True` raises it. Under `DFO_OFFLINE=1` a fetch with `currency` raises `NetworkError` (`offline`), since only the server knows the converted reading.

## Sum a column

A provider or recipient column in DFO data can hold group totals beside their members. "DAC countries" sits in the same column as Germany. `fetch` leaves those rows out, so a sum over `value` counts each donor once. Pass `party_totals=True` to keep the published group figures:

```text
95 rows, 5.55 billion dollars
110 rows, 23.84 billion dollars
    financingProvider_label         value
106   official donors (DAC)  5.231667e+09
17            DAC countries  2.756195e+09
104     multilaterals (DAC)  2.272375e+09
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

The default keeps some totals on an open role. The cut judges each series in each period, where a series is the frame's columns other than the role, `time_period` and provenance, such as `stat_var`, the other party role and `unit`. A period in which the series holds single parties for the role, such as single donors, drops its totals. A period that holds only totals keeps the ones the code index marks whole, so a year with no donor-level rows still holds one figure. When none of those totals is whole, the period drops them if the series holds single parties in another period, and keeps them all if it holds none in any period. A sum over that role can then count totals nested inside other totals.

`data.party_totals_left_out` names the totals a fetch left out. It holds one `dfo.types.PartyTotalsLeftOut` per member, party role, provenance and set of kept series, with the role's column name, such as `financingProvider`, and the dcids of the totals, such as `DACCountriesTotal`. `role_key` names the key `entities=` takes for that column, `origin` or `destination`, and is None for a column the client does not know. `kept_in` lists the series whose rows kept those totals, each a `dfo.types.KeptSeries` whose `series` maps each of the series' columns to its cell, a string, None or a unit as a dict, and whose `time_periods` lists the periods in which the series kept them. It is empty when the totals left every series in every period. Two entries can share a role and a provenance and differ by `kept_in`. The repr counts the totals on its `Party totals left out` line, with the role key beside each column, as in `15 on financingProvider (origin)`, and `data.save` keeps them. The tuple is empty after `party_totals=True` and when the cut found no totals to drop.

A derived Dataset from `dfo.analysis` reports what each reading's read left out, each entry named by the reading's spec id, in the order of the recipe's readings, and its repr says `Party totals left out of the readings`. Its tuple is also empty against a server older than this report and when DFO could not read a reading, so an empty tuple there leaves open whether the readings kept every total.

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

A table without a column skips its slot. Where a table has no label column, the code column takes its place. The columns whose values differ between rows come next, so you see what tells the rows apart, then the columns that hold one value in every row, with `stat_var` last. A dataset of several members adds a `part` column first, naming the part of the question each row answers, and judges which columns vary over all its rows.

The rows sort by the leading columns other than `value` and `time_period`, then by the columns that vary, then by `time_period`, so the years of each series read together. Each member of a dataset keeps its own rows, in the order of its members. Text sorts by Unicode code point and an empty cell sorts last. The ref and the digest name the file the server wrote, before the client reordered it.

```text
['time_period', 'financingProvider_label', 'financingRecipient_label', 'value', 'unit_label', 'dac2aAidType_label', 'provenance_label', 'financingProvider', 'financingProvider_kind', 'financingRecipient', 'financingRecipient_kind', 'dac2aAidType', 'unit', 'currency', 'price_basis', 'base_year', 'measurementMethod', 'measurementMethod_label', 'provenance', 'stat_var']
```

```python
import dfo

spec = dfo.search("ODA to Ethiopia from each donor in 2022").specs[0]
data = dfo.fetch(spec)
print(data.to_arrow().schema.names)
```

## Get the pipeline frame

`layout="frame"` returns the table the pipeline wrote, with code columns only:

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

## Convert to pandas, polars, or Arrow

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

`to_pandas()` puts the provenance in `frame.attrs`: `sentence`, `citation`, `sources`, `licence`, `ref` as JSON, `complete`, and `missing`. A merge or a concat drops `attrs`, and the dataset keeps them. `to_arrow()` returns a `pyarrow.Table` with the provenance in its schema metadata. `pa.table(data)`, `polars.from_arrow(data)`, and DuckDB read the dataset through `__arrow_c_stream__`. `len(data)` is the row count. Iterating over `data` or indexing it, as in `for row in data` and `data["value"]`, raises a `TypeError` that names the conversions.

## Keep it, and check later for new data

`data.save(path)` writes one Parquet file that carries the provenance and the ref. `data.to_bytes()` returns the same file as bytes, for object storage or a database column. `dfo.load(path)` reads either back without the network, given a path or the bytes. `dfo.fetch(saved.ref, latest=True)` builds the newest version of the same readings, and comparing the two refs tells you whether anything changed:

```text
True
DatasetRef(1 member: spec_7778beed72f8433bb7fde4293acfd175 at cv_c17d6a131cb4556543b91556e46814e9, exact)
```

```python
import dfo

spec = dfo.search("ODA to Ethiopia from each donor in 2022").specs[0]
data = dfo.fetch(spec)
data.save("ethiopia.parquet")

saved = dfo.load("ethiopia.parquet")
print(saved.ref == data.ref)

newest = dfo.fetch(saved.ref, latest=True)
if newest.ref != saved.ref:
    newest.save("ethiopia.parquet")
print(newest.ref)
```

Two refs are equal when they name the same specs at the same versions in the same form, so `newest.ref == saved.ref` means the server holds no newer data. `dfo.fetch(saved.ref)` without `latest` returns the exact versions the ref names, from the cache when it holds them. A ref also travels on its own as JSON, through `data.ref.to_json()` and `dfo.DatasetRef.from_json(text)`, in a format the TypeScript client reads too.

Compare refs, because one set of data can carry two version ids. A table with party totals left out is a cut of the server's plain build, and the cut has a version id of its own:

```text
cv_c17d6a131cb4556543b91556e46814e9
cv_534dd4c2bf9bdafc837d51a3ba4bcf3e
```

```python
import dfo

spec = dfo.search("ODA to Ethiopia from each donor in 2022").specs[0]
cut = dfo.fetch(spec)
plain = dfo.fetch(spec, party_totals=True)
print(cut.members[0].content_version)
print(plain.members[0].content_version)
```

`VersionUnavailableError.newest_version` names the newest plain build. A ref whose member is a cut therefore names a version that differs from `newest_version` even when no new data exists.

### Read the newest stored version

`dfo.fetch(ref, latest="stored")` reads the version DFO stores as the newest of each member's spec, in the member's rendering, and builds nothing when DFO holds one it can serve:

<!-- docs-check: skip: needs the stored-version read, which the dev API does not serve yet -->

```python
import dfo

saved = dfo.load("ethiopia.parquet")
data = dfo.fetch(saved.ref, latest="stored")
print(data.freshness, len(data))
```

The fetch sends two GETs per member: the spec's manifest at `GET /datasets/{spec_id}`, with the member's rendering as its query, and the file, checked against its digest. It makes no Search call, and `data.sentence` is the ref's. DFO answers from the newest version it stores. `data.freshness` says what the data is, the worst of its members:

- `current`: DFO found this version the newest at a check in the last 15 minutes.
- `pending`: DFO is checking for newer data, and the version is the one its last check found.
- `stale`: DFO could not start a check, or the last one failed, so newer data may exist.

`data.freshness` is None when the API states no value or one this client does not know. DFO serves a stored version younger than 7 days at once and checks for newer data in the background, so a reading nobody opened in that time can be up to 7 days behind for its first reader. A version older than 7 days is rebuilt on read. The call waits for the build, as `latest=True` does, and a version it waited for is `current`. `data.ref` names the versions read and leaves the freshness out, as the saved file does.

`latest=True` has DFO check for newer data before it answers, so use it in a data step that must hold the newest data. `latest="stored"` suits a read that should answer at once, such as a dashboard. A recipe takes it too, and runs on the stored newest version of each dataset it starts from, as [Follow new data and recompute](compute.md#follow-new-data-and-recompute) describes. A ref of a frame DFO computed, a spec, and a share each refuse `latest="stored"` with `InvalidRequestError` before any request.

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
- `members`: one per built spec (readings that narrow to one spec share a member), each with its `spec`, `content_version` and `citation`.
- `ref`: the exact versions, to fetch the same rows again.
- `citation`, `sources` and `licence`: how to cite the data and under which terms.
- `warnings`, `departures`, `requested_operations`, and `assumptions`: how the data differs from the question and what Search assumed.
- `complete` and `missing`: whether every part of the question has a member, and the parts a partial fetch left out.
- `held_until` and `pinned`: how long the server keeps the versions.
- `stale`: True when the rows came from the cache under `DFO_OFFLINE=1`.
- `from_cache` and `fetched_at`: whether the fetch read any file from the cache, and when the data left the server, as a UTC `datetime` or None when the cache recorded no time. [The cache](cache.md#tell-a-cache-hit-from-a-download) shows the display line.
- `question`: the question the data answers, when it came from `answer.fetch()`, else None.
- `freshness`: how new the versions are, `current`, `pending` or `stale`, for a dataset `dfo.fetch(ref, latest="stored")` or `dfo.fetch(recipe, latest="stored")` read, else None. The saved file leaves it out.
- `layout_version`: the column set, or `frame` for the pipeline frame that `layout="frame"` returns for one reading.

The saved file keeps the provenance in the Parquet key-value metadata, under these keys. Each value is UTF-8 text, and a key marked optional is left out when the dataset has no value for it:

- `dfo.format_version`: the saved format, `1` for a dataset of dataset versions, `2` for a derived dataset, and `3` for a derived dataset with a partitioned ranking, as plain text.
- `dfo.sentence`: the dataset's sentence, as plain text.
- `dfo.citation`: the citation, as a JSON object.
- `dfo.sources`: the sources, as a JSON array of strings.
- `dfo.licence`: the licence, as plain text.
- `dfo.dataset`: a JSON object of the rest: each member's citation, the warnings, departures, requested operations and assumptions, `complete`, `missing`, `held_until`, `pinned`, `stale`, `layout_version`, and the row count of each member.
- `dfo.ref`: optional, the ref as `ref.to_json()` writes it. A bundle opened from a folder has none.
- `dfo.question`: optional, the question, as a JSON string. Added in 0.2.0.
- `dfo.fetched_at`: optional, when the data left the server, as a JSON string `YYYY-MM-DDTHH:MM:SSZ`. Added in 0.2.0.
- `dfo.retention`: written with `dfo.ref`, each member's retention, as a JSON array of `{"pinned", "held_until"}`, one per member in order. A file without it reads every member as pinned when `pinned` is true, and with both None otherwise. Added in 0.3.0.
- `dfo.left_out`: a derived dataset only, the series its steps left out, as a JSON object of `series` and `complete`.
- `dfo.steps`: a derived dataset only, its steps, as a JSON array of `verb`, `by` and `limit`. A step of a ranking split by `per` also holds `per`, a list of columns, and only a format 3 file may hold it.
- `dfo.party_totals_left_out`: optional, the party totals the fetch left out, as a JSON array of entries with `spec_id`, `role`, `entities`, and `provenance` and `kept_in` where they apply. A derived dataset's entries name its readings' spec ids, in the order of its readings. Added in 0.2.0.

`dfo.load` reads each key back, `question` and `fetched_at` included, sets `from_cache` to False, and `freshness` to None. A 0.1.0 client ignores the keys added in 0.2.0, and a 0.2.0 client the key added in 0.3.0.

`dfo.load` also opens a bundle downloaded from the website: the ZIP, the folder it extracts to, or its `datapackage.json`. It checks each file against its hash before it reads the data, and raises `dfo.errors.BundleError` when a file is missing or its bytes differ. `dfo.load(path, limits=dfo.types.BundleLimits(...))` changes the size bounds it enforces on a bundle.

## Next

- [Wait for a large build](long-builds.md) covers progress, deadlines, and Ctrl-C while a big table builds.
- [The cache](cache.md) covers what the client keeps on disk, and working offline.
