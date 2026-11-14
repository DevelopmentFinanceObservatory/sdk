# Errors

Every error the client raises ends with its code and the trace id of the response, and its message names the next step:

```text
graph does not hold 'country/XYZ' at /dcid [node_not_held trace=33955aa626074d4b8e3805c33f7179b8]
```

The classes live in `dfo.errors` and derive from `DfoError`. Each class stands for one next step: fix the request, check an id, choose a reading, wait, or report. Catch the classes your code can act on and let the rest stop the program, so their message and trace id reach you.

## In a notebook

In a notebook, catch nothing. `print(answer)` shows what Search understood and the line to type next, and a failed `fetch` raises with the same text.

```text
Answered 0 of 1 part of your question.
  missing  "aid": "Congo" matches more than one entity: "Congo [DRC]" and "Congo [Republic]". Be more specific.
    [0] Congo [DRC]
    [1] Congo [Republic]
  Choose: answer.choose("Congo [DRC]").fetch()
```

```python
import dfo

answer = dfo.search("aid to Congo")
print(answer)
```

Type the line it names:

```python
data = answer.choose("Congo [DRC]").fetch()
```

[Answers and choices](answers.md) covers choosing and the other gaps an answer can hold.

## In a script

A script that runs a list of questions settles two failures itself, a question with a part Search could not read and a question Search declined. Everything else stops the script.

```text
'GDP of Kenya': 66 rows
'debt service paid by Kenya and the price of tea in Kenya': 55 rows
skipped 'what is the meaning of life': answer_declined
```

```python
import dfo
from dfo.errors import DeclinedError, IncompleteAnswerError

questions = [
    "GDP of Kenya",
    "debt service paid by Kenya and the price of tea in Kenya",
    "what is the meaning of life",
]
for question in questions:
    answer = dfo.search(question)
    try:
        data = answer.fetch()
    except IncompleteAnswerError:
        data = answer.fetch(partial=True)
    except DeclinedError as error:
        print(f"skipped {question!r}: {error.code}")
        continue
    print(f"{question!r}: {len(data)} rows")
```

`fetch(partial=True)` builds the parts that have a reading and lists the others in `data.missing`. It raises `IncompleteAnswerError` again when no part has a reading, as with "aid to Congo", which waits for a choice.

## In a service

A web service answers its own caller. A question the caller can rephrase is the caller's to fix, a rate limit or a slow build asks the caller to come back, an outage upstream is a 502 with the trace id in your logs, and anything else is a fault in your code or configuration.

```text
(200, {'rows': 66})
(422, {'error': 'answer_declined', 'message': 'Search declined the question: it asks for no published statistic about a place, a population or a financial flow.\n  Next: ask for a figure DFO publishes; dfo.lookup.catalogue() lists example questions.\n[answer_declined trace=201b1583fbc045d08668fc45479e9d6b]'})
```

```python
import asyncio

import dfo
from dfo.errors import (
    DeclinedError,
    DfoError,
    IncompleteAnswerError,
    NetworkError,
    QuotaExceededError,
    RateLimitError,
    ServerError,
)

client = dfo.AsyncClient()


async def respond(question: str) -> tuple[int, dict]:
    try:
        async with asyncio.timeout(50):
            answer = await client.search(question)
            data = await answer.fetch()
    except (IncompleteAnswerError, DeclinedError) as error:
        return 422, {"error": error.code, "message": str(error)}
    except (RateLimitError, QuotaExceededError) as error:
        return 503, {"error": error.code, "retry_after": error.retry_after}
    except TimeoutError:
        return 503, {"error": "deadline_exceeded"}
    except (ServerError, NetworkError) as error:
        return 502, {"error": error.code, "trace_id": error.trace_id}
    except DfoError as error:
        return 500, {"error": error.code, "trace_id": error.trace_id}
    return 200, {"rows": len(data)}


async def main() -> None:
    print(await respond("GDP of Kenya"))
    print(await respond("what is the meaning of life"))
    await client.aclose()


asyncio.run(main())
```

