# Compute a figure on DFO

`client.analysis` runs DFO's operations, such as a growth rate, a ranking, or aid per person, on the server and returns the result as a `Dataset`. DFO keeps that result as a derived version with a ref of its own, so you can fetch it again, compute it again on newer data, or draw it as a card.

The examples on this page form one program. Each block after the first continues it.

## Compute a figure

Each method of `client.analysis` takes the data to work on and returns the result. Divide German aid by Kenya's population to get aid per person:

```text
<Dataset Computed by DFO: quotient_of.
  Source: OECD DAC2A; World Development Indicators
  Derived: quotient_of by destination, from 2 readings
  Missing data: 3 series left out · data.leftOut
  Version: ocv_129d9b2f36f398bb414c5f7a97230804 (exact), held until 27 November 2026, not pinned
  Rows: 6, time_period as text, such as "2022" or "2021/2022"
  Keep: JSON.stringify(data.ref) · newest later: client.fetch(data.ref, { latest: true })>
[ '2018', 'country/KEN', 3.6476329751700383 ]
```

```ts
import { Client, DatasetRef, latestYear, recipe } from "@developmentfinance/client";
import { SeriesLeftOutWarning } from "@developmentfinance/client/errors";

const client = new Client();
const aid = await (
  await client.search("ODA from Germany to Kenya, Ghana and Nigeria, 2018 to 2023")
).fetch();
const people = await (await client.search("Kenya population, 2015 to 2024")).fetch();

const perPerson = await client.analysis.quotientOf(aid, people, { on: { destination: "place" } });
console.log(String(perPerson));
const [first] = await perPerson.toRows();
console.log([first?.["time_period"], first?.["financingRecipient"], first?.["value"]]);
```

