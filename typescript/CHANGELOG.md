# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `data.partyTotalsLeftOut` names the group totals a fetch left out of each member, as `PartyTotalsLeftOut` entries of spec id, party role, dcids and provenance, and `String(data)` counts them. `data.bytes()` writes them under a new `dfo.party_totals_left_out` key, which Python's `dfo.load` reads and its 0.1.0 release ignores.

- `answer.facts` gives each part's assumptions, departures, requested operations and warnings as typed `PartFacts`, one entry per part in the order of `answer.parts`, with a candidates part's `readingAssumptions` by spec id. `partFacts(part)` reads one part, and `PartFacts` is exported from the package root.

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