`asyncio.timeout(50)` bounds the search and the fetch together, so the handler answers inside the limit of a platform that ends requests at 60 seconds. Cancelling the async client stops the wait at once and leaves the build running on the server, and the same question on the next request joins it. [Long builds](long-builds.md) covers the pattern.

## Retrying

The client retries a failure that can clear before it raises: a dropped connection, a 408, 429, 500, 502, 503, or 504, and any refusal whose body says it is retryable. It makes `max_retries` further attempts, 2 by default, and waits for the response's `Retry-After`, else 0.5 seconds doubling to 8. A `Retry-After` past 60 seconds, or one that would pass the call's deadline, raises at once with `retry_after` set. To retry more on every call, build the client with more attempts:

```python
import dfo

with dfo.Client(max_retries=5) as client:
    data = client.search("GDP of Kenya").fetch()
```

`error.retryable` says whether the same call can succeed later. A job that runs unattended can wait longer than the client does:

```python
import time

import dfo
from dfo.errors import DfoError


def fetch_with_retries(answer, attempts=4):
    for attempt in range(attempts):
        try:
            return answer.fetch()
        except DfoError as error:
            if not error.retryable or attempt == attempts - 1:
                raise
            time.sleep(error.retry_after or 2**attempt * 10)


data = fetch_with_retries(dfo.search("GDP of Kenya"))
```

A `DfoTimeoutError` is retryable, and the retry joins the build the first attempt started.

## Reading the code and the trace id

The bracket at the end of every message holds the code, then `trace=` and the trace id when a response carried one. Its wording can change in any release, so read the attributes. `error.code` holds the code, for code that branches on it, and `error.trace_id` the trace id, to quote when you report a fault. `dfo.lookup.code` returns the registry entry for a server code, which prints the code and what it means:

```text
graph does not hold 'country/XYZ' at /dcid [node_not_held trace=33955aa626074d4b8e3805c33f7179b8]
node_not_held 404 33955aa626074d4b8e3805c33f7179b8
node_not_held: This deployment's graph does not hold the requested node.
```

```python
import dfo
from dfo.errors import NotFoundError

try:
    dfo.lookup.node("country/XYZ")
except NotFoundError as error:
    print(error)
    print(error.code, error.status, error.trace_id)
    print(dfo.lookup.code(error.code))
```

An error the client raises before any request, such as `invalid_argument`, has a code and no trace id.

## What each refusal tells you

| Class                     | Means                                                                                     | What you do                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `IncompleteAnswerError`   | A part of the question has no reading, or awaits a choice                                 | `answer.choose(...)`, `answer.fetch(partial=True)`, or reword the part   |
| `DeclinedError`           | Search declined the question or answered with the catalogue                               | Ask for a published statistic about a place, a population, or a flow     |
| `InvalidRequestError`     | The arguments break a rule, on the client or the server                                   | Fix the member the message names. `issues` and `alternatives` list fixes |
| `NotFoundError`           | A spec, version, node, code, or other id is unknown                                       | Check the id                                                             |
| `VersionUnavailableError` | A stored version can no longer be fetched, or a derived one can no longer be computed     | Call `dfo.fetch(ref, latest=True)`. `newest_version` names the newest    |
| `AuthenticationError`     | A key is missing, unknown, revoked, expired, or malformed, or the credentials file is bad | Run `dfo auth login`, or fix the file the message names                  |
| `PermissionDeniedError`   | The key lacks a scope the call needs, or a write token is not the share's                 | Ask for the scope, or pass the token `dfo.share` returned                |
| `RateLimitError`          | Over the rate limit after the client's retries                                            | Wait `retry_after` seconds                                               |
| `QuotaExceededError`      | The day's allowance of pins, cards, or shares is spent (`allowance_exhausted`)            | Wait `retry_after` seconds, until the allowance resets                   |
| `ServerError`             | The server failed after the client's retries, or a download failed its check              | Report the trace id                                                      |
| `ContractError`           | A response lacks a member the client acts on, or has a form it does not know              | Upgrade `development-finance`, and report it if the newest release fails |
| `NetworkError`            | The connection failed, or `DFO_OFFLINE=1` blocks a call that needs the server             | Retry later, or read from the cache                                      |
| `DfoTimeoutError`         | The call's `timeout` passed                                                               | Call again to join the build, or raise `timeout`                         |

