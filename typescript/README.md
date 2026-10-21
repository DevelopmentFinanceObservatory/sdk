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

Each choice makes one Search request with no model call, and the answer it returns is Search's: its sentence, with any "Assumed: ..." clause, and its assumptions. Picking a reading echoes the assumptions Search stated for it, so the picked answer states what that reading assumed. `candidate.fetch()` asks Search for that one reading in the same way, then builds it.

`dataset.ref` names the exact versions the dataset holds. `JSON.stringify(ref)` writes the format both DFO clients read, and `client.fetch(ref)` returns those versions again:

```ts
const saved = JSON.stringify(dataset.ref);
const again = await client.fetch(DatasetRef.fromJSON(JSON.parse(saved)));
```

`client.fetch(spec, { window: [2020, 2023] })` narrows a spec, and `client.mint(spec)` starts a long build that `client.operation(id)` resumes from another process.

`await dataset.bytes()` returns one Parquet file. A one-member dataset gives the file the server built; several members stack into one table, `part` first, whose key-value metadata carries the sentence, citation, sources, licence and ref under `dfo.*` keys, the file Python's `Dataset.save` writes. `toArrow(dataset)` from `@developmentfinance/client/arrow` builds an apache-arrow `Table`; that entry point needs the optional `apache-arrow` package.

The client also looks up names and codes:

```ts
const places = await client.graph.resolve(["Nigeria", "Sahel"]);
const nigeria = await client.graph.node("country/NGA");
const code = await client.codes.get("spec_not_found");
const catalogue = await client.catalogue({ place: "country/NGA" });
```

`client.request(method, path, { params, json })` reaches a route the client does not wrap, with the client's key, headers and retries. `client.withOptions({ timeout, maxRetries })` returns a client with other limits that shares this one's fetch, headers and key.

The constructor takes `baseUrl`, `apiKey`, `fetch`, `timeout` (milliseconds, for lookups and `request`), `maxRetries`, `headers`, `headerProvider`, `onWarning` and `dangerouslyAllowBrowser`.

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

Every error the client raises is a `DfoError` with a `code`, the HTTP `status`, the server's `detail` and `traceId`, whether it is `retryable`, the parsed `problem` document and a `docsUrl`. `isDfoError(error)` recognises one from any copy of the package. Subclasses group codes by what the caller does next: `InvalidRequestError`, `NotFoundError`, `IncompleteAnswerError`, `DeclinedError`, `VersionUnavailableError`, `AuthenticationError`, `PermissionDeniedError`, `RateLimitError`, `QuotaExceededError`, `ServerError`, `ContractError`, `NetworkError` and `DfoTimeoutError`.

## API keys

The client takes the first key it finds: the `apiKey` option, the `DFO_API_KEY` environment variable, then the `default` profile (or the one `DFO_PROFILE` names) in the credentials file, which Node reads from `$DFO_CREDENTIALS_FILE`, `$XDG_CONFIG_HOME/dfo/credentials.toml` or `~/.config/dfo/credentials.toml` (`%APPDATA%\dfo\credentials.toml` on Windows). Without a key it calls the API anonymously.

In a browser page the client refuses a secret `dfo_k_` key, which any script on the page could read, unless the caller sets `dangerouslyAllowBrowser: true`.
