# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `data.partyTotalsLeftOut` names the group totals a fetch left out of each member, as `PartyTotalsLeftOut` entries of spec id, party role, dcids and provenance, and `String(data)` counts them. `data.toBytes()` writes them under a new `dfo.party_totals_left_out` key, which Python's `dfo.load` reads and its 0.1.0 release ignores.
- `answer.facts` gives each part's assumptions, departures, requested operations and warnings as typed `PartFacts`, one entry per part in the order of `answer.parts`, with a candidates part's `readingAssumptions` by spec id. `partFacts(part)` reads one part, and `PartFacts` is exported from `@developmentfinance/client/types`.
- The `attemptTimeout` client option bounds one request attempt, 30 seconds by default, as `timeout` did before. `client.withOptions` takes it too, and takes `timeout: null` to clear the client's `timeout` so each call keeps its own default.
- A role in `entities`, for `client.fetch` and `answer.fetch`, takes the resolved `Match` and the `Entity` objects `client.lookup.resolve` returns, read as their dcids with no request. A `Match` that did not resolve throws `InvalidRequestError` (`match_unresolved`) before any request, naming the dcid of its first candidate, else of its nearest match.
- `SpecFetchOptions`, `RefFetchOptions`, `RecipeFetchOptions` and `ShareFetchOptions` type each target's options, and `EntityChoice` a role's entry in `entities`.
- `data.save(path)` writes the file `data.toBytes()` returns, on Node. Outside Node it throws `InvalidRequestError` (`invalid_argument`) naming `toBytes()`.
- `data.question` holds the question a dataset fetched from an answer answers, else null, and `data.fetchedAt` the time the data left the server, to the second. A saved file keeps them under two new top-level keys, `dfo.question` (absent when there is no question) and `dfo.fetched_at`, each a JSON string, the time in UTC ISO 8601 such as `"2026-11-13T09:15:42Z"`. Python's 0.1.0 `dfo.load` ignores both.
- `data.licence` joins the licences the sources publish under with "; ", as Python's `Dataset.licence` does.
- `docs/settings.md` lists every client option and environment variable with its default and precedence.
- `DFO_TIMEOUT`, in seconds, and `DFO_MAX_RETRIES` set `timeout` and `maxRetries` for a client built without them, where the platform has a process environment. An option wins over the variable and leaves it unread. `timeout: null` on the constructor sets no client bound, so each call keeps its own default whatever `DFO_TIMEOUT` holds; it threw `InvalidRequestError` before. An invalid variable throws `InvalidRequestError` (`invalid_argument`) when the client is built, naming the variable. `client.withOptions` reads neither.

### Changed