`NetworkError` is also a `ConnectionError`, and `DfoTimeoutError` a `TimeoutError`, so code that catches those keeps working.

An `InvalidRequestError` from the server lists each member at fault in `issues`, and an issue carries what the server offers in its place under `alternatives`:

```text
one or more facet axes could not be resolved. The server offers USDollar (USDollar). [default_facet_undefined trace=d7c925bb9b19474f88e817b8b5097179]
/facets/provenance None
/facets/measurementMethod None
/facets/unit [{'ref': 'USDollar', 'label': 'USDollar'}]
```

```python
import dfo
from dfo.errors import InvalidRequestError

spec = dfo.search("GDP of Kenya").specs[0]
try:
    dfo.fetch(spec, facets={"unit": None})
except InvalidRequestError as error:
    print(error)
    for issue in error.issues:
        print(issue["pointer"], issue.get("alternatives"))
```

The client refuses a role the spec does not declare before any request, as `invalid_argument` with no issues, for example `entities names "origin", a role the spec does not declare; its roles are place. [invalid_argument]`. The wire name `observationAbout` is refused naming the key to type: `entities names "observationAbout", the wire name of "place"; key it as "place". [invalid_argument]`.

## Reference

### What an error carries

| Attribute     | Holds                                                                       |
| ------------- | --------------------------------------------------------------------------- |
| `code`        | The server's refusal code, or one of the client codes below                 |
| `status`      | The HTTP status, or None when no response arrived                           |
| `detail`      | The server's explanation of this occurrence, or None                        |
| `trace_id`    | The response's trace id, or None                                            |
| `retryable`   | Whether the same call can succeed later                                     |
| `retry_after` | The wait the response's `Retry-After` header asked for, in seconds, or None |
| `problem`     | The parsed problem document, or None                                        |
| `docs_url`    | The page that documents the code, or None                                   |

Four classes carry more:

- `InvalidRequestError.issues` holds the problem document's `issues`, each a `dfo.errors.ProblemIssue` naming a request member, and `.alternatives` the problem document's top-level `alternatives`, each a `dfo.errors.Alternative`. An issue's own offers sit in `issue["alternatives"]`. Both tuples are empty when the server sent none.
- `IncompleteAnswerError.answer` is the answer whose fetch raised it, or None for a server refusal, and `.gaps` lists each part without a reading.
- `VersionUnavailableError.newest_version` is the newest version the server names, or None. A ref cut with `party_totals` has a version of its own, so compare refs to tell whether data changed. For a derived version DFO can no longer compute from the same readings, it is None, and `dfo.fetch(ref, latest=True)` computes it on the newest data.
- `ContractError.pointer` is the JSON Pointer of the member at fault, or None.

### Server codes

A server refusal carries a code from the platform's registry, and the client raises the class for the step the code calls for. `python/tests/core/test_errors.py` checks this table against `contract/actions.json` and `contract/proxy-codes.json`:

