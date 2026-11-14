# Settings

Every setting the Python client reads, where it comes from, and what it falls back to. An argument wins over its environment variable, and the variable wins over the default. A variable set to the empty string counts as unset.

The client arguments go to `dfo.Client`, `dfo.AsyncClient`, and `dfo.configure`, which replaces the client behind `dfo.search` and `dfo.fetch`. `client.with_options(timeout=..., attempt_timeout=..., max_retries=...)` returns a copy with other limits that shares the client's connections and cache.

| Setting          | Argument                                   | Environment variable                      | Default                                                                          |
| ---------------- | ------------------------------------------ | ----------------------------------------- | -------------------------------------------------------------------------------- |
| API key          | `api_key=`                                 | `DFO_API_KEY`                             | The credentials file, then a Colab secret named `DFO_API_KEY`, else anonymous    |
| Credentials file | none                                       | `DFO_CREDENTIALS_FILE`                    | `~/.config/dfo/credentials.toml`, or `%APPDATA%\dfo\credentials.toml` on Windows |
| Profile          | none                                       | `DFO_PROFILE`                             | `default`                                                                        |
| Base URL         | `base_url=`                                | `DFO_BASE_URL`                            | `https://developmentfinance.org/api/v1`                                          |
| Headers          | `headers=`                                 | none                                      | None                                                                             |
| Header provider  | `header_provider=`                         | none                                      | None                                                                             |
| Call timeout     | `timeout=` on the client, and on each call | `DFO_TIMEOUT`, in seconds                 | None, so `search` waits 60 s and every other call as long as the server takes    |
| Attempt timeout  | `attempt_timeout=`                         | none                                      | 30 s                                                                             |
| Retries          | `max_retries=`                             | `DFO_MAX_RETRIES`                         | 2                                                                                |
| Cache directory  | `cache_dir=`                               | `DFO_CACHE_DIR`, then `BBLOCKS_CACHE_DIR` | The platform's cache directory                                                   |
| Cache on or off  | `cache=`                                   | none                                      | True                                                                             |
| Offline          | none                                       | `DFO_OFFLINE=1`                           | Off                                                                              |
| Progress         | `progress=` on `fetch` and `answer.fetch`  | `DFO_PROGRESS=0`                          | Shown in a terminal or notebook, and logged to the `dfo` logger anywhere else    |

The client reads `DFO_API_KEY`, `DFO_CREDENTIALS_FILE`, `DFO_PROFILE`, `DFO_BASE_URL`, `DFO_TIMEOUT`, `DFO_MAX_RETRIES`, and the cache variables when it is built, and `DFO_OFFLINE` and `DFO_PROGRESS` on each call. A client reads a variable only for an argument left out, so `dfo.Client(timeout=60)` leaves `DFO_TIMEOUT` unread, and an invalid value in a variable it reads raises when it is built. `dfo.configure` builds a client at once, and the client behind `dfo.search` and `dfo.fetch` is built at the first call, so `import dfo` reads no variable. `with_options` reads none.

## Timeouts

Two options bound how long the client waits:

- `timeout` bounds a whole call, in seconds: its retries, the waits between them, a long build's polls, and the downloads. Set on the client, it applies to every call that passes no `timeout` of its own. A call's own `timeout` overrides it, and `timeout=None` on a call waits without a bound. A client built without `timeout` takes `DFO_TIMEOUT`, such as `DFO_TIMEOUT=300`.
- `attempt_timeout` bounds one request attempt, 30 seconds by default. A search attempt and a download read until the call's timeout instead, and a build request reads for up to 150 seconds.

With `timeout=None` on the client, each call keeps its own bound whatever `DFO_TIMEOUT` holds, and so does a client built without `timeout` while `DFO_TIMEOUT` is unset: `dfo.search` and `answer.choose` stop after 60 seconds, and `fetch`, `answer.fetch`, and the `dfo.analysis` calls wait as long as the server takes, which the server always ends. A client built for slow builds can set one bound for all of them:

<!-- docs-check: skip: waits on the network for up to five minutes -->

```python
import dfo

with dfo.Client(timeout=300) as client:
    data = client.search("ODA to Kenya").fetch()  # gives up after 300 s
    quick = client.fetch(data.ref, timeout=30)  # this call alone gives up after 30 s
```

