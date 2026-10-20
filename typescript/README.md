# @developmentfinance/client

TypeScript client for the Development Finance Observatory APIs at [developmentfinance.org](https://developmentfinance.org).

```bash
npm install @developmentfinance/client
```

The package is ESM only and runs on Node 22.18 and later, Bun, Deno, Workers and browsers.

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
