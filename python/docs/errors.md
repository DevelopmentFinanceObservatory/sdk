# Errors

Every error the client raises derives from `dfo.DfoError`. Its subclasses group failures by what you do next: fix the request, choose a reading, log in, wait, or report. Catch the class that matches the step your code can take, and let the rest propagate.

```python
import dfo

answer = dfo.search("debt service of Kenya and the price of tea in Kenya")
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
| `trace_id`    | The response's trace id, or None; quote it when you report a fault |
| `retryable`   | Whether the same call can succeed later                            |
| `retry_after` | The wait the response's `Retry-After` header asked for, in seconds |
| `problem`     | The parsed problem document, or None                               |
| `docs_url`    | The page that documents the code, or None                          |

A refusal's message is the server's detail, then the member its problem document's `pointer` names unless the pointer is empty or the detail names it already, then the code in parentheses, as in `Field required at /input/definition (request_invalid)`. Text the server sends has the client's own key replaced by `[redacted]` in the message, `detail` and `problem`. `docs_url` is kept only when it is an https URL on the origin of the server that sent the problem. A refusal with a `Retry-After` past 60 seconds, or one that does not fit the call's deadline, raises at once with `retry_after` set.

`client.codes.get(code)` returns the server's registry entry for a refusal code, with its definition and the routes that send it:

```python
import dfo

with dfo.Client() as client:
    try:
        client.operation("op_" + "0" * 64)
    except dfo.NotFoundError as error:
        print(error.code, error.status, error.trace_id)  # operation_not_found 404 ...
        print(client.codes.get(error.code)["definition"])
```

## Error classes

| Class                     | Raised when                                                                                               | What you do                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `InvalidRequestError`     | The request breaks a rule, on the client or the server                                                    | Fix the arguments. `issues` and `alternatives` name the member           |
| `NotFoundError`           | A spec, version, operation or other id is unknown                                                         | Check the id                                                             |
| `IncompleteAnswerError`   | A part of the question has no reading                                                                     | `answer.choose(...)`, or `answer.fetch(partial=True)`                    |
| `DeclinedError`           | Search declined the question or answered with the catalogue                                               | Ask a question that names data                                           |
| `VersionUnavailableError` | A stored version can no longer be fetched                                                                 | Fetch the spec for `newest_version`                                      |
| `AuthenticationError`     | A key is missing, unknown, revoked, expired or malformed, or the credentials file is broken or unreadable | Run `dfo auth login`, or fix the file                                    |
| `PermissionDeniedError`   | The key lacks a scope                                                                                     | Ask for the scope                                                        |
| `RateLimitError`          | Over the rate limit after the client's retries                                                            | Wait `retry_after` seconds                                               |
| `QuotaExceededError`      | Over the build quota                                                                                      | Wait for the quota to reset                                              |
| `ServerError`             | The server failed after the client's retries, a download failed its check, or a body passed its size cap  | Report the `trace_id`; a failed download carries none                    |
| `ContractError`           | A response lacks a field the client acts on, or has a form it does not know                               | Upgrade `development-finance`; report it if the newest release fails too |
| `NetworkError`            | The connection failed, or `DFO_OFFLINE=1` blocks a call that needs the server                             | Retry later, or fetch from the cache                                     |
| `DfoTimeoutError`         | A deadline passed                                                                                         | Raise `timeout`, or resume the build the message names                   |

`NetworkError` is also a `ConnectionError`, and `DfoTimeoutError` is also a `TimeoutError`, so code that already catches those keeps working.

Four classes carry more:

- `InvalidRequestError.issues` and `.alternatives` hold the problem document's `issues`, each naming the request member at fault, and its `alternatives`, the values the server offers in place of what the request named. Their entries are typed as `dfo.ProblemIssue` and `dfo.Alternative`, and both are empty tuples when the server sent none.
- `IncompleteAnswerError.answer` is the answer whose fetch raised it, and `gaps` lists each part without a reading. A refusal from the server carries no answer.
- `VersionUnavailableError.newest_version` is the version a fresh build returned, or else the newest plain version the server holds, or None.
- `ContractError.pointer` is the JSON Pointer of the missing or mistyped member, or None.

The server refuses a role the spec does not declare with `invalid_role_ref`, and names the roles it does declare:

```text
stat_var 'dcid:Amount_EconomicActivity_GrossDomesticProduction_Nominal' does not declare role 'origin' (invalid_role_ref)
origin [{'ref': 'observationAbout', 'label': 'observationAbout'}]
```

```python
import dfo

spec = dfo.search("GDP of Kenya").specs[0]
try:
    dfo.fetch(spec, entities={"origin": ["country/DEU"]})
except dfo.InvalidRequestError as error:
    print(error)
    print(error.issues[0]["member"], error.issues[0]["alternatives"])
