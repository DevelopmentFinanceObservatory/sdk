# Keys and credentials

The client works without a key, under a small per-IP quota. A key raises the quota, and code written without one keeps working when you add it: the client finds the key itself.

## Store a key

`dfo auth login` asks for the key and stores it in the credentials file, readable by your user only:

```bash
dfo auth login
```

```text
Paste your DFO API key:
Saved the key dfo_k_***Qjsd to /home/amina/.config/dfo/credentials.toml, profile 'default'.
```

In CI, pipe the key in with `--with-token`:

```bash
echo "$DFO_KEY_SECRET" | dfo auth login --with-token
```

In a notebook, `dfo.login()` asks for the key with a hidden prompt and stores it the same way.

`dfo auth status` shows which key the client sends and where it came from, masked:

```bash
dfo auth status
```

```text
Key dfo_k_***Qjsd from /home/amina/.config/dfo/credentials.toml, profile 'default'.
```

## Where the client looks

The client resolves its key when it is built, and again after a 401. The first source that has one wins:

1. the `api_key=` argument to `Client` or `configure`;
2. the `DFO_API_KEY` environment variable;
3. the credentials file, profile `DFO_PROFILE`, else `default`;
4. inside Google Colab, a notebook secret named `DFO_API_KEY`;
5. otherwise, anonymous.

`api_key=` takes a string, a `dfo.ApiKey`, or a callable that returns either, which suits a secret manager. `api_key=False` forces anonymous use whatever the environment holds. The second client below reads its key from a `TEAM_DFO_KEY` variable your secret manager sets:

```python
import os

import dfo

with dfo.Client(api_key=False) as client:
    print(client.search("GDP of Kenya").sentence)

with dfo.Client(api_key=lambda: dfo.ApiKey(os.environ["TEAM_DFO_KEY"])) as client:
    print(client.search("GDP of Kenya").sentence)
```

The client calls the callable when it is built and again after a 401. A callable that returns an empty string raises `ValueError`.

The key travels as `Authorization: Bearer` to the API host only. Downloads redirect to signed storage URLs, and those requests carry no key.

## The credentials file

The file lives at the first of:

- `$DFO_CREDENTIALS_FILE`;
- on Linux and macOS, `$XDG_CONFIG_HOME/dfo/credentials.toml`, else `~/.config/dfo/credentials.toml`;
- on Windows, `%APPDATA%\dfo\credentials.toml`.

Every DFO client reads the same file. It holds one table per profile, with a `key` line in each:

```toml
[default]
key = "dfo_k_4Fq8ZtR2mXc7LwN9pVb3HsK6dYg1JeTa2YQjsd"

[staging]
key = "dfo_k_..."
```

`DFO_PROFILE=staging` picks the second profile, for the CLI and for every client. `dfo auth login` with `DFO_PROFILE` set stores the key under that profile and keeps the others.

The file is a subset of TOML: blank lines, `#` comments on their own line, `[name]` headers and `name = "value"` lines. Three faults raise `AuthenticationError` when the client is built:

| Code                       | Cause                                                         | Fix                                                       |
| -------------------------- | ------------------------------------------------------------- | --------------------------------------------------------- |
| `credentials_file_invalid` | A line breaks the format; the message names it and the reason | Fix the line, or delete the file and run `dfo auth login` |
| `profile_not_found`        | `DFO_PROFILE` names a profile the file lacks                  | Run `dfo auth login` with that `DFO_PROFILE`              |
| `profile_without_key`      | The chosen profile has no `key` line                          | Run `dfo auth login` with that `DFO_PROFILE`              |

A missing file, or a file without a `default` profile when `DFO_PROFILE` is unset, moves on to the next source.

## Keep the key out of logs

`dfo.ApiKey` wraps a key so it stays out of reprs, logs and pickles. `str` and `repr` show a masked form, `reveal()` returns the value, and pickling raises `TypeError`:

```python
import pickle

import dfo

key = dfo.ApiKey("dfo_k_4Fq8ZtR2mXc7LwN9pVb3HsK6dYg1JeTa2YQjsd")
print(key)  # ApiKey('dfo_k_***Qjsd')
print(len(key.reveal()))

try:
    pickle.dumps(key)
except TypeError as error:
    print(error)  # An ApiKey cannot be pickled; pass the key to each process
```

A DFO secret key starts with `dfo_k_`, then a base62 body, then a six-character checksum: 44 characters in all. The client checks the prefix, characters and checksum when it resolves a key. A key that fails issues a `DfoWarning` and is sent anyway, so a typo shows up as a warning before the server refuses it.

## When the server refuses a key

| Situation                                                     | Class                   |
| ------------------------------------------------------------- | ----------------------- |
| The key is unknown, revoked or expired, or a call needs a key | `AuthenticationError`   |
| The key lacks a scope the call needs                          | `PermissionDeniedError` |
| Over the rate limit after the client's retries                | `RateLimitError`        |
| Over the build quota                                          | `QuotaExceededError`    |

The server writes each message. After a 401 the client resolves its key once more before it raises, so a key you replaced with `dfo auth login` in another terminal takes effect without a restart.

## Other headers

`default_headers=` adds headers to every API request. `header_provider=` is a callable that returns more headers before each request, such as an identity token for a deployment behind a proxy:

```python
import dfo

with dfo.Client(
    default_headers={"X-Team": "aid-analytics"},
    header_provider=lambda: {"X-Request-Source": "nightly-job"},
) as client:
    print(client.search("GDP of Kenya").sentence)
```

## Next

- [Errors](errors.md): every error class and code, by what you do next.
- [The cache](cache.md): where the client keeps downloads.
