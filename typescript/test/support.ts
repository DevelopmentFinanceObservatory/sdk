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
