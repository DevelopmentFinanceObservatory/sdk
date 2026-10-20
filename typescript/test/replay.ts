import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { envFrom } from "../src/env.ts";
import { Transport } from "../src/transport.ts";
import type { TransportOptions } from "../src/transport.ts";
import { contractJson } from "./support.ts";

/** The base URL recorded scenarios name; synthetic ones were derived from recordings on it. */
export const RECORDED_BASE_URL = "https://dfo-dev-apis-zms5lj4zhq-nn.a.run.app/api";

type Json = Record<string, unknown>;

export type Exchange = {
  request: {
    method: string;
    path?: string;
    origin_path?: string;
    url?: string;
    json?: Json;
  };
  response: {
    status: number;
    headers?: Record<string, string>;
    json?: unknown;
    body_file?: string;
  };
};

export type Scenario = {
  name: string;
  origin: { kind: "recorded"; base_url: string } | { kind: "synthetic"; derived_from: string };
  call: Json[];
  exchanges: Exchange[];
  expect: Json[];
};

export const scenario = (name: string): Promise<Scenario> =>
  contractJson<Scenario>(`scenarios/${name}.json`);

export const scenarioBytes = async (file: string): Promise<Uint8Array<ArrayBuffer>> =>
  Uint8Array.from(await readFile(new URL(`../../contract/scenarios/${file}`, import.meta.url)));

/** The URL a recorded request went to, under the replay's base URL. */
function expectedUrl(base: URL, request: Exchange["request"]): string {
  if (request.url !== undefined) return new URL(request.url).href;
  if (request.origin_path !== undefined) return new URL(request.origin_path, base.origin).href;
  return new URL(`${base.pathname.replace(/\/$/, "")}${request.path ?? ""}`, base.origin).href;
}

/**
 * A transport whose `fetch` answers a scenario's exchanges in order, checking each request's
 * method, URL and listed JSON members against the record. Sleeps advance a fake clock and are
 * recorded, not waited. `skip` drops leading exchanges another step of the call made.
 */
export function replay(
  record: Scenario,
  { skip = 0, ...options }: { skip?: number } & TransportOptions = {},
): { transport: Transport; waits: number[]; remaining: () => number; urls: string[] } {
  const base = new URL(
    record.origin.kind === "recorded" ? record.origin.base_url : RECORDED_BASE_URL,
  );
  const queue = record.exchanges.slice(skip);
  const waits: number[] = [];
  const urls: string[] = [];
  let clock = 0;
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof URL ? input.href : input instanceof Request ? input.url : input;
    urls.push(url);
    const exchange = queue.shift();
    assert.ok(exchange, `${record.name}: unexpected request ${init.method ?? "GET"} ${url}`);
    const { request, response } = exchange;
    assert.equal(init.method ?? "GET", request.method, `${record.name}: method of ${url}`);
    assert.equal(url, expectedUrl(base, request), `${record.name}: request URL`);
    if (request.json !== undefined) {
      assert.equal(typeof init.body, "string", `${record.name}: ${url} has no JSON body`);
      const sent = JSON.parse(init.body as string) as Json;
      for (const [key, value] of Object.entries(request.json)) {
        assert.deepEqual(sent[key], value, `${record.name}: ${url} body member ${key}`);
      }
    }
    const headers = new Headers(response.headers);
    const body =
      response.body_file !== undefined
        ? await scenarioBytes(response.body_file)
        : response.json === undefined
          ? null
          : JSON.stringify(response.json);
    return new Response(body, { status: response.status, headers });
  };
  const transport = new Transport({
    baseUrl: base.href,
    apiKey: false,
    env: envFrom({}),
    readCredentialsFile: () => Promise.resolve(null),
    fetch,
    now: () => clock,
    sleep: (ms) => {
      waits.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    onWarning: () => undefined,
    ...options,
  });
  return { transport, waits, remaining: () => queue.length, urls };
}
