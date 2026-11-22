# Use it in a web app

A page gets DFO data in one of two ways. It reads data a data step built earlier, frozen at a pinned version or following a live share, with no key and no server code of its own. Or it asks a question through your server, which searches and builds for the reader and keeps the key there. This page covers both, reading built data first.

Every example on this page runs in Node as written, apart from the lines that need a page.

## Put data on a page

Build the data once, in a data step you run by hand or on a schedule, and commit what the page reads. The choice follows what the page shows:

- A page that opens on numbers frozen when the site was built commits a pinned ref and reads it with `client.fetch(ref)`.
- A page that shows the newest data on each view commits a ref and reads it with `client.fetch(ref, { latest: "stored" })`, or commits a live share's data URL and reads it with `fetch`.
- A page on `developmentfinance.org` that shows a figure computed on the newest data commits a recipe's readings and runs it with `client.fetch(recipe, { latest: "stored" })`.
- A page that must make no DFO request at all ships the saved file in its own assets.

### The routes a page may call

Browsers reach the API through `https://developmentfinance.org/api/v1`, the client's default base URL, where the website's gateway answers. Pages on `developmentfinance.org`, `www.developmentfinance.org`, and `preview.developmentfinance.org`, the prototype previews on `one-org.workers.dev`, and `http://localhost:3000` and `http://localhost:8787` may read the datasets routes below. The gateway answers their preflight and labels each answer with `Access-Control-Allow-Origin`. Share slot data answers any origin.

For a file, the API answers with a redirect to a signed storage address. The gateway follows that redirect itself and answers 200 with the file's bytes, so a page makes one request for the file, to the gateway.

| Route                                                          | What reads it                                           | Pages that may call it                                     | `Cache-Control`                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `GET /api/v1/datasets/{spec_id}/{content_version}`             | `client.fetch(ref)`, the manifest                       | DFO origins                                                | `public, max-age=60, s-maxage=300`                                                          |
| `GET /api/datasets/{spec_id}/{content_version}/files/{digest}` | `client.fetch(ref)`, the file                           | DFO origins                                                | Pinned: `public, max-age=3600, s-maxage=31536000`. Held: `public, max-age=60, s-maxage=300` |
| `GET /api/v1/datasets/{spec_id}`                               | `client.fetch(ref, { latest: "stored" })`, the manifest | DFO origins                                                | `public, max-age=60, s-maxage=60`                                                           |
| `POST /api/v1/datasets/analysis`                               | `client.fetch(recipe)`, the computation                 | `developmentfinance.org`                                   | `no-store`                                                                                  |
| `GET /api/v1/presentation/shares/{share_id}/slots/{slot}/data` | `share.dataUrls`, read with `fetch`                     | Any origin                                                 | Live: `no-cache`. Snapshot: `public, max-age=300`                                           |
| Search, builds, pins, cards, and shares                        | `client.search`, `answer.fetch`                         | `developmentfinance.org`, and other pages through a server | Not cached                                                                                  |

