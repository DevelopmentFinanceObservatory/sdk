# Compute a figure on DFO

`dfo.analysis` runs DFO's operations, such as a growth rate, a ranking, or aid per person, on the server and returns the result as a `Dataset`. DFO keeps that result as a derived version with a ref of its own, so you can fetch it again, compute it again on newer data, save it, or draw it as a card.

The blocks on this page run in order, as cells of one notebook.

## Compute a figure

Each function in `dfo.analysis` takes the data to work on and returns the result. Divide German aid by Kenya's population to get aid per person:

```text
<Dataset Computed by DFO: quotient_of.
  Source: OECD DAC2A; World Development Indicators
  Derived: quotient_of by destination, from 2 readings
  Missing data: 3 series left out · data.left_out
  Version: ocv_129d9b2f36f398bb414c5f7a97230804 (exact), held until 27 November 2026, not pinned
  Rows: 6, time_period as text, such as "2022" or "2021/2022"
  Keep: data.save(path) · newest later: dfo.fetch(data.ref, latest=True)>
  time_period financingRecipient     value
0        2018        country/KEN  3.647633
1        2019        country/KEN  3.950892
2        2020        country/KEN  5.076388
3        2021        country/KEN  5.682417
4        2022        country/KEN  5.267689
5        2023        country/KEN  5.676891
```

```python
import dfo

aid = dfo.search("ODA from Germany to Kenya, Ghana and Nigeria, 2018 to 2023").fetch()
people = dfo.search("Kenya population, 2015 to 2024").fetch()

per_person = dfo.analysis.quotient_of(aid, people, on={"destination": "place"})
print(per_person)
print(per_person.to_pandas()[["time_period", "financingRecipient", "value"]])
```