`on` pairs the roles of the two readings that hold the same places: the aid's `destination` with the population's `place`. The population covers Kenya alone, so DFO leaves Ghana and Nigeria out, counts them in the `Missing data` line, and the call passes a `SeriesLeftOutWarning` to `onWarning`, which prints it by default. The gaps are expected here. [Find out why series were left out](#find-out-why-series-were-left-out) reads the list, and `strict: true` stops on it.

Every method takes a `Spec`, a `DatasetRef`, a `Dataset`, or a `Recipe` as its data. A `Dataset` or ref sends its exact version, and a `Spec` sends the newest version without party totals, as `client.fetch(spec)` reads it. DFO builds any version it has not built yet, then computes. The call waits as long as that takes unless you pass `timeout` in milliseconds or a `signal`, or the client has a `timeout` of its own.

A derived frame's `time_period` is a string, such as `"2022"`, or `"2018/2023"` for a value that spans years, as `growth` writes. A dataset in the long layout holds integer years as numbers, and one in the frame layout holds strings.

The result's `unit` column holds a unit id, such as `CurrencyUSD`, or, for a composed unit, its JSON text. Aid per person has the unit `{"denominator":{"stat_var":"dcid:Count_Person"},"numerator":"CurrencyUSD"}`, US dollars per person. A relative growth has no unit, and its `unit` is null.

## Pick the operation

Each operation states its result on its own scale:

| Method                              | Result                                                                                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `filter(data, { keep })`            | The rows whose role or column holds one of the values, as `{ keep: { destination: "country/KEN" } }`                                                                                                         |
| `aggregate(data, { by, how })`      | One value per year for each member of `by`, by `sum` (the default), `mean`, `max`, or `min`, in the data's unit                                                                                              |
| `growth(data, { by, window })`      | The change from the first year to the last. `change: "relative"`, the default, is a fraction with no unit: 0.25 is a 25% rise. `change: "difference"` is the last value minus the first, in the data's unit  |
| `rank(data, { by, window, limit })` | The members of `by`, largest first, the top `limit` kept (1 to 1000). A tie at the last place keeps every member that shares it                                                                              |
| `quotientOf(data, other, { on })`   | `data` divided by `other`, in a composed unit                                                                                                                                                                |
| `shareOf(data, total, { by, on })`  | Each value as a percentage of its total, 0 to 100 when each value is part of the total: 25 is a quarter. With no total, `shareOf(data, { by })` divides by the sum over the members of `by` in the same year |
| `sumOf(data, other, { on })`        | The matching rows of both readings added, over the years both hold                                                                                                                                           |
| `compare(data, other, { on })`      | `data` minus `other` for each matching member, over the years both hold. DFO refuses two different units                                                                                                     |
| `join(data, other, { on })`         | Both readings' rows in one long frame, told apart by `stat_var`                                                                                                                                              |

The growth of German aid to each recipient from 2018 to 2023:

```text
[
  [ '2018/2023', 'country/GHA', '0.371455' ],
  [ '2018/2023', 'country/KEN', '0.714912' ],
  [ '2018/2023', 'country/NGA', '0.609366' ]
]
```

```ts
const growth = await client.analysis.growth(aid, { by: "destination", window: [2018, 2023] });
console.log(
  (await growth.toRows()).map((row) => [
    row["time_period"],
    row["financingRecipient"],
    Number(row["value"]).toFixed(6),
  ]),
);
```

Aid to Kenya rose by 71% over the window. `change: "difference"` gives the rise in US dollars.

`by` and `on` name roles, such as `origin`, `destination`, and `place`, as `specRoles(spec)` lists them. The result's columns carry DFO's names for them, such as `financingRecipient`.

## Chain steps into a recipe

`recipe(start)` describes a chain of the same operations without running it, and `client.fetch(recipe)` runs the whole chain on DFO in one request. Each step method takes the method's options without the first reading:

```text
recipe(spec_7f535e528a2a527aa54b316d4eccbb6e).filter({ keep: { destination: "country/KEN" } }).quotientOf(spec_429926a07022f78c65e0379e8004ae6d, { on: { destination: "place" } })
<Dataset Computed by DFO: filter, then quotient_of.
  Source: OECD DAC2A; World Development Indicators
  Derived: filter, then quotient_of by destination, from 2 readings
  Missing data: 1 series left out · data.leftOut
  Version: ocv_3b8fb473d0afe5c13c06f3e5407759fc (exact), held until 27 November 2026, not pinned
  Rows: 6, time_period as text, such as "2022" or "2021/2022"
  Keep: JSON.stringify(data.ref) · newest later: client.fetch(data.ref, { latest: true })>
```

```ts
const chain = recipe(aid)
  .filter({ keep: { destination: "country/KEN" } })
  .quotientOf(people, { on: { destination: "place" } });
console.log(String(chain));

const kenyaPerPerson = await client.fetch(chain);
console.log(String(kenyaPerPerson));
```

A recipe is a value. It does no I/O, needs no client, and checks each option when the step is added, so a malformed chain fails before any request. `client.analysis.rank(data, { by: "origin" })` returns what `client.fetch(recipe(data).rank({ by: "origin" }))` returns.

`client.fetch` takes `latest`, `strict`, `timeout`, and `signal` with a recipe, as `RecipeFetchOptions` types them, and refuses `onProgress`, the options that narrow a spec, `partyTotals`, and any layout other than `frame`. Narrow the readings with a `filter` step, or fetch them narrowed before the recipe starts.

## Follow new data and recompute

`latestYear(offset)` names a year counted back from the newest year at least half the series hold. DFO settles it each time the operation runs, so a window of `[latestYear(-5), latestYear()]` stays the last six years as sources publish. The text form's `Period` line names the years it settled on:

```text
  Period: 2018 to 2023, counted back from 2023, the newest year at least half the series hold
```

```ts
const recent = await client.analysis.growth(aid, {
  by: "destination",
  window: [latestYear(-5), latestYear()],
});
console.log(String(recent).split("\n")[3]);
```

`latestYear()` is the newest year, and `latestYear(-1)` the year before it. Offsets run from -9999 to 0.

`client.fetch(ref, { latest: true })` computes a derived result again, with the same steps, on the newest versions of its readings. `ref.equals` tells whether the data changed. Save the ref as JSON to do this in a later process:

```ts
const saved = JSON.stringify(perPerson.ref);

const again = await client.fetch(DatasetRef.fromJSON(saved), { latest: true });
if (!again.ref.equals(perPerson.ref)) {
  console.log("DFO has newer data, and the figure was computed again");
}
```

A changed ref can still hold the same numbers, after an engine release or a rebuild of a reading that moved no value. `again.ref.sameData(perPerson.ref)` compares what the two refs hold: two derived results with the same rows under the same variables compare as the same data, whichever recipe made them.

`client.fetch(ref)`, without `latest`, reads the exact version again. DFO holds a derived version until the `held until` date in its text form. After that, the fetch asks DFO to compute it again from the same versions of its readings, and returns it when the result is the same version. When it is not, the fetch raises `VersionUnavailableError`, and `{ latest: true }` computes it on the newest data.

`await data.toBytes()` returns the rows as one Parquet file with the ref, the steps, and the left-out series, which the Python client's `dfo.load` reads, and on Node `await data.save(path)` writes that file. `client.pin(data)` keeps a dataset version fetchable for good, and refuses a derived dataset before any request.

## Find out why series were left out

An operation drops a series it cannot compute, such as a recipient the population reading does not hold. The fetch then passes one `SeriesLeftOutWarning` to `onWarning`, the text form's `Missing data` line counts the series, and `data.leftOut` lists each one with the step that dropped it and why:

```text
LeftOutSeries(destination=country/GHA: quotient_of dropped 6 rows from data, unmatched_key)
LeftOutSeries(destination=country/NGA: quotient_of dropped 6 rows from data, unmatched_key)
LeftOutSeries(place=country/KEN: quotient_of dropped 4 rows from other, period_unmatched)
```

```ts
for (const series of perPerson.leftOut) console.log(String(series));
```

Ghana and Nigeria have no population rows to divide by. Kenya's population covers 2015 to 2024, so the four years without aid figures drop from the `other` side. Each `LeftOutSeries` carries:

- `coordinates`, the columns that name the series, by DFO's column names, such as `{ financingRecipient: "country/GHA" }`. The text form names them by the role the call used.
- `step`, the step's `verb` and its `node`, the step's position in the recipe.
- `side`, `data`, or `other` for the second reading of a two-reading step.
- `reason`, one of DFO's data-gap codes below.
- `rows`, the number of the series' rows the step dropped.

| `reason`                     | The step dropped the series because                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `endpoint_missing`           | Growth found no value in the window's first year or its last                          |
| `zero_or_sign_crossing_base` | A relative growth's first value is zero, or the value changes sign                    |
| `non_finite`                 | The change worked out to a number too large to hold                                   |
| `unmatched_key`              | The other reading holds no row for this member. `side` names the reading that held it |
| `period_unmatched`           | The two readings share no year for this member, or hold some of its years on one side |
| `zero_denominator`           | A quotient's other reading sums to zero                                               |
| `unit_unbound`               | The rows declare no unit, so the step could not check that both readings share one    |

A newer DFO can send a code this table lacks. `Missing data: at least N series left out` means DFO capped its list, and `leftOut` holds the series it named.

To stop on any dropped series, pass `strict: true`, which throws the warning:

```text
SeriesLeftOutWarning series_left_out
```

```ts
try {
  await client.analysis.quotientOf(aid, people, { on: { destination: "place" }, strict: true });
} catch (error) {
  if (!(error instanceof SeriesLeftOutWarning)) throw error;
  console.log(error.name, error.code);
}
```

## Reference

### `client.analysis`

Each method returns a `Promise<Dataset>`, and takes `strict`, `timeout` in milliseconds, and `signal` beside its own options.

| Method       | Signature                                                            |
| ------------ | -------------------------------------------------------------------- |
| `filter`     | `filter(data, { keep })`                                             |
| `aggregate`  | `aggregate(data, { by?, how? })`                                     |
| `growth`     | `growth(data, { by?, window, change? })`                             |
| `rank`       | `rank(data, { by, window?, how?, limit? })`                          |
| `quotientOf` | `quotientOf(data, other, { on? })`                                   |
| `shareOf`    | `shareOf(data, { by, on? })` or `shareOf(data, total, { by?, on? })` |
| `sumOf`      | `sumOf(data, other, { on? })`                                        |
| `compare`    | `compare(data, other, { on? })`                                      |
| `join`       | `join(data, other, { on? })`                                         |

- `data`, `other`, and `total` take a `Spec`, a `DatasetRef`, a `Dataset`, or a `Recipe` holding one reading. DFO refuses a dataset or ref of several members with `several_members`.
- `keep` maps each role or column to a value or an array of values.
- `by` takes a role or column name, or an array of them.
- `window` takes `[start, end]`, each a year from 1000 to 9999 or a `latestYear(offset)`.
- `on` takes an object mapping a role of `data` to the role of `other` that holds the same places, such as `{ destination: "place" }`, or a role or array of roles both name alike. Left out, DFO pairs the roles both readings name alike.
- `how` takes `"sum"`, `"mean"`, `"max"`, or `"min"`. `change` takes `"relative"` or `"difference"`.

The client checks these before any request and raises `InvalidRequestError` with `invalid_argument`. DFO checks the rest, such as whether two units can be compared.

### `recipe` and `Recipe`

`recipe(start)` returns a `Recipe` with the nine step methods, each taking the method's options without the first reading and returning a recipe one step longer, and `tree()`, the JSON tree `client.fetch` sends. `String(recipe)` prints the chain as called, each reading by its spec id. A recipe with no step is refused unless it starts from a derived ref.

### `latestYear` and `LatestYear`

`latestYear(offset = 0)` returns a `LatestYear`, the year `offset` years before the newest year at least half the series hold, settled each time an operation or card runs. It prints as `latestYear(-4)`. An offset outside -9999 to 0 raises `InvalidRequestError`.

### Derived datasets

A dataset an operation returns has one `DerivedMember` in `members`, and its ref one `DerivedRefMember`, whose `spec.spec_id` starts `ops_` and `contentVersion` `ocv_`. Its text form adds a `Derived` line with the steps in run order and the number of readings, a `Period` line with the years `latestYear` settled on, and a `Missing data` line with the count of series left out. `data.leftOut` is an array of `LeftOutSeries`, empty when no step dropped a series. A ref of several derived members raises `InvalidRequestError` before any request.

### `client.pin`

`client.pin(data)` returns `Promise<Dataset>`. It keeps every version a dataset holds fetchable with no time limit and returns the dataset marked pinned. A pin cannot be undone. A derived dataset raises `InvalidRequestError` (`invalid_argument`) before any request, and a spent daily allowance raises `QuotaExceededError` (`allowance_exhausted`) with `retryAfterMs`. A pin that fails part-way leaves the versions before the failing one pinned, and its error names them in its message and in `pinned`.

### `SeriesLeftOutWarning`

A `DfoWarning` with the code `series_left_out`, passed to `onWarning` once per fetch of a derived dataset that left series out. `strict: true` throws it.

## Next

- [Cards and shares](shares.md) publishes a derived result as a chart, a table, or a headline number.
- [Use it in a web app](web-apps.md) runs these calls from a server route.
