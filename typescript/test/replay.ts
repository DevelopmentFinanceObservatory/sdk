import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

import { envFrom } from "../src/env.ts";
import { Transport } from "../src/transport.ts";

/** The scenario record format, as `contract/scenario.schema.json` defines it. */
export type Scenario = {
  name: string;
  description: string;
  origin: { kind: "recorded"; base_url: string } | { kind: "synthetic"; derived_from: string };
  call: Step[];
  exchanges: Exchange[];
  expect: Outcome[];
};

export type Step =
  | { op: "search"; question: string }
  | { op: "choose"; part?: number | string; option: number | string }
  | { op: "fetch"; partial?: boolean; strict?: boolean; spec?: unknown; ref?: unknown }
  | { op: "mint" | "result" };

export type Exchange = {
  request: { method: string; path?: string; origin_path?: string; url?: string; json?: object };
  response: {
    status: number;
    headers?: Record<string, string>;
    json?: unknown;
    body_file?: string;
  };
};

export type AnswerSummary = {
  kind: string;
  status?: string;
  sentence: string | null;
  complete: boolean;
  specs: string[];
  gaps: { part: number; kind: string; options: number }[];
};

export type DatasetSummary = {
  rows: number;
  columns: string[];
  complete: boolean;
  members: { parts: string[]; spec_id: string; content_version: string; sentence: string }[];
  missing: { part: number; kind: string }[];
};

export type Outcome =
  | { answer: AnswerSummary }
  | { dataset: DatasetSummary }
  | { error: { class: string; code: string | null } };

const scenarioUrl = (name: string): URL =>
  new URL(`../../contract/scenarios/${name}`, import.meta.url);

/** Every scenario record in the contract. */
export async function scenarios(): Promise<Scenario[]> {
  const names = (await readdir(scenarioUrl(""))).filter((name) => name.endsWith(".json"));
  const records = await Promise.all(
    names.map(async (name) => JSON.parse(await readFile(scenarioUrl(name), "utf8")) as Scenario),
  );
  assert.ok(records.length > 0, "the contract holds no scenarios");
  return records;
}

/** The base URL a replay gives the client. A path under it tests the origin rule. */
export const REPLAY_BASE_URL = "https://replay.example/api/v1";

/**
 * A `fetch` that serves a scenario's exchanges in order. A request matches the next exchange on
 * its method, its target and each listed JSON member; any other request fails the replay.
 */
export function replayFetch(
  scenario: Scenario,
  baseUrl: string = REPLAY_BASE_URL,
): { fetch: typeof globalThis.fetch; remaining: () => Exchange[] } {
  const base = new URL(baseUrl);
  const queue = [...scenario.exchanges];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof URL ? input.href : input instanceof Request ? input.url : input;
    const method = init.method ?? "GET";
    const exchange = queue.shift();
    assert.ok(exchange, `${scenario.name}: unexpected request ${method} ${url}`);
    const { request, response } = exchange;
    const expected =
      request.path !== undefined
        ? `${base.origin}${base.pathname.replace(/\/$/, "")}${request.path}`
        : request.origin_path !== undefined
          ? `${base.origin}${request.origin_path}`
          : request.url!;
    assert.equal(`${method} ${url}`, `${request.method} ${expected}`, scenario.name);
    if (request.json !== undefined) {
      assert.equal(typeof init.body, "string", `${scenario.name}: the request has no JSON body`);
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      for (const [member, value] of Object.entries(request.json)) {
        assert.deepEqual(body[member], value, `${scenario.name}: request member ${member}`);
      }
    }
    const body =
      response.body_file !== undefined
        ? await readFile(scenarioUrl(response.body_file))
        : response.json === undefined
          ? null
          : JSON.stringify(response.json);
    return new Response(body, { status: response.status, headers: response.headers ?? {} });
  };
  return { fetch, remaining: () => [...queue] };
}

/** A transport over a replayed `fetch`, with a clock each sleep advances at once. */
export function replayTransport(fetch: typeof globalThis.fetch): {
  transport: Transport;
  waits: number[];
} {
  let clock = 0;
  const waits: number[] = [];
  const transport = new Transport({
    baseUrl: REPLAY_BASE_URL,
    fetch,
    apiKey: false,
    env: envFrom({}),
    readCredentialsFile: () => Promise.resolve(null),
    now: () => clock,
    sleep: (ms) => {
      waits.push(ms);
      clock += ms;
      return Promise.resolve();
    },
  });
  return { transport, waits };
}