```

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

A `code` that is not lower-case snake case (`^[a-z][a-z0-9_]*$`) reads as `refusal_without_code`, with the server's text kept in the detail. The website proxy answers its own refusals with problem documents: `rate_limited` at 429 raises `RateLimitError`, and `transient_unavailable` at 502 raises `ServerError`, both retried. A 200 response whose body is a problem document, a `code` and no `kind`, raises the class the registry maps the code to, with the body's trace id. A code the registry does not hold raises `ContractError` with `contract_violation`.

`member_not_resolvable` means the graph holds no place or code that the reading names. Search the question again for a current reading.

## Client codes

The client raises these codes itself, for conditions it detects before or after a request. They are the same in every DFO client. A request that breaks a rule fails before it is sent.

| Code                          | Class                     | Raised when                                                                                                                                                                                                                | What you do                                                                        |
| ----------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `answer_declined`             | `DeclinedError`           | You fetch an answer Search declined or answered with the catalogue                                                                                                                                                         | Ask a question that names data; `answer.reason` says why                           |
| `answer_incomplete`           | `IncompleteAnswerError`   | You fetch an answer with a part that has no reading, without `partial=True` or with no part answered                                                                                                                       | Choose a reading, or fetch with `partial=True`                                     |
| `base_url_invalid`            | `InvalidRequestError`     | The base URL is empty, is not an absolute http or https URL, holds a character outside visible ASCII, carries userinfo, a query, a fragment or a dot segment, or writes an IPv4 address in other than four decimal numbers | Pass an absolute https URL, or None for the public API                             |
| `choice_invalid`              | `InvalidRequestError`     | `choose` names no part awaiting a choice, several, or an unknown option, or a part cannot be posted back                                                                                                                   | Name the part and option by index                                                  |
| `contract_violation`          | `ContractError`           | A response lacks a member the client acts on, holds one of another JSON type, or contradicts the request; a served id breaks its pattern; a downloaded file has the wrong schema                                           | Upgrade `development-finance`                                                      |
| `credentials_file_invalid`    | `AuthenticationError`     | The credentials file breaks the format                                                                                                                                                                                     | Fix the line the message names, or delete the file and run `dfo auth login`        |
| `credentials_file_unreadable` | `AuthenticationError`     | The credentials file exists but cannot be read, such as a directory at its path                                                                                                                                            | Make it a file you can read, or set `DFO_CREDENTIALS_FILE`                         |
| `deadline_exceeded`           | `DfoTimeoutError`         | The call's deadline passed before it finished                                                                                                                                                                              | Raise `timeout`, or resume with `client.operation(...)`                            |
| `digest_mismatch`             | `ServerError`             | A downloaded file does not hash to its manifest's digest, after the files route was asked once more                                                                                                                        | Retry; report the spec and version if it repeats                                   |
| `download_failed`             | `ServerError`             | The URL a files route names answered a status other than 200, or its fetch failed, after the route was asked once more                                                                                                     | Retry; report it if it repeats                                                     |
| `header_invalid`              | `InvalidRequestError`     | A header value is not a string of visible ASCII, spaces and tabs                                                                                                                                                           | Fix the value the message names. Strip the line break a command's output ends with |
| `insecure_transport`          | `InvalidRequestError`     | A key would travel over plain http to a host that is not loopback                                                                                                                                                          | Use an https `base_url`, or `api_key=False`                                        |
| `invalid_argument`            | `InvalidRequestError`     | An argument breaks a rule the client checks before any request; see below                                                                                                                                                  | Fix the argument the message names                                                 |
| `key_empty`                   | `AuthenticationError`     | The `api_key` argument, or what its callable returns, is an empty string                                                                                                                                                   | Pass a key, None to look one up, or False for anonymous use                        |
| `key_invalid`                 | `AuthenticationError`     | A key holds a character outside visible ASCII, or the `api_key` argument is neither a string nor an `ApiKey`                                                                                                               | Copy the key again without spaces or line breaks                                   |
| `network_error`               | `NetworkError`            | The connection failed before a response arrived                                                                                                                                                                            | Check the connection and retry                                                     |
| `offline`                     | `NetworkError`            | `DFO_OFFLINE=1` is set, and the call needs the server                                                                                                                                                                      | Fetch a spec or ref the cache holds, or unset `DFO_OFFLINE`                        |
| `profile_not_found`           | `AuthenticationError`     | `DFO_PROFILE` names a profile the credentials file lacks                                                                                                                                                                   | Run `dfo auth login` with that `DFO_PROFILE`                                       |
| `profile_without_key`         | `AuthenticationError`     | The chosen profile has no key, or an empty one                                                                                                                                                                             | Run `dfo auth login` with that `DFO_PROFILE`                                       |
| `refusal_without_code`        | By HTTP status            | A refusal whose body carries no code, or a code that is not lower-case snake case                                                                                                                                          | Act on the class; report the status if it persists                                 |
| `response_too_large`          | `ServerError`             | A decoded body passes its size cap: 16 MiB for JSON, and for a file its manifest's `bytes`, else 2 GiB                                                                                                                     | Report the `trace_id`                                                              |
| `unexpected_response`         | `ContractError`           | A response has a status or form the call does not act on, such as a redirect the call does not follow, a body that is not JSON, or a downloaded file that does not decode as Parquet                                       | Upgrade `development-finance`; check `base_url`                                    |
| `version_unavailable`         | `VersionUnavailableError` | A stored version can no longer be fetched, and no refusal says why                                                                                                                                                         | Fetch the spec for `newest_version`                                                |

The message of a client error names the source of the fault and, for text, the position of the offending character. It leaves the key or header value out.

A refusal from `client.request`, which reaches routes the client does not wrap, keeps the server's `method_not_allowed` code as an `InvalidRequestError`. On a route the client wraps, the same code raises `ContractError`, because the client chose the method.

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

### Arguments the client checks

These raise `invalid_argument` before any request:

- `search` takes text that is not empty or only whitespace, without a lone surrogate.
- `fetch` and `mint` take a `Spec`; `fetch` also takes a `DatasetRef`. A spec id, a dict or any other target raises, as does a ref narrowed with `window`, `entities` or `facets`, or given another `layout` or `without_party_totals`.
- `window` is `"all"`, `"latest"` or a `(start_year, end_year)` pair of integers, start no later than end, each within plus or minus 9,007,199,254,740,991.
- `timeout` is a finite number above 0, or None where a call allows no limit. `max_retries` is an integer from 0 to 10.
- `client.operation` takes an id of `op_` and 64 lower-case hex digits. `graph.node` takes a dcid with no `.` or `..` segment, `?`, `#` or control character, and `codes.get` a lower-case snake case code.
- `client.request` takes a path that starts with one `/`, holds no `.` or `..` segment or control character, and a method the API serves. A GET or HEAD takes no `json`.
- A client that is closed refuses every call.

