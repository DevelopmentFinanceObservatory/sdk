# @developmentfinance/client

Ask the Development Finance Observatory a question in words and get the data that answers it, with its sentence, source and version.

```bash
npm install @developmentfinance/client
```

The package is ESM only. Everything imports from the package root except `toArrow`, which comes from `@developmentfinance/client/arrow`. It runs on Node 22.18 and later, Bun, Deno, Workers and browsers. `toArrow` needs the optional `apache-arrow` package (`npm install apache-arrow`).

## Ask a question and get the data

```text
Germany's gross ODA disbursements to Nigeria for basic health care, 1995 to 2024. Current US dollars · OECD Creditor Reporting System (CRS).
  Fetch: answer.fetch()
30 time_period, financingProvider_label, financingRecipient_label, crsPurpose_label
30
```

```ts
import { Client } from "@developmentfinance/client";
import { toArrow } from "@developmentfinance/client/arrow";

const client = new Client();
const answer = await client.search(
  "ODA disbursements from Germany to Nigeria for basic health care",
);
console.log(String(answer));

const data = await answer.fetch();
console.log(data.rowCount, data.columns.slice(0, 4).join(", "));
const table = await toArrow(data);
console.log(table.numRows);
```

`String(answer)` is Search's sentence and the next call to make. `answer.fetch()` builds the table and returns a `Dataset`: `rowCount`, `columns`, `toRows()` for plain objects, `toArrow(data)` for an Arrow table, and `bytes()` for one Parquet file that the Python client's `dfo.load` reads. Every table comes in reading order. The columns start with the year, the provider, the recipient, the subject, the purpose, the value, the unit, the flow type and the source, as the table holds them, then the columns whose values tell the rows apart, then those that hold one value throughout, with `stat_var` last and `part` first when several readings stack. The rows sort by those columns, with each series' years together. Without a key the client calls the API anonymously. [Keys and base URL](#keys-and-base-url) covers the rest.

## Choose a reading

A part of a question can have several readings. The answer then lists them, and `fetch` stops with an `IncompleteAnswerError` until you choose:

```text
Answered 1 of 2 parts of your question.
  answered "health spending": Kenya's health expenditure per capita in international dollars, 2000 to 2023. World Development Indicators.
  missing  "education spending": 2 readings
    [0] Kenya's percent of nominal GDP spent on education, 1971 to 2024 · World Development Indicators
    [1] Kenya's percent of total government expenditure on education, 1980 to 2025 · World Development Indicators
  Choose: (await answer.choose(0)).fetch()
  Or take the answered part: answer.fetch({ partial: true })
Kenya's health expenditure per capita in international dollars, 2000 to 2023. World Development Indicators. Kenya's percent of nominal GDP spent on education, 1971 to 2024. World Development Indicators.
```

```ts
import { Client } from "@developmentfinance/client";

const client = new Client({ onWarning: () => {} });
const answer = await client.search("health spending and education spending in Kenya");
console.log(String(answer));

const chosen = await answer.choose(0);
const data = await chosen.fetch();
console.log(data.sentence);
```

`choose` takes the option's index, its label, or its line as `String(answer)` prints it, such as `"Kenya's percent of nominal GDP spent on education, 1971 to 2024 · World Development Indicators"`, and returns Search's answer for that reading. When several parts await a choice, name the part: `answer.choose(0, { part: "education spending" })`. A label or part that names nothing raises `InvalidRequestError` with the code `choice_invalid`, the nearest match and the valid choices. `answer.gaps` holds the same choices as data, for a page that draws its own buttons: each gap's `options` carry a `label`.

## Narrow a fetch

`client.fetch(spec, options)` builds one of the answer's readings, `answer.specs[0]` here, with a narrower window, other places, or a fixed facet:

```text
{ destination: [ 'country/NGA' ], origin: [ 'country/DEU' ] }
Germany's gross ODA disbursements to Nigeria for basic health care, 2015 to 2020. Current US dollars · OECD Creditor Reporting System (CRS).
4
Germany's gross ODA disbursements to Ghana for basic health care, 2003 to 2023. Current US dollars · OECD Creditor Reporting System (CRS).
5
```

```ts
import { Client, specRoles } from "@developmentfinance/client";

const client = new Client({ onWarning: () => {} });
const answer = await client.search(
  "ODA disbursements from Germany to Nigeria for basic health care",
);
const [spec] = answer.specs;
if (spec === undefined) throw new Error(`Search found nothing to fetch:\n${answer}`);
console.log(specRoles(spec));

const recent = await client.fetch(spec, { window: [2015, 2020] });
const ghana = await client.fetch(spec, { entities: { destination: ["country/GHA"] } });
console.log(recent.sentence);
console.log(recent.rowCount);
console.log(ghana.sentence);
console.log(ghana.rowCount);
```