`max-age` is how long the browser keeps an answer, and `s-maxage` how long the headers let a shared cache, such as the CDN in front of the site, keep it. Every other answer on the datasets routes, a refusal, a redirect the gateway did not follow, or a 202 for a build, is `no-store`. A page on any other origin calls your own server route, as in [Answer a question from a page](#answer-a-question-from-a-page), or a proxy of the API on the page's own origin.

### Open on a frozen snapshot

The data step searches, builds, pins the versions, and writes the ref as JSON beside the page's code:

```ts
// fetch-data.mts, run with node
import { Client } from "@developmentfinance/client";
import { mkdir, writeFile } from "node:fs/promises";

const client = new Client();
const answer = await client.search("ODA from Germany to Kenya, 2015 to 2024");
const data = await client.pin(await answer.fetch());

await mkdir("data", { recursive: true });
await writeFile("data/kenya-oda.ref.json", JSON.stringify(data.ref));
```

`client.pin` keeps the versions fetchable with no time limit, and any caller may pin, with or without a key. DFO holds an unpinned version for about 30 days, and a ref to it stops reading after that, so a page commits a pinned ref. The ref is about 1.3 KB of JSON: each member's spec, content version, and file digest.

The page reads the ref and gets the dataset with its provenance:

```text
Germany's net disbursements (bilateral flows) to Kenya for official development assistance, 2015 to 2024. Current US dollars · OECD DAC2a.
OECD DAC2A (2026), via the Development Finance Observatory
10 rows, pinned
```

```ts
// In the page
import { Client, DatasetRef } from "@developmentfinance/client";
import committed from "./data/kenya-oda.ref.json" with { type: "json" };

const client = new Client({ apiKey: false });
const data = await client.fetch(DatasetRef.fromJSON(committed));
const rows = await data.toRows();

console.log(data.sentence);
console.log(data.citation.text);
console.log(`${rows.length} rows, ${data.pinned ? "pinned" : "held"}`);
```

`client.fetch(ref)` sends two GETs per member, for the version's manifest and for the file the ref's digest names. It makes no Search call and no build. `data.sentence`, `data.citation`, and `data.provenance` hold what the data step got, so the page's source line comes from `data.citation.text`. The file's bytes never change under its digest, which is why the gateway's answer for a pinned file lets a shared cache keep it for a year.

With a bundler that splits dynamic imports, a page that fetches a ref and calls `toRows` loads about 84 KB gzip of the client, and the Parquet writer's 16 KB gzip only when it calls `toBytes`. Those figures are for `esbuild --bundle --splitting --format=esm --minify --platform=browser`.

To move the page to newer data, run the data step again with `client.fetch(DatasetRef.fromJSON(committed), { latest: true })`, pin the result, and commit the new ref when `sameData` says the numbers moved. [Refresh](pipelines.md#refresh) covers the loop.

### Show the latest data on view

A page that commits a ref, as in [Open on a frozen snapshot](#open-on-a-frozen-snapshot), reads the newest version DFO stores of the same readings with `latest: "stored"`:

<!-- docs-check: skip: needs the stored-version read, which the dev API does not serve yet -->

```ts
// In the page
import { Client, DatasetRef } from "@developmentfinance/client";
import committed from "./data/kenya-oda.ref.json" with { type: "json" };

const client = new Client({ apiKey: false });
const data = await client.fetch(DatasetRef.fromJSON(committed), { latest: "stored" });
const rows = await data.toRows();

console.log(data.freshness, rows.length);
console.log(data.citation.text);
```

The fetch sends two GETs per member: the spec's manifest at `GET /api/v1/datasets/{spec_id}`, with the member's rendering as its query, and the file. It makes no Search call, and `data.sentence` is the ref's. DFO answers from the newest version it stores. `data.freshness` says what the data is, the worst of its members:

- `current`: DFO found this version the newest at a check in the last 15 minutes.
- `pending`: DFO is checking for newer data, and the version is the one its last check found.
- `stale`: DFO could not start a check, or the last one failed, so newer data may exist.

`data.freshness` is null when the API states no value or one this client does not know. DFO serves a stored version younger than 7 days at once and checks for newer data in the background, so a reading nobody opened in that time can be up to 7 days behind for its first reader. A version older than 7 days is rebuilt on read. The call waits, polling the build at `/api/v1/datasets/operations/{operation_id}`, and a version it waited for is `current`. The gateway and the browser cache the manifest read for up to two minutes (60 seconds at the CDN plus 60 seconds in the browser), so a page can lag by that much more. `data.ref` names the versions read, and leaves the freshness out, as a saved file does.

The gateway sends no CORS headers on the operation route, so on a page served from any origin but `https://developmentfinance.org` the poll fails. Read the committed ref then:

<!-- docs-check: skip: needs the stored-version read, which the dev API does not serve yet -->

```ts
// In the page
import { Client, DatasetRef } from "@developmentfinance/client";
import type { Dataset } from "@developmentfinance/client";
import { isDfoError } from "@developmentfinance/client/errors";
import committed from "./data/kenya-oda.ref.json" with { type: "json" };

const client = new Client({ apiKey: false });
const ref = DatasetRef.fromJSON(committed);
let data: Dataset;
try {
  data = await client.fetch(ref, { latest: "stored" });
} catch (error) {
  if (!isDfoError(error)) throw error;
  data = await client.fetch(ref);
}
```

### Compute on the latest data on view

A page on `developmentfinance.org` runs a recipe on the newest version DFO stores of each reading it starts from:

<!-- docs-check: skip: reads a committed ref file, and the analysis route answers pages on developmentfinance.org alone -->

```ts
// In the page
import { Client, DatasetRef, recipe } from "@developmentfinance/client";
import committed from "./data/donors.ref.json" with { type: "json" };

const client = new Client({ apiKey: false });
const largest = recipe(DatasetRef.fromJSON(committed)).rank({
  by: "origin",
  per: "destination",
  window: [2023, 2023],
  how: "sum",
  limit: 1,
});
const data = await client.fetch(largest, {
  latest: "stored",
  signal: AbortSignal.timeout(10_000),
});

console.log(data.freshness, (await data.toRows()).length);
```

The fetch posts the recipe with `latest: "stored"` and `include: ["manifest"]`, each committed dataset version sent as its spec in the same rendering, so a ref minted on another deployment still reads. DFO reads each reading at the version it stores as the newest, with no build while it stores one, and answers with the computed frame's manifest. The fetch then downloads the frame from `GET /api/v1/datasets/derived/{spec_id}/{content_version}/files/{digest}` and checks it against the digest: two requests per recipe, whatever the number of readings. `data.freshness` is the worst freshness the answer's `resolved_roots` states for the datasets the recipe read. A reading DFO stores no version of answers 202, and the fetch posts again after the wait the answer asks for. A recipe that starts from a frame DFO computed runs on the stored versions of the readings that frame read.

The gateway answers no preflight on the analysis route, so a page on another origin, a preview on `one-org.workers.dev` included, cannot run a recipe. Such a page shows the figures its data step committed, and calls the recipe from your own server route when it needs newer ones.

A live share shows the newest data of a card instead, with no client on the page. Make one once, in a data step, and commit its data URL:

<!-- docs-check: skip: makes a share, which spends the daily share allowance; Cards and shares runs the same calls -->

```ts
// make-share.mts, run once with node
import { Client } from "@developmentfinance/client";

const client = new Client();
const answer = await client.search("ODA from Germany to Kenya, 2015 to 2024");
const card = await client.cards.table(await answer.fetch(), { title: "German aid to Kenya" });
const share = await client.share(card, { latest: true });

console.log(share.dataUrls[0]);
console.log(share.writeToken);
```

Commit the data URL in the page's code. Keep the write token on a server or as a CI secret, since anyone with it can change the share or take it down ([Keep the write token](shares.md#keep-the-write-token)).

The page reads the URL with a plain `fetch`, and types the body with `ShareSlotDataResponse` from `@developmentfinance/client/wire`:

<!-- docs-check: skip: needs a live share's data URL -->

```ts
// In the page
import type { ShareSlotDataResponse } from "@developmentfinance/client/wire";

const KENYA_ODA = "https://developmentfinance.org/api/v1/presentation/shares/7NHGA70g/slots/1/data";

const response = await fetch(KENYA_ODA);
if (!response.ok) throw new Error(`DFO answered ${response.status} for ${KENYA_ODA}`);
const slot = (await response.json()) as ShareSlotDataResponse;

console.log(slot.freshness, slot.frame.content_version, slot.rows.length);
```

`slot.rows` holds one object per row, keyed by the columns of the card's data file. DFO checks a live slot for newer data on a read that comes 15 minutes or more after its last check, or sooner after a `pending` one, and `slot.freshness` says what the rows are:

- `current`: the newest data DFO found at its last check.
- `pending`: newer data is building, and the rows are the last check's, so a view does not wait on a build.
- `stale`: DFO could not check, or the card cannot be drawn on the newer data, and the rows are older.

A live slot answers with a strong `ETag` and `Cache-Control: no-cache`, so the browser revalidates each read, and DFO answers 304 with no body until the next check falls due. The `x-dfo-freshness` header repeats the freshness. A snapshot share's slot data caches for 5 minutes. A live share holds at most 20 data cards, and each new share counts against a daily allowance.

`client.fetch(share)` returns a slot as a `Dataset`, through the manifest, the file, and a Search call for its sentence. That suits a data step, and is slower on a page than the data URL.

### Ship the file with the site

A page that must load with no DFO request saves the dataset into the site's assets. The saved file holds the rows and the provenance:

```ts
// fetch-data.mts
import { Client, DatasetRef } from "@developmentfinance/client";
import { mkdir, readFile } from "node:fs/promises";

const client = new Client();
const ref = DatasetRef.fromJSON(await readFile("data/kenya-oda.ref.json", "utf8"));
const data = await client.fetch(ref);

await mkdir("public/data", { recursive: true });
await data.save("public/data/kenya-oda.parquet");
```

The page reads the file from its own origin with `Dataset.fromBytes`, which loads about 37 KB gzip of the client with `esbuild --bundle --splitting --format=esm --minify --platform=browser`:

<!-- docs-check: skip: needs a page that serves the saved file -->

```ts
// In the page
import { Dataset } from "@developmentfinance/client";

const response = await fetch("/data/kenya-oda.parquet");
const data = await Dataset.fromBytes(await response.arrayBuffer());
const rows = await data.toRows();
```

Each reading is one binary file in the repository, and new data reaches the page when the data step runs again and the site redeploys.

## Answer a question from a page

A page asks a question, your server asks the API, and the page draws the table. The server route searches, lets the reader choose a reading, streams build progress as NDJSON, stops before the platform's time limit, and joins the same build when the page posts again. The key stays on the server.

The route is one function from a web `Request` to a `Response`. Next.js App Router runs it as `app/api/data/route.ts`, and `Bun.serve` and `Deno.serve` take the same function.

### The route

The page posts `{ question }`, `{ answerId, option }` to settle a choice, or `{ answerId }` to fetch an answer again after a `retry`. The route answers with one JSON object per line:

```text
{"type":"choose","answerId":"60b35cdc-5e2b-42f5-b34a-2e4fd8ec5fe1","options":["Kenya's percent of nominal GDP spent on education, 1971 to 2024.","Kenya's percent of total government expenditure on education, 1980 to 2025."]}
data: 67 rows · Kenya's health expenditure per capita in international dollars, 2000 to 2023. World Development Indicators. Kenya's percent of nominal GDP spent on education, 1971 to 2024. World Development Indicators.
{"type":"error","code":"answer_declined","message":"Search declined the question: it asks for an argument and names no data to show.\n  Next: ask for a figure DFO publishes; client.lookup.catalogue() lists example questions.\n[answer_declined trace=3261047291064622933591b87a7b39e2]"}
```

```ts
// app/api/data/route.ts
import { Answer, Client } from "@developmentfinance/client";
import { isDfoError } from "@developmentfinance/client/errors";
import type { Gap } from "@developmentfinance/client/types";

/** Next.js on Vercel ends the function after this many seconds. */
export const maxDuration = 60;
/** The route's own budget, under `maxDuration`, so it can tell the page to post again. */
const BUDGET_MS = 50_000;

/** One client per server process. It reads DFO_API_KEY from the server's environment. */
const client = new Client();

/** Answers as JSON, each under a random id the page sends back. */
const answers = new Map<string, string>();

type Ask = { question: string } | { answerId: string; option?: number };

export type Line =
  | { type: "choose"; answerId: string; options: string[] }
  | { type: "progress"; rowsWritten: number | null; estimateRows: number | null }
  | { type: "data"; sentence: string; rows: Record<string, unknown>[] }
  | { type: "retry"; answerId?: string }
  | { type: "error"; code: string; message: string };

export async function POST(request: Request): Promise<Response> {
  const ask = readAsk(await request.json().catch(() => null));
  if (ask === null) {
    return Response.json({ error: "Post { question } or { answerId }." }, { status: 400 });
  }
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(BUDGET_MS)]);
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (line: Line) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      try {
        await respond(ask, signal, send);
      } catch (error) {
        if (request.signal.aborted) return;
        if (signal.aborted) send({ type: "retry" });
        else if (isDfoError(error))
          send({ type: "error", code: error.code, message: error.message });
        else {
          controller.error(error);
          return;
        }
      }
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
}

async function respond(ask: Ask, signal: AbortSignal, send: (line: Line) => void): Promise<void> {
  const answer = await answerFor(ask, signal);
  if (answer === null) {
    send({ type: "error", code: "answer_expired", message: "Ask the question again." });
    return;
  }
  const answerId = () =>
    "answerId" in ask && ask.option === undefined ? ask.answerId : keep(answer);
  const choice = choiceOf(answer);
  if (choice !== undefined) {
    const options = choice.options.map((option) => option.label ?? "");
    send({ type: "choose", answerId: answerId(), options });
    return;
  }
  // A declined or catalogue answer, or a part with nothing to pick, makes `fetch` raise.
  try {
    const data = await answer.fetch({
      signal,
      onProgress: ({ progress }) => send({ type: "progress", ...progress }),
    });
    send({ type: "data", sentence: data.sentence, rows: await data.toRows() });
  } catch (error) {
    if (!signal.aborted) throw error;
    send({ type: "retry", answerId: answerId() });
  }
}

/** The first part that awaits a pick among readings or places. */
function choiceOf(answer: Answer): Gap | undefined {
  return answer.gaps.find((gap) => gap.kind === "choice" && gap.options.length > 0);
}

/** Stores the answer and returns its id. */
function keep(answer: Answer): string {
  const answerId = crypto.randomUUID();
  answers.set(answerId, JSON.stringify(answer));
  return answerId;
}

async function answerFor(ask: Ask, signal: AbortSignal): Promise<Answer | null> {
  if ("question" in ask) return client.search(ask.question, { signal });
  const saved = answers.get(ask.answerId);
  if (saved === undefined) return null;
  const answer = Answer.fromJSON(saved, client);
  if (ask.option === undefined) return answer;
  const part = choiceOf(answer)?.partIndex;
  return answer.choose(ask.option, part === undefined ? { signal } : { part, signal });
}

function readAsk(body: unknown): Ask | null {
  if (typeof body !== "object" || body === null) return null;
  if ("question" in body && typeof body.question === "string") return { question: body.question };
  if (!("answerId" in body) || typeof body.answerId !== "string") return null;
  if (!("option" in body)) return { answerId: body.answerId };
  return typeof body.option === "number" ? { answerId: body.answerId, option: body.option } : null;
}
```

In that route:

- One `Client` serves every request. It holds no per-request state, and it resolves the key when it is built.
- The work runs inside the stream, so the page gets the response headers at once and each progress line as the server reports it. A build the server has made before sends only `data`.
- `AbortSignal.any` stops the search and the fetch when the request aborts or when `BUDGET_MS` passes. Keep the budget about ten seconds under the platform's limit, so the route still has time to send `retry` and close the stream. A budget that passes during the search sends `retry` with no answer id, and the page posts the question again.
- An error the client raises goes to the page as its `code` and `message`. The message ends with the code, and with the trace id when there is one, `[code trace=id]`, which is what the reader quotes to you. The client replaces its own key in any server text with `[redacted]`.

### Read the stream in the page

`readLines` turns the response into one object per line, and `ask` posts again after each `retry`, with the answer id the line carries. They use only web APIs, so the same file runs in the page and in Node. In your app, import `Line` from the route file:

```ts
async function* readLines(response: Response): AsyncGenerator<Line> {
  if (response.body === null) return;
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffered += value;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) yield JSON.parse(line) as Line;
  }
}

/** Posts `body`, then the answer id of each `retry`, until the route answers without one, and
 *  returns the last line. */
async function ask(
  post: (body: object) => Promise<Response>,
  body: object,
  onLine: (line: Line) => void,
): Promise<Line | undefined> {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    let last: Line | undefined;
    for await (const line of readLines(await post(body))) {
      last = line;
      if (line.type !== "retry") onLine(line);
    }
    if (last?.type !== "retry") return last;
    if (last.answerId !== undefined) body = { answerId: last.answerId };
  }
  return { type: "error", code: "deadline_exceeded", message: "The build is still running." };
}
```

In the page, `post` sends the body to the route:

<!-- docs-check: skip: needs a page served beside the route; the next block runs the same calls in Node -->

```ts
const toRoute = (body: object) =>
  fetch("/api/data", { method: "POST", body: JSON.stringify(body) });

await ask(toRoute, { question: "GDP of Kenya" }, (line) => console.log(line));
```

### Try it from Node

The same calls run in Node, with `post` handing a `Request` to the route function. This prints the output shown under [The route](#the-route):

```ts
const callRoute = (body: object) =>
  POST(new Request("http://localhost/api/data", { method: "POST", body: JSON.stringify(body) }));

const show = (line: Line) =>
  console.log(
    line.type === "data"
      ? `data: ${line.rows.length} rows · ${line.sentence}`
      : JSON.stringify(line),
  );

const first = await ask(
  callRoute,
  { question: "health spending and education spending in Kenya" },
  show,
);
if (first?.type === "choose") {
  await ask(callRoute, { answerId: first.answerId, option: 0 }, show);
}
await ask(callRoute, { question: "Is aid good for Africa? Argue both sides." }, show);
```

The route sends `choose` for a part that awaits a pick among readings or places, and the page shows `options` as buttons. A question Search declines or answers with the catalogue, and a part with no reading to pick, make `fetch` raise, so the page gets an `error` line with the client's message.

### Join a build that outlived the request

A large build can run longer than one request. When `BUDGET_MS` passes, the fetch stops waiting and the build keeps running on the server. The route sends `retry` with the id it stored the answer under, and the page posts `{ answerId }`. The route revives the answer with `Answer.fromJSON` and calls `fetch` on it, which joins the running build without a second Search call. `ask` handles the retry.

With `BUDGET_MS` at 20 seconds, `ask(callRoute, { question: "CRS commitments from every donor to every recipient for agriculture, 2017 to 2024" }, show)` took two posts for a build of 57,287 rows:

```text
{"type":"progress","rowsWritten":0,"estimateRows":57287}
{"type":"progress","rowsWritten":0,"estimateRows":57287}
{"type":"progress","rowsWritten":0,"estimateRows":57287}
{"type":"progress","rowsWritten":0,"estimateRows":57287}
{"type":"progress","rowsWritten":0,"estimateRows":57287}
{"type":"progress","rowsWritten":0,"estimateRows":57287}
{"type":"progress","rowsWritten":57287,"estimateRows":57287}
data: 57287 rows · Commitments to 171 recipients from 126 providers for agriculture, 2017 to 2024. Current US dollars · OECD Creditor Reporting System (CRS).
```

The first post searched once and started the build, `op_ab6a4c80…`. The second posted the answer id and polled the same operation until it returned the table.

### Share an answer between requests

The route keeps each answer as `JSON.stringify(answer)`, which writes `answer.toJSON()`, under a random id, and revives it with `Answer.fromJSON(saved, client)` when the page posts the id back, to settle a choice or to fetch again after `retry`. A `Map` holds them in one process and keeps every one, so give each entry a lifetime, such as 15 minutes, or use a store with a TTL. A deployment with several instances, which serverless platforms run, needs a store they share, such as Redis or Workers KV, since each instance has its own memory.

You can send the answer's JSON to the page and take it back, which needs no store. `Answer.fromJSON` checks that the JSON is well formed, and cannot tell whether it came from Search. `choose` and `fetch` post what the answer holds, so a forged answer can send any spec or parsed question to the API under your key. With a public-tier key that costs quota, as the question route already does, so rate-limit the route per visitor. With a key scoped beyond the public tier, keep the answer on the server as this route does, or sign it before it leaves.

## Show a reading in another currency

A page on `developmentfinance.org` calls the API with no key, and can re-fetch a reading in the currency a reader picks. `unitConversion(spec)` lists what a reading converts to, and `answer.fetch` takes the unit as `currency`, `priceBasis` and `baseYear`, named after the row columns they set:

```ts
import { Client, unitConversion } from "@developmentfinance/client";

const client = new Client({ apiKey: false });
const answer = await client.search("bilateral ODA from Germany to Kenya 2015 to 2022");

const offer = unitConversion(answer.specs[0]!);
const picker = (offer?.currencies ?? [])
  .filter((currency) => currency.constantYears !== null)
  .map((currency) => ({ value: currency.code, label: currency.noun }));

const data = await answer.fetch({ currency: "EUR", priceBasis: "constant", baseYear: 2022 });
console.log(data.members[0]!.sentence);
```

```text
Germany's net disbursements (bilateral flows) to Kenya for official development assistance, 2015 to 2022. Constant 2022 euros, donor prices · OECD DAC2a.
```

On dev the offer listed 140 currencies. Euros convert at current prices for 2015 to 2022 and at constant prices for any base year from 1973 to 2025, and each row holds `currency: "EUR"`, `price_basis: "constant"` and `base_year: 2022`. `{ currency: "EUR" }` alone fetches current euros. A constant-price fetch names its `baseYear`. `offer.defaultBaseYear` is the year the conversion tables default to, for a page with no other choice.

The converted reading is a new spec, with its own `spec_id` and sentence, so the dataset's `ref` and `provenance` name what the reader saw. The conversion runs on the reading as `window`, `entities` and `facets` narrow it, so Search checks the rates for the years and places the build reads. The offer's years are those of the reading Search resolved. `unitConversion` returns null for a spec Search did not resolve, such as a ref member's, and for a series that converts to no currency, such as a debt stock. `client.fetch(spec, { currency })` still asks the server on such a spec.

A base year the tables do not cover throws `InvalidRequestError` with the code `rate_coverage_gap`, under `partial: true` as well, and `error.problem.cause.entities` names the missing rates:

```text
InvalidRequestError: Search cannot convert "bilateral ODA" to EUR at constant 1900 prices: No data is available for this query. Constant prices leave out Germany, which the price deflators do not cover. Missing: CurrencyEUR@1900. [rate_coverage_gap trace=4e4f6946f119422384e7f04aa7120ff3]
```

A series no recipe converts throws `InvalidRequestError` (`recipe_not_declared`). When constant prices leave some places' rows out, Search's `deflator_missing_omitted` warning reaches `onWarning` as a `SearchWarning`, and `strict: true` throws it.

## Keep the key on the server

The route's `new Client()` reads `DFO_API_KEY` from the server's environment. Set it as a server-side variable on your host. Do not put it under a prefix the framework copies into the page bundle, such as Next.js's `NEXT_PUBLIC_`, because every visitor can read the bundle.

Search, builds, and the other routes that spend a key answer browsers on `developmentfinance.org` alone. A page on another origin calls your own server route, such as the one above, or a proxy of the API on the page's origin with `new Client({ baseUrl: "/api/v1" })`. [The routes a page may call](#the-routes-a-page-may-call) lists the reads a page makes directly.

A page that calls the API itself uses a publishable `dfo_p_` key. In a browser page or worker, `new Client()` throws an `InvalidRequestError` (`invalid_argument`) for a secret `dfo_k_` key from `apiKey`, and the first request rejects with it for one in `headers` or from `headerProvider`. No request leaves. `dangerouslyAllowBrowser: true` turns that check off, for a page only you can open.

## Next

- [Use DFO in a data pipeline](pipelines.md) builds the data step: search by series code, pin, refresh, and record provenance.
- [Cards and shares](shares.md) covers the live share a page reads, its write token, and replacing its cards.
- [The README](../README.md) covers the calls the server route builds on: choosing readings, narrowing a fetch, refs, and errors.