`on` pairs the roles of the two readings that hold the same places: the aid's `destination` with the population's `place`. The population covers Kenya alone, so DFO leaves Ghana and Nigeria out and counts them in the `Missing data` line. [Find out why series were left out](#find-out-why-series-were-left-out) reads that list.

Every function takes a `Spec`, a `DatasetRef`, a `Dataset`, or a `Recipe` as its data. A `Dataset` or ref sends its exact version, and a `Spec` sends the newest version without party totals, as `dfo.fetch(spec)` reads it. DFO builds any version it has not built yet, then computes. The call waits as long as that takes unless you pass `timeout=` in seconds.

A derived frame's `time_period` is text, such as `"2022"`, or `"2018/2023"` for a value that spans years, as `growth` and `aggregate` write. A dataset in the long layout holds integer years, and one in the frame layout holds text. Compare years as text, or convert with `int(year)` where a value covers one year.

The result's `unit` column holds a unit id, such as `CurrencyUSD`, or, for a composed unit, its JSON text. Aid per person has the unit `{"denominator":{"stat_var":"dcid:Count_Person"},"numerator":"CurrencyUSD"}`, US dollars per person. A relative growth has no unit, and its `unit` cell is empty.

## Pick the operation

Each operation states its result on its own scale:

| Function                                    | Result                                                                                                                                                                                                    |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filter(data, keep=...)`                    | The rows whose role or column holds one of the values, as `keep={"destination": "country/KEN"}`                                                                                                           |
| `aggregate(data, by=..., how="sum")`        | One value per member of `by` over every year the data holds, by `sum`, `mean`, `max`, or `min`, in the data's unit                                                                                        |
| `growth(data, by=..., window=(start, end))` | The change from the first year to the last. `change="relative"`, the default, is a fraction with no unit: 0.25 is a 25% rise. `change="difference"` is the last value minus the first, in the data's unit |
| `rank(data, by=..., window=..., limit=...)` | The members of `by`, largest first, the top `limit` kept (1 to 1000). A tie at the last place keeps every member that shares it                                                                           |
| `quotient_of(data, other, on=...)`          | `data` divided by `other`, in a composed unit                                                                                                                                                             |
| `share_of(data, total, by=..., on=...)`     | Each value as a percentage of its total, 0 to 100 when each value is part of the total: 25.0 is a quarter. With no `total`, the total is the sum over the members of `by` in the same year                |
| `sum_of(data, other, on=...)`               | The matching rows of both readings added, over the years both hold                                                                                                                                        |
| `compare(data, other, on=...)`              | `data` minus `other` for each matching member, over the years both hold. DFO refuses two different units                                                                                                  |
| `join(data, other, on=...)`                 | Both readings' rows in one long frame, told apart by `stat_var`                                                                                                                                           |

The growth of German aid to each recipient from 2018 to 2023:

```text
  time_period financingRecipient     value
0   2018/2023        country/GHA  0.371455
1   2018/2023        country/KEN  0.714912
2   2018/2023        country/NGA  0.609366
```

```python
growth = dfo.analysis.growth(aid, by="destination", window=(2018, 2023))
print(growth.to_pandas()[["time_period", "financingRecipient", "value"]])
```

Aid to Kenya rose by 71% over the window. `change="difference"` gives the rise in US dollars.

The top three donors to Ethiopia in 2023, and each donor's share of the five donors' total in each year:

```text
  time_period financingProvider         value
0        2023       country/DEU  2.890000e+08
1        2023       country/GBR  1.398000e+08
2        2023       country/USA  1.287400e+09
  time_period financingProvider      value     unit
0        2018       country/DEU  13.441328  Percent
1        2019       country/DEU  13.377405  Percent
2        2020       country/DEU  13.746245  Percent
```

```python
ethiopia = dfo.search(
    "ODA to Ethiopia from Germany, France, the UK, Japan and the US, 2018 to 2023"
).fetch()

top = dfo.analysis.rank(ethiopia, by="origin", window=(2023, 2023), limit=3)
print(top.to_pandas()[["time_period", "financingProvider", "value"]])

shares = dfo.analysis.share_of(ethiopia, by="origin")
print(shares.to_pandas()[["time_period", "financingProvider", "value", "unit"]].head(3))
```

`by` and `on` name roles, such as `origin`, `destination`, and `place`, as `spec.roles` lists them. The result's columns carry DFO's names for them, such as `financingProvider`.

## Chain steps into a recipe

`dfo.analysis.recipe(start)` describes a chain of the same operations without running it, and `dfo.fetch(recipe)` runs the whole chain on DFO in one request. Each step method takes the function's arguments without the first reading:

```text
recipe(spec_7f535e528a2a527aa54b316d4eccbb6e).filter(keep={'destination': 'country/KEN'}).quotient_of(spec_429926a07022f78c65e0379e8004ae6d, on={'destination': 'place'})
<Dataset Computed by DFO: filter, then quotient_of.
  Source: OECD DAC2A; World Development Indicators
  Derived: filter, then quotient_of by destination, from 2 readings
  Missing data: 1 series left out · data.left_out
  Version: ocv_3b8fb473d0afe5c13c06f3e5407759fc (exact), held until 27 November 2026, not pinned
  Rows: 6, time_period as text, such as "2022" or "2021/2022"
  Keep: data.save(path) · newest later: dfo.fetch(data.ref, latest=True)>
```

```python
chain = (
    dfo.analysis.recipe(aid)
    .filter(keep={"destination": "country/KEN"})
    .quotient_of(people, on={"destination": "place"})
)
print(chain)

kenya_per_person = dfo.fetch(chain)
print(kenya_per_person)
```

A recipe is a value. It does no I/O, needs no client, and checks each argument when the step is added, so a malformed chain fails before any request. `dfo.analysis.rank(data, by="origin")` returns what `dfo.fetch(dfo.analysis.recipe(data).rank(by="origin"))` returns. `chain.tree()` returns the JSON tree the request sends.

`dfo.fetch` takes `latest`, `strict`, and `timeout` with a recipe, and refuses `window`, `entities`, `facets`, `party_totals`, and any layout other than `frame`. Narrow the readings with a `filter` step, or fetch them narrowed before the recipe starts.

## Follow new data and recompute

`dfo.latest_year(offset)` names a year counted back from the newest year at least half the series hold. DFO settles it each time the operation runs, so a window of `(dfo.latest_year(-5), dfo.latest_year())` stays the last six years as sources publish. The repr's `Period` line names the years it settled on:

```text
  Period: 2018 to 2023, counted back from 2023, the newest year at least half the series hold
```

```python
recent = dfo.analysis.growth(
    aid, by="destination", window=(dfo.latest_year(-5), dfo.latest_year())
)
print(repr(recent).splitlines()[3])
```

`latest_year()` is the newest year, and `latest_year(-1)` the year before it. Offsets run from -9999 to 0.

`dfo.fetch(data.ref, latest=True)` computes a derived result again, with the same steps, on the newest versions of its readings. Two refs compare equal when they name the same versions, so a changed ref means new data:

```python
again = dfo.fetch(per_person.ref, latest=True)
if again.ref != per_person.ref:
    print("DFO has newer data, and the figure was computed again")
```

`dfo.fetch(per_person.ref)`, without `latest`, reads the exact version again. DFO holds a derived version until the `held until` date in its repr. After that, the fetch asks DFO to compute it again from the same versions of its readings, and returns it when the result is the same version. When it is not, the fetch raises `VersionUnavailableError`, and `latest=True` computes it on the newest data.

## Save and reload a derived result

`data.save(path)` writes the rows, the citation, the ref, the steps, and the left-out series to one Parquet file, and `dfo.load(path)` reads it back offline:

```python
per_person.save("aid-per-person.parquet")

saved = dfo.load("aid-per-person.parquet")
print(saved.ref == per_person.ref, len(saved.left_out))  # True 3
```

`per_person.ref.to_json()` is the ref alone, which `dfo.DatasetRef.from_json(text)` reads back for `dfo.fetch`. The TypeScript client reads the ref, and its `data.bytes()` writes a file `dfo.load` reads.

`dfo.pin(data)` keeps a dataset's versions fetchable with no time limit, and counts against a daily allowance. It takes dataset versions only, and refuses a derived Dataset before any request, so save the file to keep a derived result for good.

## Find out why series were left out

An operation drops a series it cannot compute, such as a recipient the population reading does not hold. The fetch then issues one `SeriesLeftOutWarning`, the repr's `Missing data` line counts the series, and `data.left_out` lists each one with the step that dropped it and why:

```text
LeftOutSeries(destination=country/GHA: quotient_of dropped 6 rows from data, unmatched_key)
LeftOutSeries(destination=country/NGA: quotient_of dropped 6 rows from data, unmatched_key)
LeftOutSeries(place=country/KEN: quotient_of dropped 4 rows from other, period_unmatched)
```

```python
for series in per_person.left_out:
    print(series)
```

Ghana and Nigeria have no population rows to divide by. Kenya's population covers 2015 to 2024, so the four years without aid figures drop from the `other` side. Each `LeftOutSeries` carries:

- `coordinates`, the columns that name the series, by DFO's column names, such as `{"financingRecipient": "country/GHA"}`. The repr names them by the role the call used.
- `step`, a `LeftOutStep` with the step's `verb` and its `node`, the step's position in the recipe.
- `side`, `data`, or `other` for the second reading of a two-reading step.
- `reason`, one of DFO's data-gap codes below.
- `rows`, the number of the series' rows the step dropped.

| `reason`                     | The step dropped the series because                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `endpoint_missing`           | Growth found no value in the window's first year or its last                          |
| `zero_or_sign_crossing_base` | A relative growth's first value is zero, or the value changes sign                    |
| `non_finite`                 | The change worked out to a number too large to hold                                   |
| `unmatched_key`              | The other reading holds no row for this member; `side` names the reading that held it |
| `period_unmatched`           | The two readings share no year for this member, or hold some of its years on one side |
| `zero_denominator`           | A quotient's other reading sums to zero                                               |
| `unit_unbound`               | The rows declare no unit, so the step could not check that both readings share one    |

A newer DFO can send a code this table lacks. `Missing data: at least N series left out` means DFO capped its list, and `left_out` holds the series it named.

To stop on any dropped series, pass `strict=True`, which raises the warning:

```python
from dfo.errors import SeriesLeftOutWarning

try:
    dfo.analysis.quotient_of(aid, people, on={"destination": "place"}, strict=True)
except SeriesLeftOutWarning as error:
    print(error.code)  # series_left_out
```

`warnings.filterwarnings("ignore", category=SeriesLeftOutWarning)` silences the warning for a run that expects the gaps.

## Reference

### `dfo.analysis`

Each function takes its readings as positional arguments and the rest by keyword. Each also takes `strict=False` and `timeout=None`, and returns a `Dataset`. `client.analysis` on a `Client` or `AsyncClient` has the same methods, less `recipe`.

| Name          | Signature                                                 |
| ------------- | --------------------------------------------------------- |
| `filter`      | `filter(data, /, *, keep)`                                |
| `aggregate`   | `aggregate(data, /, *, by=(), how="sum")`                 |
| `growth`      | `growth(data, /, *, by=(), window, change="relative")`    |
| `rank`        | `rank(data, /, *, by, window=None, how=None, limit=None)` |
| `quotient_of` | `quotient_of(data, other, /, *, on=None)`                 |
| `share_of`    | `share_of(data, total=None, /, *, by=None, on=None)`      |
| `sum_of`      | `sum_of(data, other, /, *, on=None)`                      |
| `compare`     | `compare(data, other, /, *, on=None)`                     |
| `join`        | `join(data, other, /, *, on=None)`                        |
| `recipe`      | `recipe(start, /) -> Recipe`                              |

- `data`, `other`, and `total` take a `Spec`, a `DatasetRef`, a `Dataset`, or a `Recipe` holding one reading. DFO refuses a Dataset or ref of several members with `several_members`.
- `keep` maps each role or column to a value or a list of values.
- `by` takes a role or column name, or a list of them.
- `window` takes `(start, end)`, each a year from 1000 to 9999 or a `dfo.latest_year(offset)`.
- `on` takes a mapping of a role of `data` to the role of `other` that holds the same places, such as `{"destination": "place"}`, or a role or list of roles both name alike. Left out, DFO pairs the roles both readings name alike.
- `share_of` needs `total` or `by`, and `by` with `on` needs `total`.
- `how` takes `"sum"`, `"mean"`, `"max"`, or `"min"`. `change` takes `"relative"` or `"difference"`.

The client checks these before any request and raises `InvalidRequestError` with `invalid_argument`. DFO checks the rest, such as whether two units can be compared, and its refusal names the fix in `error.problem["fix"]` when it has one.

### `Recipe`

`dfo.types.Recipe`, from `dfo.analysis.recipe(start)`. It has the nine step methods, each taking the function's arguments without the first reading and returning a recipe one step longer, and `tree()`, the JSON tree `dfo.fetch` sends. Its repr prints the chain as called, each reading by its spec id. Two recipes that send the same tree compare equal and hash alike. A recipe with no step is refused unless it starts from a derived ref.

### `dfo.latest_year`

`dfo.latest_year(offset=0) -> LatestYear`. The year `offset` years before the newest year at least half the series hold, settled each time an operation or card runs. `dfo.types.LatestYear` prints as `latest_year(-4)`. An offset outside -9999 to 0 raises `InvalidRequestError`.

### Derived datasets

A `Dataset` an operation returns has one `DerivedMember` in `members`, and its ref one `DerivedRefMember`, whose `spec_id` starts `ops_` and `content_version` `ocv_`. Its repr adds a `Derived` line with the steps in run order and the number of readings, a `Period` line with the years `latest_year` settled on, and a `Missing data` line with the count of series left out.

`data.left_out` is a tuple of `dfo.types.LeftOutSeries`, empty when no step dropped a series.

`dfo.fetch(ref)` reads a derived ref's exact version, and `dfo.fetch(ref, latest=True)` computes its recipe again on the newest data. A ref of several derived members raises `InvalidRequestError` before any request.

### `dfo.pin`

`dfo.pin(data, /) -> Dataset`, also `client.pin`. Keeps every version a Dataset holds fetchable with no time limit and returns the Dataset marked pinned. A pin cannot be undone. A derived Dataset raises `InvalidRequestError` (`invalid_argument`) before any request, and a spent daily allowance raises `QuotaExceededError` (`allowance_exhausted`) with `retry_after`.

### `SeriesLeftOutWarning`

`dfo.errors.SeriesLeftOutWarning`, a `DfoWarning` with the code `series_left_out`. One per fetch of a derived Dataset that left series out. `strict=True` raises it.

## Next

- [Cards and shares](shares.md) publishes a derived result as a chart, a table, or a headline number.
- [Datasets and versions](datasets.md) covers refs, retention, and the files `save` writes.