- A fetch posts the party-totals cut, its default, as `party_totals: false` in the build request's `options`, the spelling DFO's API takes from dfo-apis 133262c5e on, in place of `without_party_totals: true`. Release 0.2.0 needs a server that accepts `options.party_totals`, and the release workflow checks that production does before it publishes. `DatasetRef.fromJSON` and a served rendering read either spelling, and `ref.toJSON()` still writes `without_party_totals: true`, so 0.1.0 reads a ref this release writes. The client follows the API contract at spec-kit 7ef7f71.
- A citation source's licence reads from the served `licence` and `licence_url`, falling back to `license` and `license_url` when the response lacks them, as a response from a server before the rename does.
- A fetch reads `trace.party_totals_left_out` leniently. A trace that is no object or a member that is no list names no totals, and a malformed entry is dropped while the entries beside it still read. A manifest with a broken trace no longer raises `ContractError`.
- Breaking: an error's message ends `[<code> trace=<id>]`, or `[<code>]` with no trace id, in place of `[<code> · trace <id>]`. The bracket's text may change between releases, so read `error.code` and `error.traceId` in code.
- Breaking: every error a public call throws is a `DfoError`. `FormatError` extends `DfoError` and no longer `TypeError`. Its `code` equals its `reason`, and its `reason` and `pointer` name the fault.
- Breaking: a secret `dfo_k_` key in a browser throws `InvalidRequestError` (`invalid_argument`) in place of `TypeError`. So do `new DatasetRef` given dataset and derived members together, `data.memberBytes(index)` past the last member in place of `RangeError`, and `data.toRows()` on an INT64 value beyond a JavaScript number's exact range in place of `RangeError`. `RawResponse.json()` on a body that is not JSON throws `ContractError` (`unexpected_response`) in place of `SyntaxError` or `TypeError`.
- Breaking: the client's `timeout` option bounds a whole call, retries, build waits and downloads included, and a call's own `timeout` replaces it. Unset, each call keeps its own default: `search` and `answer.choose` stop after 60 seconds, and `fetch` waits as long as the build takes. Code that set `timeout` to bound one attempt sets `attemptTimeout` instead.
- Breaking: the `timeout` of a lookup and of `client.request` bounds the whole call, retries included, in place of one attempt.
- Breaking: `client.fetch` has one overload per target, so `tsc` refuses an option the target does not take: `latest`, `asOf` or `slot` with a spec, a narrowing or `partyTotals` with a ref, a recipe or a share, `onProgress` or a layout other than `frame` with a recipe, and `latest` or a layout other than `frame` with a share. A target typed as a union of kinds takes `signal`, `timeout` and `strict`. The run-time checks are unchanged.
- Breaking: `data.bytes()` is `data.toBytes()`.
- Breaking: `CitationSource`, the type of `data.citation.sources`, is the client's own: `ref`, `label`, `licence`, `licenceUrl` and `url`, with null for a field the source leaves out. It spells the licence as Python does in place of the server's `license` and `license_url`, and drops the server's other fields. The server's type stays in `@developmentfinance/client/wire`. Saved files keep their keys.
- Breaking: a part in `answer.parts`, and the `Part`, `KnownPart`, `DefinitePart`, `CandidatesPart`, `NoDataPart`, `UnsupportedPart` and `UnknownPart` types `@developmentfinance/client/types` exports, types only the members the client checks: `status`, a definite part's `spec`, a candidates part's `candidates.specs`, a no-data part's `no_data.reason` and an unsupported part's `unsupported.code`, and within each spec its `spec_id`, `definition.spec_id`, `definition.identity` as an object and `resolved` as an object. Every other member, `assumptions`, `departures`, `operations`, `warnings`, `variable_text` and every member of a spec's `resolved` among them, is `unknown`. Read those from `answer.facts`. `@developmentfinance/client/wire` keeps the schema types.
- Breaking: the `resolved` of a `Spec`, as `answer.specs` and `candidate.spec` hold it, types its members `unknown`, since the client does not check them. `ResolvedSpec` in `@developmentfinance/client/wire` keeps the schema type.
- Breaking: `isKnownPart` is true only for a part that holds the members the client checks for its status, as JSON types, in place of any part with a known `status`. Every part of an answer from `client.search` with a known status passes.
- Breaking: `QueryOption`, a refusal's choice in `gap.options`, is now `Option`, the name the Python client uses.
- Breaking: the package root exports `Client`, `Answer`, `Dataset`, `DatasetRef`, `Spec`, `recipe`, `latestYear`, `VERSION` and `ClientOptions`, the names Python's `dfo` holds at its top level, in place of 160 names. The errors, the warnings, `isDfoError` and the types their fields carry move to `@developmentfinance/client/errors`, as in Python's `dfo.errors`. Every other name moves to `@developmentfinance/client/types`, as in Python's `dfo.types`: the types answers, datasets, cards, shares and lookups contain, the option types, the `Analysis`, `Cards` and `Lookup` classes, `ApiKey`, `RawResponse`, and the helpers `specRoles`, `partFacts`, `isKnownPart`, `PART_STATUSES`, `isDatasetMember` and `isDerived`. Names are unchanged. An import from the root of a name that moved now comes from its subpath.

