# Use DFO in a data pipeline

A pipeline asks for the same readings on every run, keeps what it got, checks for newer data, and records where the numbers came from. This page builds that loop from `client.search({ codes })`, `DatasetRef`, `client.pin`, `client.fileUrl`, and `Provenance`.

Shares are for display. A pipeline reads data through the calls on this page, and [Cards and shares](shares.md) covers publishing it.

The examples on this page form one program. Each block after the first continues it.

## Find the readings by series code

A pipeline that knows its publisher's series codes asks for them by code. `entities` binds roles as `client.fetch` takes them, and `window` is `"all"`, `"latest"`, or a `[startYear, endYear]` pair:

```text
Answered 3 of 3 parts of your question.
  answered "DT.TDS.MLAT.CD": Kenya's external debt service owed to multilateral creditors, 2015 to 2023. Current US dollars · World Bank International Debt Statistics (IDS).
  answered "DT.TDS.BLAT.CD": Kenya's external debt service owed to bilateral creditors, 2015 to 2023. Current US dollars · World Bank International Debt Statistics (IDS).
  answered "DT.TDS.PBND.CD": Kenya's external debt service owed to bondholders, 2015 to 2023. Current US dollars · World Bank International Debt Statistics (IDS).
```

```ts
import { Client, DatasetRef, Dataset, Provenance, load } from "@developmentfinance/client";
import { readFile, writeFile } from "node:fs/promises";

const client = new Client();
const CODES = ["DT.TDS.MLAT.CD", "DT.TDS.BLAT.CD", "DT.TDS.PBND.CD"];

const answer = await client.search({
  codes: CODES,
  entities: { destination: ["country/KEN"] },
  window: [2015, 2023],
});
console.log(String(answer));
```

Each code becomes one part. A code DFO does not hold, or reads as more than that code's series, comes back as a gap on the answer, so the answer shows which codes failed before any data is fetched. Read the gaps first, and stop the run when one appears:

```ts
if (!answer.complete) {
  for (const gap of answer.gaps) console.log(gap.kind, gap.message);
  throw new Error("DFO does not hold every code");
}

const data = await answer.fetch();
console.log(data.rowCount, "rows");
```

`answer.fetch()` refuses an answer with gaps (`answer_incomplete`). `answer.fetch({ partial: true })` builds the codes that did read. `variable` adds words that choose among the variables of a code, `source: "IDS"` names the source to read the codes from, and `openRoles: ["origin"]` answers creditor by creditor. A question string beside any of these is refused.

When a search holds more codes than the server takes in one request, the server refuses with `request_invalid`. Search in chunks, fetch each, and join the members into one ref:

```ts
const where = { entities: { destination: ["country/KEN"] }, window: [2015, 2023] } as const;
const first = await (await client.search({ codes: CODES.slice(0, 2), ...where })).fetch();
const rest = await (await client.search({ codes: CODES.slice(2), ...where })).fetch();

const ref = new DatasetRef([...first.ref.members, ...rest.ref.members]);
console.log(String(ref));
```

## Keep the readings

A ref names the exact versions a dataset holds. Commit it as JSON, and every later run fetches the same rows. The unpinned versions DFO builds are kept for 30 days, so pin them to keep them fetchable with no time limit:

```ts
await writeFile("debt-service.ref.json", JSON.stringify(ref));
```

<!-- docs-check: skip: pin needs a key with the pin scope -->

```ts
const pinned = await client.pin(await client.fetch(ref));
```

`client.pin` returns the dataset with its versions pinned. It cannot be undone, sends one request per member, and each new pin counts against a daily allowance. A repeat pin of a version already pinned costs nothing. `JSON.stringify(ref)` writes a format the Python client reads with `DatasetRef.from_json`.

## Refresh

Fetch the committed ref with `latest: true` to build the newest versions of the same readings. `sameData` says whether any number moved:

