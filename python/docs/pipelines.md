# Use DFO in a data pipeline

A pipeline asks for the same readings on every run, keeps what it got, checks for newer data, and records where the numbers came from. This page builds that loop from `dfo.search(codes=...)`, `DatasetRef`, `dfo.pin`, `dfo.file_url`, and `Provenance`.

Shares are for display. A pipeline reads data through the calls on this page, and [Cards and shares](shares.md) covers publishing it.

The blocks on this page run in order, as cells of one notebook.

## Find the readings by series code

A pipeline that knows its publisher's series codes asks for them by code. `entities` binds roles as `dfo.fetch` takes them, and `window` is `"all"`, `"latest"`, or a `(start_year, end_year)` pair:

```text
Kenya's external debt service owed to multilateral creditors, external debt service owed to bilateral creditors, and external debt service owed to bondholders, 2015 to 2023. Current US dollars · World Bank International Debt Statistics (IDS).
  Fetch: answer.fetch()
```

```python
import dfo

CODES = ["DT.TDS.MLAT.CD", "DT.TDS.BLAT.CD", "DT.TDS.PBND.CD"]

answer = dfo.search(
    codes=CODES,
    entities={"destination": ["country/KEN"]},
    window=(2015, 2023),
)
print(answer)
```

Each code becomes one part. Two kinds of code come back as a gap on the answer, so the answer shows them before any data is fetched: a code DFO does not hold, and a code whose reading holds more than that code's series. Read the gaps first, and stop the run when one appears:

```python
if not answer.complete:
    for gap in answer.gaps:
        print(gap.kind, gap.message)
    raise SystemExit("A series code did not read as its own series; see the gaps above")

data = answer.fetch()
print(len(data), "rows")
```

`answer.fetch()` refuses an answer with gaps (`answer_incomplete`). `answer.fetch(partial=True)` builds the codes that did read. The message of a code that reads as more than its series names the codes its reading holds, and gives two ways on: narrow the search with `variable` or `source`, or take the reading as it is with `dfo.fetch(answer.parts[i].spec)`. `variable` adds words that choose among the variables of a code, `source="IDS"` names the source to read the codes from, and `open_roles=["origin"]` answers creditor by creditor. A positional question beside any of these raises `InvalidRequestError` (`invalid_argument`).

When a search holds more codes than the server takes in one request, the server refuses with `request_invalid`. Search in chunks, fetch each, and join the members into one ref:

```python
where = {"entities": {"destination": ["country/KEN"]}, "window": (2015, 2023)}
first = dfo.search(codes=CODES[:2], **where).fetch()
rest = dfo.search(codes=CODES[2:], **where).fetch()

ref = dfo.DatasetRef.of(member for part in (first, rest) for member in part.members)
print(ref)
```

## Keep the readings

A ref names the exact versions a dataset holds. Commit it as JSON, and every later run fetches the same rows. The unpinned versions DFO builds are kept for 30 days, so pin them to keep them fetchable with no time limit:

```python
from pathlib import Path

Path("debt-service.ref.json").write_text(ref.to_json())
```

<!-- docs-check: skip: pin needs a key with the pin scope -->

```python
data = dfo.pin(dfo.fetch(ref))
```

`dfo.pin` returns the dataset with its versions pinned. It cannot be undone, sends one request per member, and each new pin counts against a daily allowance. A repeat pin of a version already pinned costs nothing. `ref.to_json()` writes a format the TypeScript client reads with `DatasetRef.fromJSON`.

## Refresh

Fetch the committed ref with `latest=True` to build the newest versions of the same readings. `same_data` says whether any number moved:

```python
ref = dfo.DatasetRef.from_json(Path("debt-service.ref.json").read_text())

newest = dfo.fetch(ref, latest=True)
if newest.ref.same_data(ref):
    print("no new data")
else:
    Path("debt-service.ref.json").write_text(newest.ref.to_json())
    print("new data:", newest.ref)

for notice in newest.warnings:
    print(notice.code, notice.severity, notice.message)
```

`same_data` compares the versions and the party-totals cut. `ref == other` also compares renderings, so a rebuild that moves no number can differ by `==` and agree by `same_data`.

`data.warnings` holds the notices DFO attached to the data, each with a `code`, `severity`, `message`, and the `spec_id` it concerns. Read them from the dataset and log or fail on them. `strict=True` raises them as `DataWarning` instead.

A ref keeps its window: `latest=True` rebuilds the same years on newer versions. To widen the window, search again with the new `window` and commit the new ref.

## Link a reading

A pipeline that reads data with its own HTTP client takes a link to each reading. `dfo.file_url(member)` gives the link to a pinned member's file, and the link reads with no key:

<!-- docs-check: skip: file_url needs a pinned version, and pinning needs a key -->

```python
data = dfo.pin(dfo.fetch(ref))
for member in data.members:
    print(dfo.file_url(member))
```

```text
https://developmentfinance.org/api/v1/datasets/spec_5e5170d48b8a22e7f5d2e85919397ff3/cv_701c2cb05afe3b8947bd0c17c64d3cb3/file?format=parquet&bundle=false
```

The link serves the member's version as Parquet, in the rendering the member was built in. It answers with a redirect to a storage address that is signed for five minutes, so read it with a client that follows redirects, and commit the API link, not the address it redirects to. `data.ref.members` holds members too, and `dfo.file_url` takes them.

`file_url` reads the version's manifest once. An unpinned version raises `InvalidRequestError` with the code `version_not_pinned`, because DFO keeps it for 30 days and a committed link to it would break after that. `error.held_until` is the date DFO stops guaranteeing it. Run `dfo.pin(data)`, then ask again. A member of a derived dataset from `dfo.analysis` raises `invalid_argument`.

## Record provenance

`data.provenance` is the record of where the data came from: its sentence, citation, the time it left the server, the question, the ref, `pinned` and `held_until`, the warnings, and each member's spec, version and digest. `to_object()` gives it as plain JSON values:

```python
import json

record = newest.provenance.to_object()
Path("debt-service.provenance.json").write_text(json.dumps(record, indent=2))

same = dfo.Provenance.from_object(
    json.loads(Path("debt-service.provenance.json").read_text())
)
print(same.sentence)
print(same.ref == newest.ref)
```

`Provenance.from_object` raises `FormatError` when the object breaks the format. The TypeScript client writes and reads the same object with `provenance.toObject()` and `Provenance.fromObject`, so a Python job and a TypeScript site can share one file. The same record sits inside a file saved with `data.save`.

## Test offline

Save a dataset once, commit the file, and load it in tests. `dfo.load` reads the file with no network and returns a `Dataset` with the same rows, provenance, and ref:

```python
newest.save("debt-service.parquet")

data = dfo.load("debt-service.parquet")
table = data.to_arrow()
assert {"time_period", "value"} <= set(table.column_names)
assert data.ref.same_data(newest.ref)
print(table.num_rows)
```

`data.to_bytes()` writes the same file as bytes, and `dfo.load` reads bytes too. TypeScript reads the file with `load(path)` on Node and `Dataset.fromBytes(bytes)` anywhere.

## Next

- [Fetch and keep a dataset](datasets.md) covers refs, retention, and the saved file.
- [Cards and shares](shares.md) publishes what a pipeline built, and keeps the links when the data refreshes.
