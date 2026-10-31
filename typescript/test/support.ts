import { readFile } from "node:fs/promises";

/** Reads a file under the repository's contract/ directory. */
export const contractText = (name: string): Promise<string> =>
  readFile(new URL(`../../contract/${name}`, import.meta.url), "utf8");

export const contractJson = async <T>(name: string): Promise<T> =>
  JSON.parse(await contractText(name)) as T;

export type Seen = { url: string; method: string; headers: Headers; body: string | undefined };

type Handler = (request: Seen, init: RequestInit) => Response | Promise<Response>;

/** A `fetch` that answers from a queue of handlers, one per request, and records each request.
 *  A request beyond the queue fails the test. */
export function mockFetch(...handlers: Handler[]): {
  fetch: typeof globalThis.fetch;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const queue = [...handlers];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const request: Seen = {
      url: input instanceof URL ? input.href : input instanceof Request ? input.url : input,
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? init.body : undefined,
    };
    seen.push(request);
    const handler = queue.shift();
    if (handler === undefined)
      throw new Error(`unexpected request ${request.method} ${request.url}`);
    return handler(request, init);
  };
  return { fetch, seen };
}

export const json =
  (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

export const problem = (fields: Record<string, unknown>, headers: Record<string, string> = {}) =>
  json(
    {
      type: `/codes/${String(fields["code"])}`,
      title: "Refused",
      detail: "The server refused the request.",
      trace_id: "trace-1",
      retryable: false,
      ...fields,
    },
    Number(fields["status"]),
    { "content-type": "application/problem+json", ...headers },
  );

/** A sleep that records each wait and returns at once. */
export function recordingSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
}

/**
 * The first item of `log` from `start` on that `matches`, checked every 100 ms while `call`
 * runs. It rejects with the call's error when the call fails first, with the abort reason when
 * `signal` aborts first, and with an error of its own when the call ends having logged none.
 * The timer stops on every outcome, so a failed call leaves nothing running.
 */
export function firstLogged<T>(
  log: readonly T[],
  start: number,
  matches: (item: T) => boolean,
  call: Promise<unknown>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setInterval(check, 100);
    function stop(): void {
      clearInterval(timer);
      signal.removeEventListener("abort", onAbort);
    }
    function check(): boolean {
      const item = log.slice(start).find(matches);
      if (item === undefined) return false;
      stop();
      resolve(item);
      return true;
    }
    function fail(error: unknown): void {
      stop();
      reject(error);
    }
    function onAbort(): void {
      fail(signal.reason);
    }
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort);
    call.then(() => {
      if (!check()) fail(new Error("the call ended having logged none"));
    }, fail);
    check();
  });
}

/** The header that carries `token`, a Google ID token, to a private Cloud Run service, which
 *  reads it in preference to `Authorization`. An unset or empty token sends no header, as on the
 *  E2E workflow's `website` target and in a local run. */
export const idTokenHeaders = (token = process.env["DFO_E2E_ID_TOKEN"]): Record<string, string> =>
  token ? { "X-Serverless-Authorization": `Bearer ${token}` } : {};

/** A recorded reply the Python client's tests share, under python/tests/data/: the analysis
 *  runner's answers, derived manifests and frames, recorded once for both clients. */
const recordedUrl = (name: string): URL =>
  new URL(`../../python/tests/data/${name}`, import.meta.url);

export const recordedJson = async <T = Record<string, unknown>>(name: string): Promise<T> =>
  JSON.parse(await readFile(recordedUrl(name), "utf8")) as T;

export const recordedBytes = async (name: string): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await readFile(recordedUrl(name)));