| Class                     | Server codes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `InvalidRequestError`     | `binding_invalid`, `capability_unavailable`, `children_anchor_ambiguous`, `children_anchor_required`, `collection_probe_ceiling`, `column_not_droppable`, `column_unknown`, `compare_no_key_matched`, `comparison_periods_disjoint`, `composed_unit_sum_unsupported`, `conflicting_requested_options`, `constraint_violation`, `coverage_insufficient`, `cross_frame_facet_mismatch`, `cross_frame_unit_mismatch`, `cross_frame_unit_unbound`, `default_facet_undefined`, `definition_not_reproducible`, `derived_input_ordinal`, `derived_input_unusable`, `directional_children_unsupported`, `edit_conflict`, `exact_binding_unsupported`, `excel_illegal_character`, `excel_limit`, `excluded_by_registry`, `facet_binding_unsupported`, `facet_heterogeneous`, `facet_not_available`, `facet_probe_ceiling`, `filter_predicate_type_mismatch`, `filter_unit_conversion_unsupported`, `frame_not_refreshable`, `frame_too_large`, `growth_gap_year`, `invalid_role_ref`, `join_no_common_key_columns`, `join_output_collision`, `member_not_resolvable`, `mixed_peers_anchor_types`, `mixed_time_grain`, `non_finite_result`, `observations_unavailable`, `op_spec_invalid`, `open_role_unavailable`, `operation_uncovered`, `option_target_invalid`, `over_ceiling`, `parquet_size_bound`, `payload_too_large`, `pivot_not_homogeneous`, `pivot_not_unique`, `pivot_over_cell_cap`, `pivot_over_column_cap`, `place_levels_mixed`, `population_empty`, `provider_ambiguous`, `publish_conflict`, `query_too_long`, `quotient_of_no_key_matched`, `quotient_of_side_unit_unsupported`, `quotient_of_zero_denominator`, `rate_coverage_gap`, `recipe_not_declared`, `render_target_mismatch`, `rendering_not_recorded`, `request_invalid`, `requested_option_unavailable`, `resolution_ambiguous`, `resource_exhausted`, `role_ambiguous`, `role_incompatible`, `role_signature_incompatible`, `rolling_anchor_unresolved`, `rolling_grain_unsupported`, `rolling_populations_differ`, `rollup_not_summable`, `schema_invalid`, `scope_too_broad`, `several_members`, `shape_mismatch`, `share_id_taken`, `share_not_replaceable`, `share_of_grain_mismatch`, `share_of_key_unknown`, `share_of_key_unmatched`, `share_of_zero_denominator`, `spec_id_mismatch`, `spec_not_exportable`, `stat_var_unresolved`, `sum_of_no_key_matched`, `unit_heterogeneous`, `unsupported_children_anchor_type`, `unsupported_peers_anchor_type`, `write_token_required` |
| `NotFoundError`           | `artifact_not_found`, `code_not_found`, `frame_unavailable`, `node_not_held`, `not_found`, `operation_not_found`, `recipe_not_found`, `skill_not_found`, `skill_resource_not_found`, `snapshot_not_found`, `spec_not_found`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `IncompleteAnswerError`   | `binding_mismatch`, `denominator_not_available`, `entity_ambiguous`, `entity_not_resolved`, `entity_role_not_admitted`, `entity_set_too_large`, `no_matching_slice`, `no_observations`, `qualifier_not_bound`, `role_not_resolved`, `source_ambiguous`, `source_code_ambiguous`, `source_code_not_held`, `source_code_shares_variable`, `source_not_resolved`, `timed_out`, `unit_not_resolved`, `variable_not_resolved`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `VersionUnavailableError` | `artifact_expired`, `snapshot_revoked`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `PermissionDeniedError`   | `licence_not_redistributable`, `provenance_unavailable`, `publish_not_permitted`, `refresh_not_permitted`, `share_import_not_permitted`, `write_refused`, `write_token_invalid`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `RateLimitError`          | `rate_limited`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `QuotaExceededError`      | `allowance_exhausted`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `ServerError`             | `door_not_implemented`, `identity_collision`, `identity_quarantined`, `internal_error`, `members_not_held`, `operation_failed`, `service_unavailable`, `timeout`, `transient_unavailable`, `upstream_error`, `upstream_version_changed`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ContractError`           | `method_not_allowed`, `release_mismatch`, `unsupported_schema_version`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

`rate_limited` and `transient_unavailable` come from the website's proxy, which answers them with 429 and 502, and take the class of that status at any status. A code outside this table raises by its HTTP status: 401 `AuthenticationError`, 403 `PermissionDeniedError`, 404 and 410 `NotFoundError`, 408 `DfoTimeoutError`, 429 `RateLimitError`, any other 4xx `InvalidRequestError`, and 5xx `ServerError`. A refusal with no code takes the code `refusal_without_code` and the class of its status.

### Client codes

The client raises these codes itself, for a fault it finds before a request or in a response. Every DFO client raises the same codes.

| Code                          | Class                     | Retryable | Raised when                                                                                                                                                            |
| ----------------------------- | ------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `answer_declined`             | `DeclinedError`           | no        | Fetching an answer Search declined or answered with the catalogue                                                                                                      |
| `answer_incomplete`           | `IncompleteAnswerError`   | no        | Fetching an answer with a part that has no reading, when the fetch is not partial or no part has a reading                                                             |
| `base_url_invalid`            | `InvalidRequestError`     | no        | A base URL is empty, is not an absolute http or https URL, carries userinfo, a query, a fragment, a dot segment or a backslash, or names a port that is not 1 to 65535 |
| `choice_invalid`              | `InvalidRequestError`     | no        | A choice whose part or option names no gap, several gaps, or no option, or a choice that cannot post back a part                                                       |
| `contract_violation`          | `ContractError`           | no        | A response lacks a member the client acts on, or holds one that contradicts the request                                                                                |
| `credentials_file_invalid`    | `AuthenticationError`     | no        | The credentials file breaks the format (the message names the line)                                                                                                    |
| `credentials_file_unreadable` | `AuthenticationError`     | no        | The credentials file exists but cannot be read                                                                                                                         |
| `deadline_exceeded`           | `DfoTimeoutError`         | yes       | The call's deadline passed before it finished                                                                                                                          |
| `definition_spec_id_mismatch` | `FormatError`             | no        | A stored DatasetRef member's definition names a spec_id other than the member's spec                                                                                   |
| `digest_mismatch`             | `ServerError`             | no        | A downloaded file does not hash to the digest its manifest names, after the files route was asked once more                                                            |
| `download_failed`             | `ServerError`             | yes       | The signed URL a files route names refused, or its fetch failed, after the route was asked once more                                                                   |
| `format_invalid`              | `FormatError`             | no        | Stored JSON for a DatasetRef, a saved dataset or a bundle breaks its format, or a bundle's descriptor lists a file outside the bundle                                  |
| `hash_mismatch`               | `BundleError`             | no        | A bundle's file hashes to another value than its descriptor gives                                                                                                      |
| `header_invalid`              | `InvalidRequestError`     | no        | A header's name is not an HTTP token, its value holds a character outside visible ASCII, spaces, and tabs, or it frames the message                                    |
| `insecure_transport`          | `InvalidRequestError`     | no        | A key would travel over plain http to a host that is not loopback                                                                                                      |
| `invalid_argument`            | `InvalidRequestError`     | no        | A call's arguments break a rule the client checks before any request                                                                                                   |
| `key_empty`                   | `AuthenticationError`     | no        | The `api_key` argument, or what its callable returns, is an empty string                                                                                               |
| `key_invalid`                 | `AuthenticationError`     | no        | The key holds a character outside visible ASCII, or `api_key` is neither a string nor an `ApiKey`                                                                      |
| `match_unresolved`            | `InvalidRequestError`     | no        | A lookup match whose status is not resolved is passed as an entity                                                                                                     |
| `missing_file`                | `BundleError`             | no        | A bundle lacks a file its descriptor lists                                                                                                                             |
| `network_error`               | `NetworkError`            | yes       | The connection failed before a response arrived                                                                                                                        |
| `no_data_resource`            | `BundleError`             | no        | A bundle's descriptor names no data table                                                                                                                              |
| `no_descriptor`               | `BundleError`             | no        | A bundle holds data with no datapackage.json                                                                                                                           |
| `not_a_bundle`                | `BundleError`             | no        | A path holds neither a saved dataset nor part of a bundle, or a Parquet file or ZIP too damaged to read                                                                |
| `offline`                     | `NetworkError`            | no        | `DFO_OFFLINE=1` is set, and the call needs the server                                                                                                                  |
| `profile_not_found`           | `AuthenticationError`     | no        | `DFO_PROFILE` names a profile the credentials file lacks                                                                                                               |
| `profile_without_key`         | `AuthenticationError`     | no        | The chosen profile in the credentials file has no key                                                                                                                  |
| `proxy_invalid`               | `InvalidRequestError`     | no        | A proxy URL read from the environment has a scheme other than http, https, socks5 or socks5h                                                                           |
| `ref_unavailable`             | `InvalidRequestError`     | no        | A dataset read from a bundle folder, which names no version, is asked for its ref                                                                                      |
| `refusal_without_code`        | by status                 | by status | A refusal whose body has no problem document, or a problem document without a code                                                                                     |
| `repeated_spec_id`            | `FormatError`             | no        | A stored DatasetRef holds one spec_id in two members                                                                                                                   |
| `resource_limit`              | `BundleError`             | no        | A bundle passes a bound its reader sets on its descriptor, entries, resources, bytes or workbooks                                                                      |
| `response_too_large`          | `ServerError`             | no        | A decoded response body passes its size cap                                                                                                                            |
| `unexpected_response`         | `ContractError`           | no        | A response the call does not act on, such as a redirect it does not follow, a body that is not JSON, or a status the route does not answer                             |
| `version_unavailable`         | `VersionUnavailableError` | no        | A stored version can no longer be fetched, and no refusal names why                                                                                                    |

### Errors about your files

Two errors in `dfo.errors` concern files and text on your side. Both derive from `DfoError` and from `ValueError`, and their `code` equals their `reason`. `FormatError` means `DatasetRef.from_json` or `dfo.load` read JSON that breaks its format, or a saved file from a later format version, with `reason` (`format_invalid`, `definition_spec_id_mismatch` or `repeated_spec_id`) and a `pointer` to the bad value. `BundleError` means `dfo.load` opened a file or folder that is not a saved dataset or a complete bundle, or a Parquet file or ZIP too damaged to read, with `reason` (`not_a_bundle`, `no_descriptor`, `no_data_resource`, `missing_file`, `hash_mismatch` or `resource_limit`) naming why. A path that does not exist raises `FileNotFoundError`.

A few refusals of a bad argument are also the builtin that 0.1.0 raised, so `except ValueError` or `except TypeError` written for 0.1.0 still catches them: `ApiKey("")`, `ApiKey` of a non-string, `BundleLimits` with a limit below 1, `DatasetRef(...)` with a member of the wrong kind, `data.ref` on a bundle opened from a folder (`ref_unavailable`), and a proxy URL of another scheme (`proxy_invalid`). Catch the `dfo.errors` class in new code.

```python
import dfo
from dfo.errors import FormatError

