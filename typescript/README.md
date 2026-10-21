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
const answer = await client.search("ODA disbursements from Germany to Nigeria for basic health care");
console.log(answer.sentence);

const dataset = await answer.fetch();
const rows = await dataset.toRows();
```

A part with several readings, or an ambiguous place, stops the fetch with an `IncompleteAnswerError` whose message numbers the choices. `answer.choose(option)` settles the only part that awaits a choice, and `answer.choose(part, option)` names the part by its index or its words:

```ts
const gni = await client.search("GNI of Germany from 2015 to 2022");
const chosen = await gni.choose(0);
const data = await chosen.fetch();
```

Each choice makes one Search request, and the answer it returns is Search's: its sentence, with any "Assumed: ..." clause, and its assumptions. Picking a reading needs no model call; a place choice, and any other part restated beside it, asks Search to bind it again. Each candidate's `assumptions` lists what Search assumed for that reading, and picking it echoes them, so the picked answer states what that reading assumed. `candidate.fetch()` asks Search for that one reading in the same way, then builds it.

`dataset.ref` names the exact versions the dataset holds. `JSON.stringify(ref)` writes the format both DFO clients read, and `client.fetch(ref)` returns those versions again:

```ts
const saved = JSON.stringify(dataset.ref);
const again = await client.fetch(DatasetRef.fromJSON(JSON.parse(saved)));
```

`client.fetch(spec, { window: [2020, 2023] })` narrows a spec, and `client.mint(spec)` starts a long build that `client.operation(id)` resumes from another process.

`await dataset.bytes()` returns one Parquet file whose key-value metadata carries the sentence, citation, sources, licence, departures, assumptions, layout version and ref under `dfo.*` keys, the file Python's `Dataset.save` writes and `dfo.open_bundle` reads. Several members stack into one table, `part` first, and a column whose type differs between members widens as pyarrow widens it; a pair pyarrow refuses, or a column the client cannot read, such as a nested one, raises a `ContractError` with `contract_violation`. A DECIMAL column keeps its precision, its scale and every value exact in `bytes()`. `dataset.memberBytes(index)` gives one member's file as the server built it. `toArrow(dataset)` from `@developmentfinance/client/arrow` builds an apache-arrow `Table`; that entry point needs the optional `apache-arrow` package.

The client also looks up names and codes:

```ts
const places = await client.graph.resolve(["Nigeria", "Sahel"]);
const nigeria = await client.graph.node("country/NGA");
const code = await client.codes.get("spec_not_found");
const catalogue = await client.catalogue({ place: "country/NGA" });
```

`client.request(method, path, { params, json })` reaches a route the client does not wrap, with the client's key, headers and retries. A `path` that does not start with a single `/`, or that resolves to another host, raises `InvalidRequestError` `invalid_argument` before any request. `client.withOptions({ timeout, maxRetries })` returns a client with other limits that shares this one's fetch, headers and key.

The constructor takes `baseUrl`, `apiKey`, `fetch`, `timeout`, `maxRetries`, `headers`, `headerProvider`, `onWarning` and `dangerouslyAllowBrowser`.

## Timeouts

Times are in milliseconds, and `Infinity` means no limit. The client's `timeout`, 30 seconds by default, bounds one request attempt, and a failed attempt is retried up to `maxRetries` times. `client.search(question, { timeout })`, 60 seconds by default, bounds the whole search, and each attempt reads until then. `client.fetch(target, { timeout })` and `operation.result({ timeout })`, 30 minutes by default, bound the whole call: builds, polls and downloads, where each download reads for the time left. A build's POST, a mint's included, reads for up to 150 seconds within that. A call that runs out of time raises `DfoTimeoutError` with the code `deadline_exceeded`, even part way through a body; a long build's error names the `client.operation(id)` call that resumes it.

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

## Errors

A refusal, a failed connection, a passed deadline and a response the client cannot act on raise a `DfoError` with a `code`, the HTTP `status`, the server's `detail` and `traceId`, whether it is `retryable`, the parsed `problem` document and a `docsUrl`. `isDfoError(error)` recognises one from any copy of the package. Subclasses group codes by what the caller does next: `InvalidRequestError`, `NotFoundError`, `IncompleteAnswerError`, `DeclinedError`, `VersionUnavailableError`, `AuthenticationError`, `PermissionDeniedError`, `RateLimitError`, `QuotaExceededError`, `ServerError`, `ContractError`, `NetworkError` and `DfoTimeoutError`.

`traceId` is the trace id of the response the error describes, to quote when you report a fault: the top-level `trace_id` of the response body, else the `x-dfo-trace-id` header, else null. A Search answer's `diagnostics.trace_id` is not read. A refusal, a response the client cannot act on, a failed operation, and a declined or incomplete answer each carry one. An error about the caller's input, a download from the storage host, a failed connection or a passed deadline carries null.

A few calls throw something else:

- A `strict` fetch throws its first `SearchWarning` or `DataWarning`, each a `DfoWarning` and not a `DfoError`, with the `traceId` of the response it came from.
- An aborted call rejects with the caller's `signal.reason`, untouched.
- `new Client()` throws a `TypeError` for a relative `baseUrl` no page resolves, or a secret key in a browser page or worker, and an `AuthenticationError` for a key the lookup refuses.
- `DatasetRef.fromJSON` throws a `FormatError`, a `TypeError`, for JSON that is not a ref.
- `dataset.memberBytes(index)` throws a `RangeError` for an index past the members.
- `dataset.toRows()` throws a `RangeError` for an INT64 value outside a JavaScript number's exact range; `toArrow(dataset)` keeps it as a `bigint`.
- A DECIMAL value throws nothing: it reads as the nearest 64-bit float in `toRows()` and `toArrow()`, so a value of more than 15 significant digits can lose its last ones.

## Warnings

Warnings go to `onWarning`, else `process.emitWarning`, else `console.warn`. A `Deprecation` or `Sunset` header from the server warns once per process for each distinct pair of `Deprecation` and `Sunset` values, either header alone included, as a `DfoDeprecationWarning`, and an `x-dfo-warning` header once per message. A fetch passes a manifest's warnings above `info` as `DataWarning`s, and an answer's fetch passes one `SearchWarning` when its readings differ from the question.

## API keys

The client resolves its key when it is built, and again after a 401. It takes the first key it finds: the `apiKey` option, the `DFO_API_KEY` environment variable, then the `default` profile (or the one `DFO_PROFILE` names) in the credentials file, which Node reads from `$DFO_CREDENTIALS_FILE`, `$XDG_CONFIG_HOME/dfo/credentials.toml` or `~/.config/dfo/credentials.toml` (`%APPDATA%\dfo\credentials.toml` on Windows). Without a key it calls the API anonymously. An empty `DFO_API_KEY` counts as unset, while an empty `apiKey` option, or a profile whose `key` is empty, raises `AuthenticationError` from `new Client()`, as does a credentials file that fails to parse. A key function is called when the client is built; one that returns a promise settles before the first request. After a 401 the client looks the key up again and sends the request once more, at once, when the key changed.

## In a browser

A browser page holds a publishable `dfo_p_` key. In a browser page or worker the client refuses a secret `dfo_k_` key, which every visitor could read, unless the caller sets `dangerouslyAllowBrowser: true`.

A browser hides a files route's redirect from the page, so the client asks the files route once more with the redirect followed, sending the key alone on that request to the API's origin, and the browser follows the redirect to the signed URL. Browsers drop the `Authorization` header on a redirect to another origin, as the Fetch standard requires, so the key does not reach the storage host. A followed redirect that ends on any host other than the API's origin or `storage.googleapis.com` raises a `ContractError` with the code `contract_violation`.
