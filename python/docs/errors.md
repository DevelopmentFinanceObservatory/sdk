# Errors

Every error the client raises derives from `dfo.DfoError`. Its subclasses group failures by what you do next: fix the request, choose a reading, log in, wait, or report. Catch the class that matches the step your code can take, and let the rest propagate.

```python
import dfo

answer = dfo.search("Germany's ODA and GNI from 2015 to 2022")
try:
    data = answer.fetch()
except dfo.IncompleteAnswerError as error:
    print(error)  # lists each gap and the line that settles it
    data = error.answer.fetch(partial=True)
except dfo.RateLimitError as error:
    print(f"over the rate limit; wait {error.retry_after} s")
    raise
```

The client retries failures that can clear before it raises, so an error reaches you only after those retries run out. [Long builds and operations](long-builds.md#retries-the-client-makes) lists them.

## What an error carries

| Attribute     | Holds                                                              |
| ------------- | ------------------------------------------------------------------ |
| `code`        | The server's refusal code, or one of the client's own codes below  |
| `status`      | The HTTP status, or None when no response arrived                  |
| `detail`      | The server's explanation of this occurrence                        |
| `trace_id`    | The request's trace id; quote it when you report a fault           |
| `retryable`   | Whether the same call can succeed later                            |
| `retry_after` | The wait the response's `Retry-After` header asked for, in seconds |
| `problem`     | The parsed problem document, or None                               |
| `docs_url`    | The page that documents the code, or None                          |

`client.codes.get(code)` returns the server's registry entry for a refusal code, with its definition and the routes that send it:

```python
import dfo

with dfo.Client() as client:
    try:
        client.operation("op_00000000000000000000000000000000")
    except dfo.NotFoundError as error:
        print(error.code, error.status, error.trace_id)  # operation_not_found 404 ...
        print(client.codes.get(error.code)["definition"])
```

## Error classes

| Class                     | Raised when                                                                      | What you do                                                              |
| ------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `InvalidRequestError`     | The request breaks a rule, on the client or the server                           | Fix the arguments                                                        |
| `NotFoundError`           | A spec, version, operation or other id is unknown                                | Check the id                                                             |
| `IncompleteAnswerError`   | A part of the question has no reading                                            | `answer.choose(...)`, or `answer.fetch(partial=True)`                    |
| `DeclinedError`           | Search declined the question or answered with the catalogue                      | Ask a question that names data                                           |
| `VersionUnavailableError` | A stored version can no longer be fetched                                        | Fetch the spec for `newest_version`                                      |
| `AuthenticationError`     | A key is missing, unknown, revoked or expired, or the credentials file is broken | Run `dfo auth login`, or fix the file                                    |
| `PermissionDeniedError`   | The key lacks a scope                                                            | Ask for the scope                                                        |
| `RateLimitError`          | Over the rate limit after the client's retries                                   | Wait `retry_after` seconds                                               |
| `QuotaExceededError`      | Over the build quota                                                             | Wait for the quota to reset                                              |
| `ServerError`             | The server failed after the client's retries, or a download failed its check     | Report the `trace_id`                                                    |
| `ContractError`           | A response lacks a field the client acts on, or has a form it does not know      | Upgrade `development-finance`; report it if the newest release fails too |
| `NetworkError`            | The connection failed, or `DFO_OFFLINE=1` blocks a call that needs the server    | Retry later, or fetch from the cache                                     |
| `DfoTimeoutError`         | A deadline passed                                                                | Raise `timeout`, or resume the build the message names                   |

`NetworkError` is also a `ConnectionError`, and `DfoTimeoutError` is also a `TimeoutError`, so code that already catches those keeps working.

Three classes carry more:

- `IncompleteAnswerError.answer` is the answer whose fetch raised it, and `gaps` lists each part without a reading. A refusal from the server carries no answer.
- `VersionUnavailableError.newest_version` is the newest version the server holds, or None.
- `ContractError.pointer` is the JSON Pointer of the missing member, or None.

### Server refusal codes

A server refusal carries a code from the platform's code registry, and the client maps it to a class by the step it calls for:

| The code calls for        | Class                     | Example codes                                                 |
| ------------------------- | ------------------------- | ------------------------------------------------------------- |
| Fixing the request        | `InvalidRequestError`     | `request_invalid`, `over_ceiling`, `entities_unbound`         |
| Checking an id            | `NotFoundError`           | `spec_not_found`, `snapshot_not_found`, `operation_not_found` |
| Choosing a reading        | `IncompleteAnswerError`   | `entity_ambiguous`, `source_ambiguous`, `role_not_resolved`   |
| Asking a data question    | `IncompleteAnswerError`   | `no_observations`, `variable_not_resolved`                    |
| Taking the newest version | `VersionUnavailableError` | `artifact_expired`, `snapshot_revoked`                        |
| Asking for a scope        | `PermissionDeniedError`   | `pin_not_permitted`, `write_refused`                          |
| Reporting                 | `ServerError`             | `internal_error`, `upstream_error`, `operation_failed`        |
| Upgrading                 | `ContractError`           | `unsupported_schema_version`, `release_mismatch`              |

A code this client does not know maps on its HTTP status: 401 to `AuthenticationError`, 403 to `PermissionDeniedError`, 404 and 410 to `NotFoundError`, 408 to `DfoTimeoutError`, 429 to `RateLimitError`, any other 4xx to `InvalidRequestError`, and 5xx to `ServerError`.

`member_not_resolvable` means the graph no longer holds a place or code the reading names. Search the question again for a current reading.

## Client codes

The client raises these codes itself, for conditions it detects before or after a request. They are the same in every DFO client.

| Code                       | Class                     | Raised when                                                                                              | What you do                                                                 |
| -------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `answer_declined`          | `DeclinedError`           | You fetch an answer Search declined or answered with the catalogue                                       | Ask a question that names data; `answer.reason` says why                    |
| `answer_incomplete`        | `IncompleteAnswerError`   | You fetch an answer with a part that has no reading, without `partial=True` or with no part answered     | Choose a reading, or fetch with `partial=True`                              |
| `choice_invalid`           | `InvalidRequestError`     | `choose` names no part awaiting a choice, several, or an unknown option, or a part cannot be posted back | Name the part and option by index                                           |
| `contract_violation`       | `ContractError`           | A response lacks a member the client acts on, or contradicts the request                                 | Upgrade `development-finance`                                               |
| `credentials_file_invalid` | `AuthenticationError`     | The credentials file breaks the format                                                                   | Fix the line the message names, or delete the file and run `dfo auth login` |
| `deadline_exceeded`        | `DfoTimeoutError`         | The call's deadline passed before it finished                                                            | Raise `timeout`, or resume with `client.operation(...)`                     |
| `digest_mismatch`          | `ServerError`             | A downloaded file does not hash to its manifest's digest, twice                                          | Retry; report the `trace_id` if it repeats                                  |
| `download_failed`          | `ServerError`             | A signed storage URL answered a status other than 2xx                                                    | Retry; report it if it repeats                                              |
| `invalid_argument`         | `InvalidRequestError`     | An argument breaks a rule the client checks before any request                                           | Fix the argument the message names                                          |
| `key_empty`                | `AuthenticationError`     | The `api_key` argument is an empty string                                                                | Pass a key, None to look one up, or False for anonymous use                 |
| `network_error`            | `NetworkError`            | The connection failed before a response arrived                                                          | Check the connection and retry                                              |
| `offline`                  | `NetworkError`            | `DFO_OFFLINE=1` is set, and the call needs the server                                                    | Fetch a spec or ref the cache holds, or unset `DFO_OFFLINE`                 |
| `profile_not_found`        | `AuthenticationError`     | `DFO_PROFILE` names a profile the credentials file lacks                                                 | Run `dfo auth login` with that `DFO_PROFILE`                                |
| `profile_without_key`      | `AuthenticationError`     | The chosen profile has no key                                                                            | Run `dfo auth login` with that `DFO_PROFILE`                                |
| `refusal_without_code`     | By HTTP status            | A refusal whose body carries no code                                                                     | Act on the class; report the status if it persists                          |
| `unexpected_response`      | `ContractError`           | A response has a status or form the call does not act on                                                 | Upgrade `development-finance`; check `base_url`                             |
| `version_unavailable`      | `VersionUnavailableError` | A stored version can no longer be fetched, and no refusal says why                                       | Fetch the spec for `newest_version`                                         |

An `invalid_argument` example:

```python
import dfo

answer = dfo.search("GDP of Kenya and health spending")
try:
    answer.fetch(layout="frame")
except dfo.InvalidRequestError as error:
    print(error.code)  # invalid_argument
    print(error)  # layout="frame" holds one reading; ...
```

## Errors outside DfoError

Three errors concern files and arguments on your side, and derive from `ValueError`:

- `dfo.FormatError`: `Spec.from_json` or `DatasetRef.from_json` got JSON that breaks the format. `reason` is `format_invalid`, `definition_spec_id_mismatch` or `repeated_spec_id`, and `pointer` locates the bad value.
- `dfo.BundleError`: `open_bundle` found no saved dataset or bundle at the path. [Datasets and versions](datasets.md#save-and-open-a-file) lists its reasons.
- `ValueError`: `Client` or `configure` got an invalid `base_url`, `timeout` or `max_retries`.

```python
import dfo

try:
    dfo.DatasetRef.from_json('{"format_version": 1, "members": []}')
except dfo.FormatError as error:
    print(error.reason, error.pointer)  # format_invalid /members
```

## Warnings

Warnings derive from `dfo.DfoWarning`, a `UserWarning`, and name the line in your code that triggered them.

- `SearchWarning`: the reading differs from the question, by a departure, a computation Search does not run, or a default it applied. `code` names it when there is one.
- `DataWarning`: the server attached a warning to the data. `code` and `severity` come from the server.
- `DfoDeprecationWarning`: a call, or a route the server marked, goes away in a later release. It is also a `DeprecationWarning`. A route the server marks with a `Deprecation` or `Sunset` header issues it with `code` `route_deprecated`, once per process for each pair of header values.

The client issues a plain `DfoWarning` of its own with a `code`: `server_warning` for a message the server sends in an `x-dfo-warning` header, once per process per message, and `key_unknown_prefix`, `key_not_base62` or `key_checksum_mismatch` for a key that does not look like a DFO key.

`strict=True` on `fetch` raises the first `SearchWarning` or `DataWarning` instead of issuing it. To turn every DFO warning into an error for a test run:

```python
import warnings

import dfo

warnings.simplefilter("error", dfo.DfoWarning)
```

## Next

- [Answers and choices](answers.md): settling the gaps an `IncompleteAnswerError` lists.
- [Keys and credentials](keys.md): fixing an `AuthenticationError`.