```ts
const committed = DatasetRef.fromJSON(await readFile("debt-service.ref.json", "utf8"));

const newest = await client.fetch(committed, { latest: true });
if (newest.ref.sameData(committed)) {
  console.log("no new data");
} else {
  await writeFile("debt-service.ref.json", JSON.stringify(newest.ref));
  console.log("new data:", String(newest.ref));
}

for (const notice of newest.warnings) {
  console.log(notice.code, notice.severity, notice.message);
}
```

`sameData` compares the versions and the party-totals cut. `equals` also compares renderings, so a rebuild that moves no number can differ by `equals` and agree by `sameData`.

`data.warnings` holds the notices DFO attached to the data, each with a `code`, `severity`, `message`, and the `spec_id` it concerns. Read them from the dataset and log or fail on them. `strict: true` throws the first one instead.

A ref keeps its window: `latest: true` rebuilds the same years on newer versions. To widen the window, search again with the new `window` and commit the new ref.

## Link a reading

A pipeline that reads data with its own HTTP client takes a link to each reading. `client.fileUrl(member)` gives the link to a pinned member's file, and the link reads with no key:

<!-- docs-check: skip: fileUrl needs a pinned version, and pinning needs a key -->

```ts
const held = await client.pin(await client.fetch(committed));
for (const member of held.members) {
  console.log(await client.fileUrl(member));
}
```

```text
https://developmentfinance.org/api/v1/datasets/spec_5e5170d48b8a22e7f5d2e85919397ff3/cv_701c2cb05afe3b8947bd0c17c64d3cb3/file?format=parquet&bundle=false
```

The link serves the member's version as Parquet, in the rendering the member was built in. It answers with a redirect to a storage address that is signed for five minutes, so read it with a client that follows redirects, and commit the API link, not the address it redirects to. `data.ref.members` holds members too, and `client.fileUrl` takes them.

`fileUrl` reads the version's manifest once. An unpinned version throws `InvalidRequestError` with the code `version_not_pinned`, because DFO keeps it for 30 days and a committed link to it would break after that. `error.heldUntil` is the `Date` DFO stops guaranteeing it. Run `client.pin(data)`, then ask again. A member of a derived dataset from `client.analysis` throws `invalid_argument`.

## Record provenance

`data.provenance` is the record of where the data came from: its sentence, citation, the time it left the server, the question, the ref, `pinned` and `heldUntil`, the warnings, and each member's spec, version, digest and retention. `JSON.stringify` writes it:

```ts
await writeFile("debt-service.provenance.json", JSON.stringify(newest.provenance));

const same = Provenance.fromJSON(await readFile("debt-service.provenance.json", "utf8"));
console.log(same.sentence);
console.log(same.equals(newest.provenance));
```

Each member carries its own `pinned` and `heldUntil`, so a record of several readings says which one stops being guaranteed first. Both are null for a member whose retention the client does not know, as in a dataset read from a file an older client saved. After `client.pin(data)`, every member reads as pinned.

`Provenance.fromJSON` takes the text or its parsed value, throws `FormatError` when it breaks the format, and reads a record with keys it does not know, so a record a later client wrote still loads. The Python client writes the same text with `provenance.to_json()` and reads it with `Provenance.from_json`, so a Python job and a TypeScript site can share one file. The same record sits inside a file saved with `data.save`.

## Test offline

Save a dataset once, commit the file, and load it in tests. `load(path)` on Node reads the file with no network and returns a `Dataset` with the same rows, provenance, and ref. `Dataset.fromBytes(bytes)` reads the same file in a browser or from storage:

```ts
await newest.save("debt-service.parquet");

const loaded = await load("debt-service.parquet");
const fromBytes = await Dataset.fromBytes(await readFile("debt-service.parquet"));
console.log(loaded.rowCount, fromBytes.ref.sameData(newest.ref));
```

`data.toBytes()` writes the same file as bytes. Python reads the file with `dfo.load`. A file of several members holds them in one table, so `memberBytes` throws on a loaded dataset, and `client.fetch(data.ref)` fetches each member's own file.

## Next

- [Cards and shares](shares.md) publishes what a pipeline built, and keeps the links when the data refreshes.
- [Settings](settings.md) lists the options a CI job sets, such as `baseUrl` and the key.