- `window` is `"all"`, `"latest"` or `[startYear, endYear]`.
- `entities` rebinds a role by the key the spec uses, here `origin` and `destination`. `specRoles(spec)` lists the keys, each with the dcids it binds, or `null` for a flow direction it binds none of. A role you leave out keeps its places, and `null` unbinds one. A key the spec does not take, such as the column name `financingRecipient`, raises `InvalidRequestError` with `invalid_argument` and the spec's roles, before any request.
- `facets` binds an axis, such as `{ provenance: "provenance/OECDCreditorReportingSystem" }`.
- `partyTotals: true` keeps the rows of totals such as "DAC countries" beside their members. They are left out by default, so a sum over `value` counts each flow once.

`answer.fetch` takes the same `window`, `entities` and `facets` and narrows every reading, as `answer.fetch({ window: [2015, 2020] })`. A role that one reading does not take is refused before any request, with each reading's roles.

A narrowing that holds no data returns an empty `Dataset` under Search's no-data sentence, with an `empty_result` warning. An option the call does not take raises `InvalidRequestError` with `invalid_argument` and names the nearest one, so `party_totals` points you to `partyTotals`.

Party totals change the sum. For Ethiopia in 2022, 110 providers report, and 15 of them are totals:

```text
95 110
```

```ts
import { Client } from "@developmentfinance/client";

const client = new Client({ onWarning: () => {} });
const answer = await client.search("top 5 donors to Ethiopia in 2022");

const members = await answer.fetch();
const withTotals = await answer.fetch({ partyTotals: true });
console.log(members.rowCount, withTotals.rowCount);
```

## Stop a call

Every call that goes to the server takes a `signal` and a `timeout` in milliseconds. `search` stops after 60 seconds by default. `fetch` waits as long as the build takes, showing progress to `onProgress`, unless you give it a `timeout`.

```text
TimeoutError
DfoTimeoutError deadline_exceeded
```

```ts
import { Client, DfoTimeoutError } from "@developmentfinance/client";

const client = new Client();

try {
  await client.search("GDP of Kenya", { signal: AbortSignal.timeout(50) });
} catch (error) {
  if (error instanceof DOMException) console.log(error.name);
}

try {
  await client.search("GDP of Kenya", { timeout: 50 });
} catch (error) {
  if (error instanceof DfoTimeoutError) console.log(error.name, error.code);
}
```

An aborted signal rejects with its own `reason`, untouched. A `timeout` raises `DfoTimeoutError` with the code `deadline_exceeded`. A fetch stopped either way leaves its build running on the server, and the same fetch made again joins it:

```text
DfoTimeoutError: The build is still running on the server after 3 s. The same fetch joins it if one started. [deadline_exceeded]
```

A large build reports progress while it runs. A version the server has built before comes back at once, with none:

```text
{"rowsWritten":0,"estimateRows":56061}
{"rowsWritten":0,"estimateRows":56061}
{"rowsWritten":0,"estimateRows":56061}
{"rowsWritten":0,"estimateRows":56061}
{"rowsWritten":0,"estimateRows":56061}
{"rowsWritten":0,"estimateRows":56061}
{"rowsWritten":0,"estimateRows":56061}
{"rowsWritten":0,"estimateRows":56061}
{"rowsWritten":0,"estimateRows":56061}
{"rowsWritten":0,"estimateRows":56061}
{"rowsWritten":0,"estimateRows":56061}
{"rowsWritten":56061,"estimateRows":56061}
56061
```

```ts
import { Client } from "@developmentfinance/client";

const client = new Client({ onWarning: () => {} });
const answer = await client.search(
  "CRS commitments from every donor to every recipient for agriculture, 2011 to 2019",
);
const data = await answer.fetch({
  onProgress: ({ progress }) => console.log(JSON.stringify(progress)),
});
console.log(data.rowCount);
```

## Keep a dataset and refresh it

`data.ref` names the exact versions a dataset holds. Save it as JSON, and `client.fetch(ref)` returns those versions again. `{ latest: true }` builds the newest version of the same reading, and `ref.equals` tells you whether the data changed:

```text
<Dataset Kenya's GDP, 1960 to 2025. Current US dollars · World Development Indicators.
  Source: World Development Indicators
  Version: cv_00f3d36b33447b0675e100ebc84120ee (exact), pinned
  Rows: 66
  Keep: JSON.stringify(data.ref) · newest later: client.fetch(data.ref, { latest: true })>
DatasetRef(1 member: spec_b5673e60c045b10f8beeed2ce50dbd18 at cv_00f3d36b33447b0675e100ebc84120ee, exact)
unchanged
```