A call that runs out of its timeout raises `DfoTimeoutError` with the code `deadline_exceeded`, and the message names the bound that passed: the call's `timeout`, or the client's when the call gave none. An attempt that runs out of `attempt_timeout` is retried, and the last one raises the same class with a message naming `attempt_timeout`. [Long builds](long-builds.md) covers what a timed-out build leaves running on the server.

A call's `timeout` defaults to `CLIENT_TIMEOUT` from `dfo.types`, which stands for the client's `timeout`, and `CallTimeout` types the argument. A function that wraps a call takes both, so leaving its `timeout` out still applies the client's:

```python
import dfo
from dfo.types import CLIENT_TIMEOUT, CallTimeout


def fetch_strictly(
    target: dfo.Spec | dfo.DatasetRef, timeout: CallTimeout = CLIENT_TIMEOUT
) -> dfo.Dataset:
    return dfo.fetch(target, strict=True, timeout=timeout)
```

`client.with_options(timeout=None)` returns a copy whose calls have no client bound, so each call keeps its own default. Leave `timeout` out of `with_options` to keep the client's.

## API key

The client looks for its key when it is built, and the first source that has one wins:

1. the `api_key=` argument
1. the `DFO_API_KEY` environment variable
1. the credentials file, profile `DFO_PROFILE`, else `default`
1. inside Google Colab, a notebook secret named `DFO_API_KEY`
1. otherwise, anonymous

`api_key=False` calls the API anonymously whatever the environment holds. [Keys and credentials](keys.md) covers `dfo auth login` and the file's format.

## Credentials file

The file lives at the first of:

- `$DFO_CREDENTIALS_FILE`
- on Linux and macOS, `$XDG_CONFIG_HOME/dfo/credentials.toml`, else `~/.config/dfo/credentials.toml`
- on Windows, `%APPDATA%\dfo\credentials.toml`, else `<home>\AppData\Roaming\dfo\credentials.toml`. Windows ignores `XDG_CONFIG_HOME`.

## Cache directory

The cache root is the first of these that is set:

1. `cache_dir=`
1. `DFO_CACHE_DIR`
1. `BBLOCKS_CACHE_DIR`, shared with the bblocks packages
1. the platform's cache directory: `~/.cache/dfo` on Linux (or `$XDG_CACHE_HOME/dfo`), `~/Library/Caches/dfo` on macOS, and `%LOCALAPPDATA%\dfo\Cache` on Windows.

Release 0.1 kept the platform default under `readerkit` in place of `dfo`, such as `~/.cache/readerkit` on Linux. With none of the first three set, a file or manifest missing from the cache is read from the same place under the `readerkit` root, checked as the cache checks its own, and copied in. The client never writes to, evicts from, or clears the `readerkit` directory, so delete it yourself once you no longer run 0.1.

A relative `cache_dir` resolves against the working directory when the client is built. `cache=False` fetches without reading or writing the cache. [The cache](cache.md) covers the layout and `DFO_OFFLINE`.

## Limits on the values

| Setting           | Accepted values                                                                      |
| ----------------- | ------------------------------------------------------------------------------------ |
| `timeout`         | None, or a finite number of seconds above 0                                          |
| `attempt_timeout` | A finite number of seconds above 0                                                   |
| `max_retries`     | An integer from 0 to 10. A bool is refused                                           |
| `DFO_TIMEOUT`     | ASCII digits with an optional fraction, such as `300` or `2.5`, above 0              |
| `DFO_MAX_RETRIES` | ASCII digits naming an integer from 0 to 10, such as `5`                             |
| `base_url`        | An absolute http or https URL. A key travels over plain http to a loopback host only |
| Header values     | Visible ASCII, space, and tab                                                        |
| `DFO_OFFLINE`     | `1` turns offline mode on, and any other value leaves it off                         |
| `DFO_PROGRESS`    | `0` silences progress, and any other value leaves it on                              |

A value outside these raises `InvalidRequestError` with `invalid_argument`, `base_url_invalid`, `insecure_transport`, or `header_invalid` before any request, and the message names the argument or variable that held it. A sign, an exponent, a leading or trailing point, an underscore, a space, or `inf` in `DFO_TIMEOUT` or `DFO_MAX_RETRIES` is refused.
