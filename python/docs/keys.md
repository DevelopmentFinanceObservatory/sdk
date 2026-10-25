# Keys and credentials

The client works without a key, under a small per-IP quota, and a key raises the quota. Store a key once with `dfo auth login` and every client on the machine finds it, so code written without a key keeps working when you add one.

## Start without a key

```text
Kenya's GDP, 1960 to 2025. Current US dollars · World Development Indicators.
  Fetch: answer.fetch()
```

```python
import dfo

answer = dfo.search("GDP of Kenya")
print(answer)
```

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

In a notebook, `dfo.auth.login()` asks for the key with a hidden prompt and stores it the same way.

## Check which key goes where

`dfo auth status` prints the key a client built with no options sends, masked, and the API its requests go to:

```bash
dfo auth status
```

```text
Key dfo_k_***Qjsd from /home/amina/.config/dfo/credentials.toml, profile 'default'.
Requests go to https://developmentfinance.org/api/v1, the public API, the default while DFO_BASE_URL is unset.
```

Without a key it says so and names the file `dfo auth login` writes:

```text
No key: requests are anonymous.
Run `dfo auth login` to store one in /home/amina/.config/dfo/credentials.toml.
Requests go to https://developmentfinance.org/api/v1, the public API, the default while DFO_BASE_URL is unset.
```

## Point the client at another API

`DFO_BASE_URL` sends every client built without a `base_url` to another deployment, such as a staging API. `dfo auth status` then names it:

```text
Requests go to https://staging.example.org/api, from the DFO_BASE_URL environment variable.
```

`base_url=` sets it for one client, and the client's repr shows where it sends requests:

```text
<Client http://localhost:8000/api>
```

```python
import dfo

with dfo.Client(base_url="http://localhost:8000/api") as client:
    print(client)
```

A base URL is an absolute http or https URL. A key travels over https, or over plain http to a loopback host only: `localhost`, a name under `.localhost`, an address in 127.0.0.0/8 written as four decimal numbers, or `[::1]`. Any other plain-http base URL with a key raises `InvalidRequestError` with `insecure_transport`.

## Pass a key in code

The client looks for its key when it is built, and the first source that has one wins:

1. the `api_key=` argument to `Client`, `AsyncClient` or `dfo.configure`;
1. the `DFO_API_KEY` environment variable;
1. the credentials file, profile `DFO_PROFILE`, else `default`;
1. inside Google Colab, a notebook secret named `DFO_API_KEY`;
1. otherwise, anonymous.

`api_key=` takes a string, a `dfo.auth.ApiKey`, or a callable that returns either, which suits a secret manager. The client calls the callable when it is built and again after a 401. Here the key comes from a `TEAM_DFO_KEY` variable your secret manager sets:

<!-- docs-check: skip: needs a real key in TEAM_DFO_KEY -->

```python
import os

import dfo

with dfo.Client(api_key=lambda: os.environ["TEAM_DFO_KEY"]) as client:
    print(client.search("GDP of Kenya"))
```

`api_key=False` sends no key, whatever the environment and the credentials file hold. `dfo.configure(api_key=...)` sets the key `dfo.search` and `dfo.fetch` use.

A key holds visible ASCII only, the characters 0x21 to 0x7E. A key copied from a terminal often ends with a line break, and the client refuses it before any request, naming the source and the position:

```text
The API key from the api_key argument holds a line break at character 45; a key holds visible ASCII only. Copy it again without spaces or line breaks. [key_invalid]
```

## Add headers

`headers=` adds headers to every API request. `header_provider=` is a callable that returns more headers before each request, such as an identity token for a deployment behind a proxy:

```text
Kenya's GDP, 1960 to 2025. Current US dollars · World Development Indicators.
  Fetch: answer.fetch()
```

```python
import dfo

with dfo.Client(
    api_key=False,
    headers={"X-Team": "aid-analytics"},
    header_provider=lambda: {"X-Request-Source": "nightly-job"},
) as client:
    print(client.search("GDP of Kenya"))
```

A provider's header replaces one of the same name in `headers`, and the key's `Authorization` header replaces one from either. A header value holds visible ASCII, spaces and tabs; any other character raises `InvalidRequestError` with `header_invalid`, naming the header and leaving the value out. The synchronous client calls the provider on your thread with no time limit, so give a provider that can block its own timeout. The asynchronous client bounds it by the time left on the request.

## Keep the key out of logs

`dfo.auth.ApiKey` wraps a key so it stays out of reprs, logs and pickles. `str` and `repr` show a masked form, `reveal()` returns the value, and pickling raises `TypeError`:

```text
ApiKey('dfo_k_***Qjsd')
An ApiKey cannot be pickled; pass the key to each process
```

```python
import pickle

from dfo.auth import ApiKey

key = ApiKey("dfo_k_4Fq8ZtR2mXc7LwN9pVb3HsK6dYg1JeTa2YQjsd")
print(key)
try:
    pickle.dumps(key)
except TypeError as error:
    print(error)
```

The client sends the key as `Authorization: Bearer` to the API host only. Downloads redirect to signed storage URLs, and those requests carry no key. The client replaces its own key with `[redacted]` in any server text it shows.

## Reference

### The credentials file

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

`DFO_PROFILE=staging` picks the second profile for the CLI and for every client. `dfo auth login` with `DFO_PROFILE` set stores the key under that profile and keeps the others.

The file is a strict subset of TOML: `[profile]` headers, `name = "value"` lines in double quotes, blank lines and whole-line `#` comments. A missing file, or one without a `default` profile while `DFO_PROFILE` is unset, moves the lookup on to the next source. These faults raise `AuthenticationError` when the client is built:

| Code                          | Cause                                                   | Fix                                                        |
| ----------------------------- | ------------------------------------------------------- | ---------------------------------------------------------- |
| `credentials_file_invalid`    | A line breaks the format; the message names it          | Fix the line, or delete the file and run `dfo auth login`  |
| `credentials_file_unreadable` | The path exists but cannot be read, such as a directory | Make it a file you can read, or set `DFO_CREDENTIALS_FILE` |
| `profile_not_found`           | `DFO_PROFILE` names a profile the file lacks            | Run `dfo auth login` with that `DFO_PROFILE`               |
| `profile_without_key`         | The chosen profile has no `key` line, or an empty one   | Run `dfo auth login` with that `DFO_PROFILE`               |

### The key format

A DFO secret key is 44 characters long: `dfo_k_`, a base62 body, then a six-character checksum. A key that fails the check issues a `DfoWarning` (`key_unknown_prefix`, `key_not_base62` or `key_checksum_mismatch`) and is sent anyway, so a typo shows up before the server refuses it.

### When the server refuses a key

A key the server does not accept, because it is unknown, revoked or expired, raises `AuthenticationError`, and a key without a scope the call needs raises `PermissionDeniedError`. After a 401 the client looks up its key once more before it raises, so a key you replaced with `dfo auth login` in another terminal takes effect without a restart. [Errors](errors.md) lists every class and code.

## Next

- [Errors](errors.md): what to catch, and the fix each error names.
- [The cache](cache.md): where the client keeps downloads.