```ts
import { Client, DatasetRef } from "@developmentfinance/client";

const client = new Client();
const data = await (await client.search("GDP of Kenya")).fetch();
console.log(String(data));
const saved = JSON.stringify(data.ref);

const ref = DatasetRef.fromJSON(saved);
console.log(String(ref));
const newest = await client.fetch(ref, { latest: true });
console.log(newest.ref.equals(ref) ? "unchanged" : "new data");
```

`equals` compares specs, versions and renderings, and leaves out file digests, which change when the server renders the same version again. The ref format is shared with the Python client, so a ref saved by one reads in the other. A ref keeps the `partyTotals` choice it was fetched with, and refuses a narrowing. A version the server can no longer build raises `VersionUnavailableError`, and `{ latest: true }` fetches the current one.

## Save an answer and revive it

`JSON.stringify(answer)` writes the answer, and `Answer.fromJSON(value, client)` reads it back, so a choice can arrive in a later request:

```text
Answered 0 of 1 part of your question.
  missing  "government education spending": 2 readings
    [0] Kenya's percent of total government expenditure on education, 1980 to 2025 · World Development Indicators
    [1] Kenya's percent of nominal GDP spent on education, 1971 to 2024 · World Development Indicators
  Choose: (await answer.choose(0)).fetch()
Kenya's percent of total government expenditure on education, 1980 to 2025. World Development Indicators.
```

```ts
import { Answer, Client } from "@developmentfinance/client";

const client = new Client();
const answer = await client.search("government education spending Kenya");
const saved = JSON.stringify(answer);

const revived = Answer.fromJSON(saved, client);
console.log(String(revived));
const data = await (await revived.choose(0)).fetch();
console.log(data.sentence);
```

`fromJSON` checks that the JSON is well formed. It cannot tell whether it came from Search. `choose` and `fetch` post what the answer holds, so a forged answer can send any spec or parsed question to the API under your key. With a public-tier key that costs quota, as a question route does, so rate-limit both per visitor. With a key scoped beyond the public tier, keep the answer on the server under a random id and send the page the id. [Use it in a web app](docs/web-apps.md) does that.

## Look up names and codes

`client.lookup` resolves names to graph nodes, reads a node by its id, explains a server code, and lists what Search holds data on. Each result prints as one line:

```text
Kenya -> Kenya  country/KEN  (country)
Congo -> ambiguous: Congo [DRC]  country/COD | Congo [Republic]  country/COG
Germny -> not found; nearest: Germany  country/DEU
not_found country/DEU
Nigeria  country/NGA  (country)  types: Country [ 'Sub-Saharan Africa', 'Western Africa', 'Africa' ]
role_incompatible: The role is a real property, but the resolved StatVar does not declare it.
7 publishers, 12,437 variables; 5 example questions, such as "ODA to Nigeria since 2015"
ODA to Nigeria since 2015
```

```ts
import { Client } from "@developmentfinance/client";

const client = new Client();
for (const match of await client.lookup.resolve(["Kenya", "Congo", "Germny"])) {
  console.log(`${match}`);
}

const [germny] = await client.lookup.resolve("Germny");
console.log(germny?.status, germny?.nearMatches[0]?.dcid);

const nigeria = await client.lookup.node("country/NGA");
const regions = nigeria.raw.kind === "country" ? nigeria.raw.country.contained_in : [];
console.log(`${nigeria}`, regions.map((region) => region.label));

console.log(`${await client.lookup.code("role_incompatible")}`);

const catalogue = await client.lookup.catalogue({ place: "country/NGA" });
console.log(`${catalogue}`);
console.log(catalogue.examples[0]);
```

`resolve` returns one `Match` per name, in order. A match holds the name as asked in `text`, its `status` (`resolved`, `ambiguous`, `not_found` or `not_held`), the node it resolved to in `entity`, the nodes an ambiguous name may mean in `candidates`, and names close to one in `nearMatches`. Each node is an `Entity` with a `dcid`, a `name` and a `kind`. `node` returns a `Node` with `dcid`, `name`, `kind` and `types`, `code` a `Code` with `code` and `definition`, and `catalogue` a `Catalogue` with its `version`, `counts` and example questions in `examples`. Every result keeps what the server sent for it in `raw`, which holds the country's regions above.

## Errors

A refusal, a failed connection, a passed deadline or a response the client cannot read raises a `DfoError`. Its message ends with the code and the trace id, `[code · trace id]`, which is what to quote when you report a fault:

```text
NotFoundError code_not_found
No registry entry exists for code 'no_such_code'. [code_not_found · trace a44dc8b1e0624e1aab2e7e3b9739492a]
```

```ts
import { Client, NotFoundError } from "@developmentfinance/client";

const client = new Client();
try {
  await client.lookup.code("no_such_code");
} catch (error) {
  if (!(error instanceof NotFoundError)) throw error;
  console.log(error.name, error.code);
  console.log(error.message);
}
```

Branch on the class, or on `error.code` for one case. Each error also carries `status`, `detail`, `traceId`, `retryable` and `retryAfterMs`. `isDfoError(error)` recognises one from any copy of the package.

| Class                     | Raised when                                                                   |
| ------------------------- | ----------------------------------------------------------------------------- |
| `InvalidRequestError`     | An argument breaks a rule; `issues` and `alternatives` name the valid values  |
| `IncompleteAnswerError`   | You fetch an answer with a part that has no reading; `gaps` lists them        |
| `DeclinedError`           | You fetch an answer Search declined; `answer.reason` says why                 |
| `NotFoundError`           | A spec, place, code or version is unknown                                     |
| `VersionUnavailableError` | A ref's version can no longer be built; `newestVersion` names the current one |
| `AuthenticationError`     | The key is malformed, unknown, revoked or expired, or the credentials file is broken |
| `PermissionDeniedError`   | The key lacks a scope                                                         |
| `RateLimitError`          | Too many requests; `retryAfterMs` says how long to wait                       |
| `QuotaExceededError`      | The key's quota is spent                                                      |
| `DfoTimeoutError`         | A `timeout` passed (`deadline_exceeded`)                                      |
| `NetworkError`            | The connection failed                                                         |
| `ServerError`             | The server failed; retried before you see it                                  |
| `ContractError`           | A response the client cannot act on; upgrade the package                      |

`client.lookup.code(code)` explains a code the server sends. The client raises these itself: `answer_declined`, `answer_incomplete`, `base_url_invalid`, `choice_invalid`, `contract_violation`, `credentials_file_invalid`, `credentials_file_unreadable`, `deadline_exceeded`, `digest_mismatch`, `download_failed`, `header_invalid`, `insecure_transport`, `invalid_argument`, `key_empty`, `key_invalid`, `network_error`, `offline`, `profile_not_found`, `profile_without_key`, `refusal_without_code`, `response_too_large`, `unexpected_response` and `version_unavailable`.

Some faults raise other errors. An aborted call rejects with its signal's `reason`. A `strict` fetch throws its first `SearchWarning` or `DataWarning` in place of passing it to `onWarning`. `DatasetRef.fromJSON` and `Answer.fromJSON` throw a `FormatError` for JSON in the wrong format, and `new Client()` throws a `TypeError` for a secret key in a browser.

## Use it in a web app

Run the client on your server and keep the key there. [Use it in a web app](docs/web-apps.md) builds a route that answers a question from a page, streams build progress as NDJSON, stops under the platform's time limit, and joins the build when the page posts again.

A page can also call the API itself with a publishable `dfo_p_` key. In a browser page or worker the client refuses a secret `dfo_k_` key, which every visitor could read, with a `TypeError`.

## Keys and base URL

`new Client()` reads `DFO_BASE_URL` for the API, else uses `https://developmentfinance.org/api/v1`. It takes the first key it finds: the `apiKey` option, the `DFO_API_KEY` environment variable, then the credentials file that the Python client's `dfo auth login` writes (`~/.config/dfo/credentials.toml`, or the file `DFO_CREDENTIALS_FILE` names), read on Node only. Without one it calls the API anonymously.

```ts
import { Client } from "@developmentfinance/client";

const client = new Client({
  apiKey: false,
  headers: { "User-Agent": "aid-dashboard/1.4" },
});
console.log(String(client));
```

Every request to the API carries `X-DFO-Client`, which names the client and its runtime, such as `dfo-ts/0.1.0 (Node 22.18)` or `dfo-ts/0.1.0 (browser)`. A header of that name in `headers` or from `headerProvider`, in any letter case, raises `InvalidRequestError` with `header_invalid`. A download from the storage host carries none of the client's headers.

The constructor also takes `fetch`, `timeout` (one request attempt, 30 seconds by default), `maxRetries` (2 by default), `headerProvider`, `onWarning` and `dangerouslyAllowBrowser`. A key travels only over https, or plain http to a loopback host. `client.withOptions({ timeout, maxRetries })` returns a copy with other limits, and `client.request(method, path, options)` reaches a route the client does not wrap, with the client's key and retries.

MIT licence, see [LICENSE](LICENSE).