try:
    dfo.DatasetRef.from_json('{"format_version": 1, "members": []}')
except FormatError as error:
    print(error.reason, error.pointer)  # format_invalid /members
```

### Warnings

Warnings derive from `dfo.errors.DfoWarning`, a `UserWarning`, and point at the line in your code that caused them. `SearchWarning` says Search's reading differs from the question, and `DataWarning` carries a warning the server attached to the data, with its `code` and `severity`. Both carry the `trace_id` of the response. `SeriesLeftOutWarning` says an operation dropped series for missing data, which `data.left_out` lists. `fetch(strict=True)` raises them as errors, and so does `strict=True` on a `dfo.analysis` call.

The client issues these warnings itself:

| Code                    | Class                   | Issued when                                                                                                                       |
| ----------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `key_checksum_mismatch` | `DfoWarning`            | The key's body is empty or its checksum differs (the client sends it anyway)                                                      |
| `key_not_base62`        | `DfoWarning`            | A character of the key after its prefix is outside base62 (the client sends it anyway)                                            |
| `key_unknown_prefix`    | `DfoWarning`            | The key starts with neither `dfo_k_` nor `dfo_p_` (the client sends it anyway)                                                    |
| `ref_digest_changed`    | `DfoWarning`            | A ref's version served a file whose digest differs, because the server rendered the same data again (the client returns the data) |
| `route_deprecated`      | `DfoDeprecationWarning` | A response carries a `Deprecation` or `Sunset` header, once per process for each pair of values                                   |
| `series_left_out`       | `SeriesLeftOutWarning`  | A derived Dataset left series out for missing data, once per fetch (the client returns the data)                                  |
| `server_warning`        | `DfoWarning`            | A response carries an `x-dfo-warning` header, once per process per message                                                        |

To turn every DFO warning into an error for a test run:

```python
import warnings

from dfo.errors import DfoWarning

warnings.simplefilter("error", DfoWarning)
```

## Next

- [Answers and choices](answers.md) covers settling the gaps an `IncompleteAnswerError` lists.
- [Keys and credentials](keys.md) covers fixing an `AuthenticationError`.
