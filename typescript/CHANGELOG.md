# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

The first release of `@developmentfinance/client`, the TypeScript client for the Development Finance Observatory APIs. It is ESM only and runs on Node 22.18 or later, Bun, Deno, Workers, and browsers.

### Added

- `client.search(question)` returns an `Answer` whose text form is Search's sentence and the next call to make. `answer.choose(option, { part })` settles a part that awaits a choice, and `answer.fetch()` and `client.fetch(spec)` return a `Dataset`, narrowed with `window`, `entities` and `facets`.
- `data.ref` names the exact versions a dataset holds. `client.fetch(ref)` reads them again, and `client.fetch(ref, { latest: true })` builds the newest. Refs and the Parquet file from `data.bytes()` are shared with the Python client.
- `client.lookup` resolves names, reads graph nodes and codes, and lists what Search holds data on.
- `client.analysis` runs DFO's operations on the server and returns a derived `Dataset`: `filter`, `aggregate`, `growth`, `rank`, `quotientOf`, `shareOf`, `join`, `sumOf` and `compare`, each with `strict`, `timeout` and `signal`. `growth` with `change: "relative"` is a fraction where 0.25 is a 25% rise and `change: "difference"` is in the data's unit, and `shareOf` is a percentage.
- `recipe(start)` describes a chain of operations without running it, and `client.fetch(recipe)` runs it in one request. `latestYear(offset)` names a year DFO settles each run. `client.fetch(ref)` reads a derived ref, and `client.fetch(ref, { latest: true })` computes it again on the newest data.
- `Dataset.leftOut` lists the series an operation dropped for missing data, with the step and the reason, and `SeriesLeftOutWarning` (`series_left_out`) says so once per fetch, thrown under `strict: true`. A derived dataset's text form names its steps, the period `latestYear` settled on, and the count of series left out.
- `client.pin(data)` keeps a dataset's versions fetchable with no time limit.
- `client.cards` stores `line`, `bar`, `table`, `stat` and `source` cards of a dataset. `stat` with `change: "percent"` is a percentage where 25 is a 25% rise.
- `client.share(cards, { latest })` publishes cards at a public URL that follows new data or keeps today's versions, and returns its `shw_` write token. `replace`, `client.snapshot` and `client.unshare` change it with the token, and `client.history` lists what each slot served.
- `client.fetch(share, { slot, asOf })` returns the data a share's slot shows, or showed on a date.
- Errors derive from `DfoError`, one class per next step, and each message ends with its code, and with the trace id when there is one. The client retries failures that can clear, honouring `Retry-After`.