An id the server sends gets the same pattern check before the client builds a path from it. An operation id, a content version or a spec id that breaks its pattern raises `contract_violation`.

## Errors outside DfoError

Two errors concern files on your side, and derive from `ValueError`:

- `dfo.FormatError`: `Spec.from_json`, `DatasetRef.from_json` or `dfo.open_bundle` got JSON that breaks the format. `reason` is `format_invalid`, `definition_spec_id_mismatch` or `repeated_spec_id`, and `pointer` locates the bad value.
- `dfo.BundleError`: `open_bundle` found no saved dataset or bundle at the path. [Datasets and versions](datasets.md#open_bundle-limits) lists its reasons.

`open_bundle` raises a plain `ValueError` for a saved file from a later format version, and reading `ref` on a bundle opened from a folder raises one too.

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
- `DfoDeprecationWarning`: a call, or a route the server marked, goes away in a later release. It is also a `DeprecationWarning`.

A `SearchWarning` or `DataWarning` carries `trace_id`, the trace id of the response it came from.

The client issues a plain `DfoWarning` of its own, or a `DfoDeprecationWarning`, with one of these codes:

| Code                    | Class                   | Issued when                                                                                                                                            |
| ----------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `key_checksum_mismatch` | `DfoWarning`            | The resolved key's body is empty or its checksum differs. The client sends it anyway                                                                   |
| `key_not_base62`        | `DfoWarning`            | A character of the key after its prefix is outside base62. The client sends it anyway                                                                  |
| `key_unknown_prefix`    | `DfoWarning`            | The key starts with neither `dfo_k_` nor `dfo_p_`. The client sends it anyway                                                                          |
| `ref_digest_changed`    | `DfoWarning`            | A ref member's version served a file whose digest differs from the ref's, because the server rendered the same data again. The client returns the data |
| `route_deprecated`      | `DfoDeprecationWarning` | A response carries a `Deprecation` or `Sunset` header. Issued once per process for each pair of header values                                          |
| `server_warning`        | `DfoWarning`            | A response carries an `x-dfo-warning` header; once per process per message                                                                             |

`strict=True` on `fetch` raises the first `SearchWarning` or `DataWarning` instead of issuing it. A `ref_digest_changed` warning comes with data, and `strict` leaves it as a warning. To turn every DFO warning into an error for a test run:

```python
import warnings

import dfo

warnings.simplefilter("error", dfo.DfoWarning)
```

## Next

- [Answers and choices](answers.md): settling the gaps an `IncompleteAnswerError` lists.
- [Keys and credentials](keys.md): fixing an `AuthenticationError`.
