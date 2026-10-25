# Use it in a web app

A page asks a question, your server asks the API, and the page draws the table. The server route searches, lets the reader choose a reading, streams build progress as NDJSON, stops before the platform's time limit, and joins the same build when the page posts again. The key stays on the server.

The route is one function from a web `Request` to a `Response`. Next.js App Router runs it as `app/api/data/route.ts`, and `Bun.serve` and `Deno.serve` take the same function. Every example on this page runs in Node as written, apart from the one line that needs a page.

## The route

The page posts `{ question }`, `{ answerId, option }` to settle a choice, or `{ answerId }` to fetch an answer again after a `retry`. The route answers with one JSON object per line:

```text
{"type":"choose","answerId":"60b35cdc-5e2b-42f5-b34a-2e4fd8ec5fe1","options":["Kenya's percent of nominal GDP spent on education, 1971 to 2024.","Kenya's percent of total government expenditure on education, 1980 to 2025."]}
data: 67 rows · Kenya's health expenditure per capita in international dollars, 2000 to 2023. World Development Indicators. Kenya's percent of nominal GDP spent on education, 1971 to 2024. World Development Indicators.
{"type":"error","code":"answer_declined","message":"Search declined the question: it asks for an argument and names no data to show.\n  Next: ask for a figure DFO publishes; client.lookup.catalogue() lists example questions.\n[answer_declined · trace 3261047291064622933591b87a7b39e2]"}
```

```ts
// app/api/data/route.ts
import { Answer, Client, isDfoError, type Gap } from "@developmentfinance/client";

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
- An error the client raises goes to the page as its `code` and `message`. The message ends with the code, and with the trace id when there is one, `[code · trace id]`, which is what the reader quotes to you. The client replaces its own key in any server text with `[redacted]`.

## Read the stream in the page

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

## Try it from Node

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

## Join a build that outlived the request

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

## Share an answer between requests

The route keeps each answer as `JSON.stringify(answer)`, which writes `answer.toJSON()`, under a random id, and revives it with `Answer.fromJSON(saved, client)` when the page posts the id back, to settle a choice or to fetch again after `retry`. A `Map` holds them in one process and keeps every one, so give each entry a lifetime, such as 15 minutes, or use a store with a TTL. A deployment with several instances, which serverless platforms run, needs a store they share, such as Redis or Workers KV, since each instance has its own memory.

You can send the answer's JSON to the page and take it back, which needs no store. `Answer.fromJSON` checks that the JSON is well formed, and cannot tell whether it came from Search. `choose` and `fetch` post what the answer holds, so a forged answer can send any spec or parsed question to the API under your key. With a public-tier key that costs quota, as the question route already does, so rate-limit the route per visitor. With a key scoped beyond the public tier, keep the answer on the server as this route does, or sign it before it leaves.

## Keep the key on the server

The route's `new Client()` reads `DFO_API_KEY` from the server's environment. Set it as a server-side variable on your host. Do not put it under a prefix the framework copies into the page bundle, such as Next.js's `NEXT_PUBLIC_`, because every visitor can read the bundle.

The API's CORS admits only the origins it lists. A page on another origin calls your own server route, such as the one above, or a proxy of the API on the page's origin with `new Client({ baseUrl: "/api/v1" })`.

A page that calls the API itself uses a publishable `dfo_p_` key. In a browser page or worker, `new Client()` throws a `TypeError` for a secret `dfo_k_` key from `apiKey`, and the first request rejects with it for one in `headers` or from `headerProvider`. No request leaves. `dangerouslyAllowBrowser: true` turns that check off, for a page only you can open.

## Next

- [The README](../README.md) covers the calls this route builds on: choosing readings, narrowing a fetch, refs, and errors.
