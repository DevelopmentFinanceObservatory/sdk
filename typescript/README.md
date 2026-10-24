# @developmentfinance/client

TypeScript client for the Development Finance Observatory APIs at [developmentfinance.org](https://developmentfinance.org).

```bash
npm install @developmentfinance/client
```

The package is ESM only and runs on Node 22.18 and later, Bun, Deno, Workers and browsers.

## Usage

Every call goes through a `Client`. Ask a question, then fetch the data it reads as:

```ts
import { Client, DatasetRef, IncompleteAnswerError } from "@developmentfinance/client";

const client = new Client();
const answer = await client.search(
  "ODA disbursements from Germany to Nigeria for basic health care",
);
console.log(answer.sentence);

const dataset = await answer.fetch();
const rows = await dataset.toRows();
```

A part with several readings, or an ambiguous place, stops the fetch with an `IncompleteAnswerError` whose message numbers the choices. `answer.choose(option)` settles the only part that awaits a choice, and `answer.choose(part, option)` names the part by its index or its words:

```ts
const gni = await client.search("GNI in Germany from 2015 to 2022");
const chosen = await gni.choose(0);
const data = await chosen.fetch();
```

Each choice makes one Search request, and the answer it returns is Search's: its sentence, with any "Assumed: ..." clause, and its assumptions. Picking a reading needs no model call. A place choice, and any other part restated beside it, asks Search to bind it again. Each candidate's `assumptions` lists what Search assumed for that reading, and picking it echoes them, so the picked answer states what that reading assumed. `candidate.fetch()` asks Search for that one reading in the same way, then builds it.

`dataset.ref` names the exact versions the dataset holds. `JSON.stringify(ref)` writes the format both DFO clients read, and `client.fetch(ref)` returns those versions again:

```ts
const saved = JSON.stringify(dataset.ref);
const again = await client.fetch(DatasetRef.fromJSON(JSON.parse(saved)));
```

`client.fetch(spec, { window: [2020, 2023] })` narrows a spec, and `client.mint(spec)` starts a long build that `client.operation(id)` resumes from another process. A spec is an object with its `spec_id` and `definition`, such as `answer.specs[0]`. `fetch` and `mint` reject anything else, a spec id included, with `InvalidRequestError` and the code `invalid_argument`, before any request. `mint` is async, so a refused spec rejects its promise.

A narrowing can leave no data. The fetch then returns a `Dataset` with no rows and the usual columns, and its sentence is Search's no-data sentence for the narrowed reading. The server's `empty_result` warning arrives as a `DataWarning`:

```text
DataWarning empty_result
No data for official development assistance gross disbursements for basic health care (standard grant, core support to non-governmental organisations, other private bodies, public-private partnerships, and research institutes). Try a different place, time period, or indicator. The data covers only 1995 to 2024.
0 true
```

```ts
import { Client } from "@developmentfinance/client";

const client = new Client({
  onWarning: (warning) => console.log(warning.name, (warning as any).code),
});
const spec = (
  await client.search("ODA disbursements from Germany to Nigeria for basic health care")
).specs[0]!;

const empty = await client.fetch(spec, { window: [1900, 1901] });
console.log(empty.sentence);
console.log(empty.rows, empty.columns.includes("value"));
```

`await dataset.bytes()` returns one Parquet file whose key-value metadata carries the sentence, citation, sources, licence, departures, assumptions, layout version and ref under `dfo.*` keys, the file Python's `Dataset.save` writes and `dfo.open_bundle` reads. Several members stack into one table, `part` first, and a column whose type differs between members widens as pyarrow widens it; a pair pyarrow refuses, or a column the client cannot read, such as a nested one, raises a `ContractError` with `contract_violation`. A DECIMAL column keeps its precision, its scale and every value exact in `bytes()`. `dataset.memberBytes(index)` gives one member's file as the server built it. `toArrow(dataset)` from `@developmentfinance/client/arrow` builds an apache-arrow `Table`. That entry point needs the optional `apache-arrow` package.

The client also looks up names and codes:

```ts
const places = await client.graph.resolve(["Nigeria", "Sahel"]);
const nigeria = await client.graph.node("country/NGA");
const code = await client.codes.get("spec_not_found");
const catalogue = await client.catalogue({ place: "country/NGA" });
```

`client.request(method, path, { params, json })` reaches a route the client does not wrap, with the client's key, headers and retries. A `path` that does not start with a single `/`, or that resolves to another host, raises `InvalidRequestError` `invalid_argument` before any request. `client.withOptions({ timeout, maxRetries })` returns a client with other limits that shares this one's fetch, headers and key.

The constructor takes `baseUrl`, `apiKey`, `fetch`, `timeout`, `maxRetries`, `headers`, `headerProvider`, `onWarning` and `dangerouslyAllowBrowser`.

## Leave out party totals

A provider or recipient column can hold a total beside its members. "DAC countries" sits in the same column as Germany, so summing `value` counts a donor more than once. For Ethiopia in 2022 the table has 110 rows that sum to 23.8 billion dollars, and 95 rows that sum to 5.55 billion without the totals.

`withoutPartyTotals: true` drops the rows of parties the code index declares to be totals, on each party role the spec leaves open. `answer.fetch`, `client.fetch`, `client.mint` and `client.operation` take it beside `layout`:

```text
110 95
23838279487 5553373816
[ 'official', 'private' ]
```

```ts
import { Client } from "@developmentfinance/client";

const client = new Client({ onWarning: () => {} });
const answer = await client.search("top 5 donors to Ethiopia in 2022");

const whole = await answer.fetch();
const cut = await answer.fetch({ withoutPartyTotals: true });
console.log(whole.rows, cut.rows);

const sum = async (dataset: typeof whole) =>
  (await dataset.toRows()).reduce((total, row) => total + Number(row["value"]), 0);
console.log(await sum(whole), await sum(cut));

const kinds = new Set((await cut.toRows()).map((row) => row["financingProvider_kind"]));
console.log([...kinds].sort());
```

The cut has three limits:

- A party the spec's identity binds stays on its role. Asking for the DAC total by name returns it.
- A role where every row is a total keeps all its rows, so an answer that is a single total reads the same with or without the flag.
- A row the code index does not mark as a total stays. Some rows repeat another party's figures without carrying that mark, such as the IMF's trust funds in the tables that list them as parties. The remaining rows are not promised to sum to the published total.

A ref records the cut. `dataset.ref` of a cut dataset carries `without_party_totals` in each member's rendering, a plain ref is unchanged, and `client.fetch(ref)` returns the cut. Naming the other value raises `InvalidRequestError` with `invalid_argument`, as a different `layout` does.

## Refs and digests

`client.fetch(ref)` reads each version from its stored file by the digest the ref holds. When the server no longer has a file with that digest, it builds the version again and accepts the build when it returns the ref's version. A digest names one rendering of a version, and the server can render the same rows to a file with another digest. The fetch then returns the data with a `DfoWarning` coded `ref_digest_changed`, which names both digests, and `dataset.ref` carries the rebuilt file's digest. Save that ref to stop the warning. `strict` leaves it a warning, because the data is the version the ref names.

The next example changes the digest in a saved ref to show the warning:

```text
DfoWarning ref_digest_changed
spec_774d6c001a6250aa67ca676ab067895e at cv_b92d94774702c7f05f2075d0b03dd756 was rebuilt as sha256:421efacc2dc010af38112a087b0b49ff5539f61d2afd12a88272b27e99b5f5db, not the ref's sha256:0000000000000000000000000000000000000000000000000000000000000000; the version is the same, and dataset.ref names the rebuilt file.
```

```ts
import { Client, DatasetRef } from "@developmentfinance/client";

const warnings: unknown[] = [];
const client = new Client({ onWarning: (warning) => warnings.push(warning) });
const dataset = await (
  await client.search("ODA disbursements from Germany to Nigeria for basic health care")
).fetch();

const saved = JSON.parse(JSON.stringify(dataset.ref));
saved.members[0].artifact.digest = "sha256:" + "0".repeat(64);

await client.fetch(DatasetRef.fromJSON(saved));
for (const warning of warnings as { name: string; code: string; message: string }[]) {
  console.log(warning.name, warning.code);
  console.log(warning.message);
}
```

A version the server cannot rebuild raises `VersionUnavailableError`. Its `newestVersion` is the version a fresh build returned, or else the newest version in the ref's own rendering that the server lists, or null. That version can be the ref's own, when the server lists it as the newest. The lookup reads the version list newest first, 100 to a page, for at most 20 pages, and a page cursor it has seen before raises `ContractError` with `contract_violation`.

## Timeouts

Times are in milliseconds. The client's `timeout`, 30 seconds by default, bounds one request attempt, and a failed attempt is retried up to `maxRetries` times. Both are checked when the client is built: `timeout` is a finite number above 0 and `maxRetries` an integer from 0 to 10. `Infinity`, `NaN`, 0 or a value that is not a number raises `InvalidRequestError` with `invalid_argument`. A call's own `timeout` can be `Infinity`, which waits without limit. `client.search(question, { timeout })`, 60 seconds by default, bounds the whole search, and each attempt reads until then. `client.fetch(target, { timeout })` and `operation.result({ timeout })`, 30 minutes by default, bound the whole call: builds, polls and downloads, where each download reads for the time left. A build's POST, a mint's included, reads for up to 150 seconds within that. A call that runs out of time raises `DfoTimeoutError` with the code `deadline_exceeded`, even part way through a body; a long build's error names the `client.operation(id)` call that resumes it. A poll wait that would pass the deadline raises that error at once, without a last poll.

## Limits the client enforces

Both DFO clients apply these limits. The constant names are the ones in the source.

| Rule                | Value                                                                                                                                                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Retry-After` parse | ASCII digits (seconds) or an IMF-fixdate such as `Sun, 06 Nov 1994 08:49:37 GMT`. Any other value is ignored, and the client's own backoff applies. A date in the past means 0                                                                 |
| `Retry-After` wait  | The client waits when the value is at most 60 s (`RETRY_AFTER_MAX_S`) and fits the time left before the call's deadline. Otherwise it raises the refusal's typed error at once with `retryAfterMs` set, and does not shorten the wait to retry |
| Poll interval       | The server's value, clamped to 1 s (`POLL_INTERVAL_MIN_S`) to 60 s (`POLL_INTERVAL_MAX_S`), then to the time left before the deadline                                                                                                          |
| Versions walk       | Pages of 100 versions, at most 20 pages (`VERSIONS_PAGE_BUDGET`). A page cursor seen before raises `contract_violation`. Over the budget, no newest version is reported                                                                        |
| Body size           | Decoded bytes are counted while the body streams, and the read stops at the limit with `response_too_large`. A file's limit is its manifest's `bytes`, else 2 GiB (`DEFAULT_MAX_BYTES`). A JSON body's limit is 16 MiB (`JSON_BODY_MAX_BYTES`) |
| Keys                | Visible ASCII only, 0x21 to 0x7E. The key-format check (prefix, base62, checksum) only warns                                                                                                                                                   |
| Header values       | Visible ASCII, space and tab. A control character, DEL or a non-ASCII character raises `header_invalid`                                                                                                                                        |
| `timeout`           | A finite number above 0                                                                                                                                                                                                                        |
| `maxRetries`        | An integer from 0 to 10; a boolean is refused                                                                                                                                                                                                  |
| Error messages      | Name the source and the position of the offending character, and leave the key or header value out                                                                                                                                             |

A key travels only to an https base URL, or to a loopback one over http: `localhost`, a name under `.localhost`, an address in 127.0.0.0/8 written as four decimal numbers, or `[::1]`. Any other plain-http base URL with a key raises `insecure_transport`.

## Wire types

`@developmentfinance/client/wire` exports the request and response types of the DFO APIs, generated from the served OpenAPI document. Each schema has a type of the same name, and `Operation`, the computation a question asks for, is `RequestedOperation`. String enums accept values a newer server adds.

A resolution's parts are `KnownPart | UnknownPart`. Separate them with `isKnownPart` before narrowing on `status`:

```ts
import { isKnownPart } from "@developmentfinance/client";
import type { Part } from "@developmentfinance/client/wire";

function describe(part: Part): string {
  if (!isKnownPart(part)) return `a part with status ${part.status}`;
  switch (part.status) {
    case "definite":
      return part.spec.spec_id;
    case "candidates":
      return `${part.candidates.specs.length} readings`;
    case "no_data":
      return part.no_data.reason;
    case "unsupported":
      return part.unsupported.code;
  }
}
```

## Types

`answer.kind` is an `AnswerKind`: `resolution`, `catalogue` or `declined`. `answer.status` is an `AnswerStatus`: the parts' shared status, `mixed`, or the kind of a catalogue or declined answer. `AnswerStatus` also accepts any other string, so a status a newer server sends still typechecks. `answer.diagnostics` is Search's account of the response (its engine build, timing, model token counts and warnings), or `{}` when it sent none, with the members as the server sent them. `answer.timedOut` reads `diagnostics.timed_out`.

`answer.fetch` returns a `Dataset`, whose `missing` holds the parts a partial fetch left out. `client.fetch` returns a `Dataset<never>`, which leaves none out, and a `Dataset<never>` is also a `Dataset`.

```ts
import { Client } from "@developmentfinance/client";
import type { AnswerKind, AnswerStatus } from "@developmentfinance/client";

const client = new Client();
const answer = await client.search("GDP of Kenya and health spending");
const kind: AnswerKind = answer.kind;
const status: AnswerStatus = answer.status;
console.log(kind, status, Object.keys(answer.diagnostics));
```

## Errors

A refusal, a failed connection, a passed deadline and a response the client cannot act on raise a `DfoError` with a `code`, the HTTP `status`, the server's `detail` and `traceId`, whether it is `retryable`, `retryAfterMs`, the parsed `problem` document and a `docsUrl`. `isDfoError(error)` recognises one from any copy of the package. Subclasses group codes by what the caller does next: `InvalidRequestError`, `NotFoundError`, `IncompleteAnswerError`, `DeclinedError`, `VersionUnavailableError`, `AuthenticationError`, `PermissionDeniedError`, `RateLimitError`, `QuotaExceededError`, `ServerError`, `ContractError`, `NetworkError` and `DfoTimeoutError`.

A refusal's message is the server's detail, then the member its problem document's `pointer` names unless the pointer is empty or the detail names it already, then the code in parentheses, as in `Field required at /input/definition (request_invalid)`. Text the server sends has the client's own key replaced by `[redacted]` in the message, `detail` and `problem`. `docsUrl` is kept only when it is an https URL on the origin of the server that sent the problem. A refusal whose `Retry-After` is past 60 seconds, or does not fit the call's deadline, raises at once with `retryAfterMs` set.

`traceId` is the trace id of the response the error describes, to quote when you report a fault: the top-level `trace_id` of the response body, else the `x-dfo-trace-id` header, else null. A Search answer's `diagnostics.trace_id` is not read. A refusal, a response the client cannot act on, a failed operation, and a declined or incomplete answer each carry one. An error about the caller's input, a download from the storage host, a failed connection or a passed deadline carries null.

`InvalidRequestError` also carries `issues`, the problem document's members at fault, and `alternatives`, the values the server offers in place of what the request named. Their entries are typed as `ProblemIssue` and `Alternative`, exported from the package, and both are empty arrays when the server sent none. A gap's `kind` is a `GapKind`. The server refuses a role the spec does not declare with `invalid_role_ref`, and names the roles it does declare:

```text
stat_var 'dcid:Amount_EconomicActivity_GrossDomesticProduction_Nominal' does not declare role 'origin' (invalid_role_ref)
origin [ { ref: 'observationAbout', label: 'observationAbout' } ]
```

```ts
import { Client, InvalidRequestError } from "@developmentfinance/client";

const client = new Client({ onWarning: () => {} });
const spec = (await client.search("GDP of Kenya")).specs[0]!;
try {
  await client.fetch(spec, { entities: { origin: ["country/DEU"] } });
} catch (error) {
  if (error instanceof InvalidRequestError) {
    console.log(error.message);
    console.log(error.issues[0]?.member, error.issues[0]?.alternatives);
  }
}
```

A server `code` that is not lower-case snake case (`^[a-z][a-z0-9_]*$`) reads as `refusal_without_code`, with the server's text kept in the detail. A proxy body of the form `{"error": ...}` is read the same way, and is retried by its status unless it says `retry`. A 200 response whose body is a problem document, a `code` and no `kind`, on Search and on the lookups, raises the class the contract maps the code to, with the body's trace id. A code the contract lacks raises `ContractError` with `contract_violation`. A 404 that matched no route keeps the server's `detail`, and the message names the request.

### Client codes

The client raises these codes itself, for conditions it detects before or after a request. They are the same in every DFO client. A request that breaks a rule fails before it is sent.

| Code                          | Class                     | Raised when                                                                                                                                                                                                                | What you do                                                                        |
| ----------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `answer_declined`             | `DeclinedError`           | You fetch an answer Search declined or answered with the catalogue                                                                                                                                                         | Ask a question that names data; `answer.reason` says why                           |
| `answer_incomplete`           | `IncompleteAnswerError`   | You fetch an answer with a part that has no reading, without `partial` or with no part answered                                                                                                                            | Choose a reading, or fetch with `partial: true`                                    |
| `base_url_invalid`            | `InvalidRequestError`     | The base URL is empty, is not an absolute http or https URL, holds a character outside visible ASCII, carries userinfo, a query, a fragment or a dot segment, or writes an IPv4 address in other than four decimal numbers | Pass an absolute https URL, or leave `baseUrl` out for the public API              |
| `choice_invalid`              | `InvalidRequestError`     | `choose` names no part awaiting a choice, several, or an unknown option, or a part cannot be posted back                                                                                                                   | Name the part and option by index                                                  |
| `contract_violation`          | `ContractError`           | A response lacks a member the client acts on, holds one of another JSON type, or contradicts the request; a served id breaks its pattern; a downloaded file has the wrong schema                                           | Upgrade `@developmentfinance/client`                                               |
| `credentials_file_invalid`    | `AuthenticationError`     | The credentials file breaks the format                                                                                                                                                                                     | Fix the line the message names, or delete the file                                 |
| `credentials_file_unreadable` | `AuthenticationError`     | The credentials file exists but cannot be read, such as a directory at its path or a path through a regular file                                                                                                           | Make it a file you can read, or set `DFO_CREDENTIALS_FILE`                         |
| `deadline_exceeded`           | `DfoTimeoutError`         | The call's deadline passed before it finished                                                                                                                                                                              | Raise `timeout`, or resume with `client.operation(...)`                            |
| `digest_mismatch`             | `ServerError`             | A downloaded file does not hash to its manifest's digest, after the files route was asked once more                                                                                                                        | Retry; report the spec and version if it repeats                                   |
| `download_failed`             | `ServerError`             | The URL a files route names answered a status other than 200, or its fetch failed, after the route was asked once more                                                                                                     | Retry; report it if it repeats                                                     |
| `header_invalid`              | `InvalidRequestError`     | A header value is not a string of visible ASCII, spaces and tabs, or `headerProvider` raised an error, which is the `cause`                                                                                                | Fix the value the message names; strip the line break a command's output ends with |
| `insecure_transport`          | `InvalidRequestError`     | A key would travel over plain http to a host that is not loopback                                                                                                                                                          | Use an https `baseUrl`, or `apiKey: false`                                         |
| `invalid_argument`            | `InvalidRequestError`     | An argument breaks a rule the client checks before any request; see below                                                                                                                                                  | Fix the argument the message names                                                 |
| `key_empty`                   | `AuthenticationError`     | The `apiKey` option, or what its function returns, is an empty string                                                                                                                                                      | Pass a key, or `false` for anonymous use                                           |
| `key_invalid`                 | `AuthenticationError`     | A key holds a character outside visible ASCII, or the `apiKey` option is neither a string nor an `ApiKey`                                                                                                                  | Copy the key again without spaces or line breaks                                   |
| `network_error`               | `NetworkError`            | The connection failed before a response arrived                                                                                                                                                                            | Check the connection and retry                                                     |
| `offline`                     | `NetworkError`            | `DFO_OFFLINE=1` is set, and the call needs the server                                                                                                                                                                      | Unset `DFO_OFFLINE`                                                                |
| `profile_not_found`           | `AuthenticationError`     | `DFO_PROFILE` names a profile the credentials file lacks                                                                                                                                                                   | Add the profile to the file                                                        |
| `profile_without_key`         | `AuthenticationError`     | The chosen profile has no key, or an empty one                                                                                                                                                                             | Add a `key` line to the profile                                                    |
| `refusal_without_code`        | By HTTP status            | A refusal whose body carries no code, or a code that is not lower-case snake case                                                                                                                                          | Act on the class; report the status if it persists                                 |
| `response_too_large`          | `ServerError`             | A decoded body passes its size cap: 16 MiB for JSON, and for a file its manifest's `bytes`, else 2 GiB                                                                                                                     | Report the `traceId`                                                               |
| `unexpected_response`         | `ContractError`           | A response has a status or form the call does not act on, such as a redirect the call does not follow, a body that is not JSON, or a downloaded file that does not decode as Parquet                                       | Upgrade `@developmentfinance/client`; check `baseUrl`                              |
| `version_unavailable`         | `VersionUnavailableError` | A stored version can no longer be fetched, and no refusal says why                                                                                                                                                         | Fetch the spec for `newestVersion`                                                 |

A refusal from `client.request`, which reaches routes the client does not wrap, keeps the server's `method_not_allowed` code as an `InvalidRequestError`. On a route the client wraps, the same code raises `ContractError`, because the client chose the method.

These raise `invalid_argument` before any request:

- `search` takes text that is not empty or only whitespace, without a lone surrogate.
- `fetch` and `mint` take a spec with its `spec_id` and `definition`; `fetch` also takes a `DatasetRef`. A spec id or any other target raises, as does a ref narrowed with `window`, `entities` or `facets`, or given another `layout` or `withoutPartyTotals`.
- `window` is `"all"`, `"latest"` or a `[startYear, endYear]` pair of safe integers, start no later than end, each within plus or minus 9,007,199,254,740,991.
- `timeout` is a number of milliseconds above 0, and `Infinity` only for a call. `maxRetries` is an integer from 0 to 10.
- `client.operation` takes an id of `op_` and 64 lower-case hex digits. `graph.node` takes a dcid with no `.` or `..` segment, `?`, `#` or control character, and `codes.get` a lower-case snake case code.
- `client.request` takes a path that starts with one `/` and holds no `.` or `..` segment or control character, and a method the API serves. A GET or HEAD takes no `json`.

An id the server sends gets the same pattern check before the client builds a path from it. An operation id, a content version or a spec id that breaks its pattern raises `contract_violation`.

A few calls throw something else:

- A `strict` fetch throws its first `SearchWarning` or `DataWarning`, each a `DfoWarning` and not a `DfoError`, with the `traceId` of the response it came from.
- An aborted call rejects with the caller's `signal.reason`, untouched.
- `new Client()` throws an `InvalidRequestError` or an `AuthenticationError` for the faults in the table above, and a `TypeError` for a secret key in a browser page or worker.
- `DatasetRef.fromJSON` throws a `FormatError`, a `TypeError`, for JSON that is not a ref.
- `dataset.memberBytes(index)` throws a `RangeError` for an index past the members.
- `dataset.toRows()` throws a `RangeError` for an INT64 value outside a JavaScript number's exact range; `toArrow(dataset)` keeps it as a `bigint`.
- A DECIMAL value throws nothing. It reads as the nearest 64-bit float in `toRows()` and `toArrow()`, so a value of more than 15 significant digits can lose its last ones.

`fetch` reads a downloaded file's footer and column types before it returns. Bytes that do not read as Parquet raise `ContractError` with `unexpected_response`, and a file that reads but lacks a `time_period` or numeric `value` column, repeats a column name, or holds no rows where the manifest counts some raises `contract_violation`. The row values decode the first time the data is used (`toRows()`, `toArrow()`, `bytes()`).

## Warnings

Warnings go to `onWarning`, else `process.emitWarning`, else `console.warn`. A `Deprecation` or `Sunset` header from the server warns once per process for each distinct pair of `Deprecation` and `Sunset` values, either header alone included, as a `DfoDeprecationWarning`, and an `x-dfo-warning` header once per message. A fetch passes a manifest's warnings above `info` as `DataWarning`s, and an answer's fetch passes one `SearchWarning` when its readings differ from the question. A manifest's warning belongs to the version, so it is issued on every fetch of that version.

The client issues a `DfoWarning` of its own, or a `DfoDeprecationWarning`, with one of these codes:

| Code                    | Class                   | Issued when                                                                                                                                            |
| ----------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `key_checksum_mismatch` | `DfoWarning`            | The resolved key's body is empty or its checksum differs; the client sends it anyway                                                                   |
| `key_not_base62`        | `DfoWarning`            | A character of the key after its prefix is outside base62; the client sends it anyway                                                                  |
| `key_unknown_prefix`    | `DfoWarning`            | The key starts with neither `dfo_k_` nor `dfo_p_`; the client sends it anyway                                                                          |
| `ref_digest_changed`    | `DfoWarning`            | A ref member's version served a file whose digest differs from the ref's, because the server rendered the same data again; the client returns the data |
| `route_deprecated`      | `DfoDeprecationWarning` | A response carries a `Deprecation` or `Sunset` header; once per process for each pair of header values                                                 |
| `server_warning`        | `DfoWarning`            | A response carries an `x-dfo-warning` header; once per process per message                                                                             |

## API keys

The client resolves its key when it is built, and again after a 401. It takes the first key it finds: the `apiKey` option, the `DFO_API_KEY` environment variable, then the `default` profile (or the one `DFO_PROFILE` names) in the credentials file, which Node reads from `$DFO_CREDENTIALS_FILE`, `$XDG_CONFIG_HOME/dfo/credentials.toml` or `~/.config/dfo/credentials.toml` (`%APPDATA%\dfo\credentials.toml` on Windows). Without a key it calls the API anonymously. An empty `DFO_API_KEY` counts as unset, while an empty `apiKey` option, or a profile whose `key` is empty, raises `AuthenticationError` from `new Client()`, as does a credentials file that fails to parse or cannot be read. A key function is called when the client is built, and one that returns a promise settles before the first request. After a 401 the client looks the key up again and sends the request once more, at once, when the key changed.

A key holds visible ASCII only, the characters 0x21 to 0x7E. A key from any source that holds a space, a line break or a non-ASCII character raises `AuthenticationError` with `key_invalid`, and so does an `apiKey` option that is neither a string nor an `ApiKey`. The message names the source and the position of the first bad character, and leaves the key out. The key travels as `Authorization: Bearer` to the API host only, and the client refuses to send it over plain http to a host that is not loopback.

The credentials file is a strict subset of TOML: UTF-8 text with blank lines, `#` comments on their own line, `[name]` headers and `name = "value"` lines, where a name holds `A-Z`, `a-z`, `0-9`, `_` and `-`, and a value holds no `"`, `\` or control character. Anything else is a fault, though a full TOML reader would accept it: a byte order mark, a comment after a value, single quotes, an unquoted value, or a dotted table such as `[a.b]`. The message names the line and one of the reasons `outside_table`, `duplicate_table`, `duplicate_key` and `invalid_line`.

`headers` adds headers to every API request, and `headerProvider` returns more headers before each request. Later sources replace earlier ones of the same name. A `User-Agent` in `headers` replaces the client's own, and a header of the provider replaces one in `headers`. While the client has a key, its `Authorization` header replaces one from either source. With `apiKey: false`, an `Authorization` header you set is sent. Every value is a string of visible ASCII, spaces and tabs, and a value with a control or non-ASCII character raises `InvalidRequestError` with `header_invalid`, naming the header and the position and leaving the value out. An error the provider throws reaches the caller as `header_invalid`, with the original as `cause`.

## In a browser

A browser page holds a publishable `dfo_p_` key. In a browser page or worker the client refuses a secret `dfo_k_` key, which every visitor could read, unless the caller sets `dangerouslyAllowBrowser: true`.

A browser hides a files route's redirect from the page, so the client asks the files route once more with the redirect followed, sending the key alone on that request to the API's origin, and the browser follows the redirect to the signed URL. Browsers drop the `Authorization` header on a redirect to another origin, as the Fetch standard requires, so the key does not reach the storage host. A followed redirect that ends on any host other than the API's origin or `storage.googleapis.com` raises a `ContractError` with the code `contract_violation`.

A browser also hides a redirect's status, so in a page or worker a files route answering 301, 303, 307 or 308 is followed as a 302 is, where Node and Python raise `unexpected_response`. The host check and the digest check still apply.

## Differences from the Python client

The two clients follow one contract. These differences are deliberate:

- A call's `timeout: Infinity` waits without limit. The Python client uses `None`, and each client refuses the other's value with `invalid_argument`. The client-level `timeout` accepts neither.
- TypeScript reads a downloaded Parquet file's footer and column types at fetch and decodes the row values on first use. Python decodes the whole file at fetch. Both raise `unexpected_response` for bytes that do not read as Parquet and `contract_violation` for a file with the wrong schema.
- `JSON.stringify(ref)` writes no spaces after `,` and `:`, and Python's `ref.to_json()` writes `", "` and `": "`. The content and the key order match, and each client reads the other's refs.