### Removed

- Breaking: `answer.choose(part, option)`, the old call form, throws `InvalidRequestError` (`invalid_argument`) like any other options that are not an object, in place of a `TypeError` that spelled out the new form.
- Breaking: the `withoutPartyTotals` and `without_party_totals` options get the generic unknown-option refusal, in place of a hint that names `partyTotals` and its default.

### Fixed

- `answer.timedOut` is true when a part's own no-data reason is `timed_out`, as well as when Search's diagnostics say so, and `Answer.fromJSON` works it out again.

## [0.1.0] - 2026-11-13

The first release of `@developmentfinance/client`, the TypeScript client for the Development Finance Observatory APIs. It is ESM only and runs on Node 22.18 or later, Bun, Deno, Workers, and browsers.

### Added

- `client.search(question)` returns an `Answer` whose text form is Search's sentence and the next call to make. `answer.choose(option, { part })` settles a part that awaits a choice, and `answer.fetch()` and `client.fetch(spec)` return a `Dataset`, narrowed with `window`, `entities` and `facets`.
- `data.ref` names the exact versions a dataset holds. `client.fetch(ref)` reads them again, and `client.fetch(ref, { latest: true })` builds the newest. Refs and the Parquet file from `data.bytes()` are shared with the Python client.
- `client.lookup` resolves names, reads graph nodes and codes, and lists what Search holds data on.
- `client.analysis` runs DFO's operations on the server and returns a derived `Dataset`: `filter`, `aggregate`, `growth`, `rank`, `quotientOf`, `shareOf`, `join`, `sumOf` and `compare`, each with `strict`, `timeout` and `signal`. `growth` with `change: "relative"` is a fraction where 0.25 is a 25% rise and `change: "difference"` is in the data's unit, and `shareOf` is a percentage.
- `recipe(start)` describes a chain of operations without running it, and `client.fetch(recipe)` runs it in one request. `latestYear(offset)` names a year DFO settles each run. `client.fetch(ref)` reads a derived ref, and `client.fetch(ref, { latest: true })` computes it again on the newest data.
- `Dataset.leftOut` lists the series an operation dropped for missing data, with the step and the reason, and `SeriesLeftOutWarning` (`series_left_out`) says so once per fetch, thrown under `strict: true`. A derived dataset's text form names its steps, the period `latestYear` settled on, and the count of series left out. The file from `data.bytes()` declares format version 2 for a derived dataset, which a client that reads format 1 alone refuses as a later format, and format 1 for a dataset of dataset versions. `isDatasetMember(member)` and `isDerived(member)` narrow a member of a dataset or a ref, so a dataset member's `spec` passes to `client.fetch`.
- Each `Root` of a derived member names the rendering the recipe read it in, and `groupby`, a `Groupby` of `by`, `op` and `levels`, when the recipe read it summed, as a breakdown or a sum over StatVars does. The ref keeps it through `JSON.stringify`, `DatasetRef.fromJSON` and `data.bytes()`.
- `client.pin(data)` keeps a dataset's versions fetchable with no time limit.
- `client.cards` stores `line`, `bar`, `table`, `stat` and `source` cards of a dataset. `stat` with `change: "percent"` is a percentage where 25 is a 25% rise.
- `client.share(cards, { latest })` publishes cards at a public URL that follows new data or keeps today's versions, and returns its `shw_` write token. `replace`, `client.snapshot` and `client.unshare` change it with the token, and `client.history` lists what each slot served.
- `client.fetch(share, { slot, asOf })` returns the data a share's slot shows, or showed on a date. A slot whose version lists no frame-layout file, as a default fetch leaves it, reads the file the version's file selector renders from its stored frame.
- Errors derive from `DfoError`, one class per next step, and each message ends with its code, and with the trace id when there is one. The client retries failures that can clear, honouring `Retry-After`.
