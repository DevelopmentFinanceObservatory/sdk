# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

The first release of `development-finance`, the Python client for the Development Finance Observatory APIs. It imports as `dfo` and runs on Python 3.12 or later.

### Added

- `dfo.search(question)` returns an `Answer` that prints what Search understood and the line to type next. `answer.choose(option, part=...)` settles a part that awaits a choice, by index or label.
- `answer.fetch()` and `dfo.fetch(spec)` return a `Dataset`. A long build shows progress and waits as long as the build takes unless `timeout=` is set. A fetch that is interrupted or times out leaves the build running, and the same fetch joins it.
- `dfo.fetch(spec)` narrows a reading on the server with `window`, `entities` and `facets`, `entities` keyed by role as `place`, `origin` or `destination`, and `answer.fetch` narrows every reading of an answer with them. `layout="frame"` returns one reading's pipeline frame.
- Datasets leave out party totals, such as the DAC total beside its members, unless `party_totals=True`, and put the reading columns first, then the columns that vary between rows, then the constant ones, with `stat_var` last. Rows sort so that each series reads in time order. Two cells hold the same value when they are equal as values: 0.0 and -0.0 are one value, as are any two NaNs, a list cell matches another item by item in order, and a struct or map cell field by field in any order. A list, struct or map column is no sort key.
- `data.to_pandas()`, `data.to_polars()` and `data.to_arrow()` convert a dataset, with pandas and polars as optional extras. `data.save(path)` writes a Parquet file that `dfo.load(path)` reads back.
- `data.ref` names the exact versions a dataset holds. `dfo.fetch(data.ref)` reads them again, and `dfo.fetch(data.ref, latest=True)` builds the newest. `ref.to_json()` and `DatasetRef.from_json(text)` carry a ref as JSON that the TypeScript client also reads. When a ref's file has expired or is no longer listed, the fetch asks the version's file selector for its `format`, `bundle` and `layout`, then builds the version again.
- `answer.to_json()` and `Answer.from_json(text)` save an answer and restore it.
- `dfo.lookup` resolves names to graph nodes, reads a node or a code's registry entry, and lists what Search holds data on. Each returns a small type from `dfo.types` that prints one line, such as `Germny -> not found; nearest: Germany  country/DEU`, and keeps the server's JSON as `raw`.
- `Client` and `AsyncClient` carry the same calls for one configuration each: `api_key`, `base_url`, `headers`, `header_provider`, `timeout`, `max_retries` and the cache. `dfo.configure` sets the client the module functions use.
- Every request to the API carries `X-DFO-Client`, such as `dfo-python/0.1.0 (CPython 3.14)`. A `headers` or `header_provider` entry that names it raises `InvalidRequestError` with `header_invalid`.
- The client works without a key under a per-IP quota. `dfo auth login` stores a key in a credentials file every DFO client reads, and `dfo auth status` prints the key the client sends, masked, and where its requests go. `DFO_API_KEY`, `DFO_PROFILE` and `DFO_BASE_URL` configure the client from the environment. A base URL is an absolute http or https URL with no userinfo, query, fragment, dot segment or backslash, whose port, when it names one, is 1 to 65535; any other raises `InvalidRequestError` with `base_url_invalid`.
- Downloads are cached on disk, verified against their digest, and readable offline with `DFO_OFFLINE=1`. `dfo cache clear` empties the cache.
- Errors live in `dfo.errors`, one class per next step, and each message ends with its code, and with the trace id when there is one. The client retries failures that can clear, honouring `Retry-After`.
- `dfo.types` holds the types of what answers and datasets contain. The package ships `py.typed`.
