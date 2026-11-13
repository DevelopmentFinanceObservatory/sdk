# Settings

`new Client(options)` takes every setting the client has. The key and the base URL can also come from four environment variables, `DFO_API_KEY`, `DFO_CREDENTIALS_FILE`, `DFO_PROFILE` and `DFO_BASE_URL`, read where the platform has a process environment, such as Node, Deno with `--allow-env`, or Bun. An option given to the constructor always wins over a variable, and an empty variable reads as unset.

| Option                    | Environment variable                     | Default                                                   |
| ------------------------- | ---------------------------------------- | --------------------------------------------------------- |
| `apiKey`                  | `DFO_API_KEY`, then the credentials file | No key: anonymous use                                     |
| `baseUrl`                 | `DFO_BASE_URL`                           | `https://developmentfinance.org/api/v1`                   |
| `timeout`                 | none                                     | Each call's own: `search` 60 s, `fetch` and the rest none |
| `attemptTimeout`          | none                                     | 30 s                                                      |
| `maxRetries`              | none                                     | 2                                                         |
| `headers`                 | none                                     | None beyond the client's `User-Agent` and `X-DFO-Client`  |
| `headerProvider`          | none                                     | None                                                      |
| `fetch`                   | none                                     | The platform's `fetch`                                    |
| `onWarning`               | none                                     | `process.emitWarning`, else `console.warn`                |
| `dangerouslyAllowBrowser` | none                                     | `false`                                                   |

## Key

The client takes the first key it finds:

1. The `apiKey` option: a string, an `ApiKey`, or a function that returns one, which the client calls again after a 401. `apiKey: false` sends no key and reads nothing else.
2. `DFO_API_KEY`.
3. The credentials file that the Python client's `dfo auth login` writes, read on Node only. `DFO_CREDENTIALS_FILE` names the file. When that is unset, it is `$XDG_CONFIG_HOME/dfo/credentials.toml` or `~/.config/dfo/credentials.toml`, and on Windows `%APPDATA%\dfo\credentials.toml`. `DFO_PROFILE` picks a profile in it, `default` when unset. A profile that `DFO_PROFILE` names and the file lacks raises `AuthenticationError` (`profile_not_found`).
4. No key, for anonymous use.

In a browser page or worker the client refuses a secret `dfo_k_` key unless `dangerouslyAllowBrowser` is true, because every visitor can read it. A key travels only over https, or plain http to a loopback host.

## Base URL

`baseUrl` wins over `DFO_BASE_URL`, which wins over the public API. In a page, a relative `baseUrl` such as `/api/v1` resolves against the page. `String(client)` shows a base URL other than the public API's, and says `(from DFO_BASE_URL)` when that variable set it.

## Time limits and retries

`timeout` bounds a whole call, in milliseconds: every attempt, the waits between retries, the wait for a build, and the download. A call's own `timeout` option replaces the client's for that call. `Infinity` removes the bound. With neither set, each call keeps its own default: `search` and `answer.choose` stop after 60 seconds, `fetch` and the `client.analysis` methods wait as long as the build takes, and every other call is bounded only by its attempts and retries. A call past its bound raises `DfoTimeoutError` with the code `deadline_exceeded`. A `fetch` stopped that way leaves its build running on the server, and the same fetch made again joins it.

`attemptTimeout` bounds one request attempt, 30 seconds by default. An attempt that runs past it fails, and the client retries it up to `maxRetries` times, 2 by default, from 0 to 10. A refusal the server marks retryable is retried the same way, after its `Retry-After` or a backoff from 0.5 to 8 seconds. Three waits keep their own bounds: a build's POST reads for up to 150 seconds, a Search request reads until the call's `timeout`, and a download fails after 30 seconds with no byte.

`client.withOptions({ timeout, attemptTimeout, maxRetries })` returns a copy with other limits that shares the client's key, headers and `fetch`. A limit left out keeps the client's, and `timeout: null` clears the client's `timeout`, so each call keeps its own default.

```ts
import { Client } from "@developmentfinance/client";

// Every call gets five minutes, a slow build included, and each attempt 45 seconds.
const client = new Client({ apiKey: false, timeout: 300_000, attemptTimeout: 45_000 });
// A copy that fails fast, for a page that cannot wait.
const quick = client.withOptions({ timeout: 10_000, maxRetries: 0 });
console.log(String(client), String(quick));
```

## Headers

`headers` go with every request to the API. A signed storage URL receives none of them. A `User-Agent` in `headers` replaces the client's own. `headerProvider` is called before each request for more headers, such as an identity token, and its headers replace those of `headers`. While the client has a key, the key's `Authorization` replaces any from either. The client names itself in `X-DFO-Client`, and a header of that name from either raises `InvalidRequestError` (`header_invalid`).

## Settings of the Python client

The Python client also reads `DFO_CACHE_DIR`, `DFO_OFFLINE` and `DFO_PROGRESS`, for its file cache, offline reads and progress bars. This client has no file cache or progress bar and ignores them. A fetch reports progress to its `onProgress` option.
