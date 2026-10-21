import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

import { envFrom } from "../src/env.ts";
import type { EntityGroups, Narrowing, SpecInput } from "../src/fetch.ts";
import type { LongBuild } from "../src/operation.ts";
import type { Layout, SpecLike } from "../src/ref.ts";
import { Transport } from "../src/transport.ts";
import type { TransportOptions } from "../src/transport.ts";

/** The base URL every replay serves its scenario at, whatever base URL the record names. */
export const REPLAY_BASE_URL = "https://api.replay.test/api";

type Json = Record<string, unknown>;

/** The scenario record format, as `contract/scenario.schema.json` defines it, except that a
 *  step's spec is in the wire `Spec`'s shape (see `readScenario`). */
export type Scenario = {
  name: string;
  description: string;
  origin: { kind: "recorded"; base_url: string } | { kind: "synthetic"; derived_from: string };
  call: Step[];
  exchanges: Exchange[];
  expect: Outcome[];
};

/** A fetch of the previous step's answer, or of the spec or ref the step names. */
export type FetchStep = Narrowing & {
  op: "fetch";
  partial?: boolean;
  strict?: boolean;
  layout?: Layout;
  spec?: SpecInput;
  ref?: unknown;
};

export type Step =
  | { op: "search"; question: string }
  | { op: "choose"; part?: number | string; option: number | string }
  | FetchStep
  | { op: "newest_version"; spec: SpecInput }
  | { op: "mint"; spec: SpecInput; layout?: Layout }
  | { op: "operation"; operation_id: string; layout?: Layout }
  | { op: "result" };

export type Exchange = {
  request: { method: string; path?: string; origin_path?: string; url?: string; json?: Json };
  response: {
    status: number;
    headers?: Record<string, string>;
    json?: unknown;
    body_file?: string;
  };
};

export type AnswerSummary = StepSummary & {
  kind: string;
  status?: string;
  sentence: string | null;
  complete: boolean;
  specs: string[];
  gaps: { part: number; kind: string; options: number }[];
};

/** How the client followed one long build: `poll_waits` in seconds. */
export type LongBuildSummary = {
  operation_id: string;
  poll_waits: number[];
  resubmissions: number;
};

/** What any step's outcome may also give: the seconds before each retry of a refused request
 *  other than a poll, and the codes of the warnings its API responses issued. */
export type StepSummary = {
  retry_waits?: number[];
  warnings?: string[];
};

export type DatasetSummary = StepSummary & {
  rows: number;
  columns: string[];
  complete: boolean;
  members: { parts: string[]; spec_id: string; content_version: string; sentence: string }[];
  missing: { part: number; kind: string }[];
  search_warning?: boolean;
  long_builds?: LongBuildSummary[];
};

export type ErrorSummary = StepSummary & {
  class: string;
  code: string | null;
  newest_version?: string | null;
  long_builds?: LongBuildSummary[];
};

export type Outcome =
  | { answer: AnswerSummary }
  | { dataset: DatasetSummary }
  | { operation: StepSummary & Json }
  | { newest_version: StepSummary & { content_version: string | null } }
  | { error: ErrorSummary };

const scenarioUrl = (file: string): URL =>
  new URL(`../../contract/scenarios/${file}`, import.meta.url);

/** A step's spec as the scenario format holds it, with the sentence and the entity groups at
 *  the top level. */
type ScenarioSpec = SpecLike & { sentence?: string; entity_groups?: EntityGroups };

/** A scenario spec in the wire `Spec`'s shape, the one `client.fetch` and `client.mint` take:
 *  the sentence and the groups move under `resolved`. */
function wireSpec({ sentence, entity_groups, ...spec }: ScenarioSpec): SpecInput {
  if (sentence === undefined && entity_groups === undefined) return spec;
  return {
    ...spec,
    resolved: {
      ...(sentence === undefined ? {} : { rendered_sentence: sentence }),
      ...(entity_groups === undefined ? {} : { entity_groups }),
    },
  };
}

/** A scenario record, its fetch and mint specs read into the wire `Spec`'s shape. */
async function readScenario(file: string): Promise<Scenario> {
  const record = JSON.parse(await readFile(scenarioUrl(file), "utf8")) as Scenario;
  const call = record.call.map((step) =>
    (step.op === "fetch" || step.op === "mint" || step.op === "newest_version") &&
    step.spec !== undefined
      ? { ...step, spec: wireSpec(step.spec as ScenarioSpec) }
      : step,
  );
  return { ...record, call };
}

/** Every scenario record in the contract. */
export async function scenarios(): Promise<Scenario[]> {
  const files = (await readdir(scenarioUrl(""))).filter((file) => file.endsWith(".json"));
  const records = await Promise.all(files.map(readScenario));
  assert.ok(records.length > 0, "the contract holds no scenarios");
  return records;
}

export const scenario = (name: string): Promise<Scenario> => readScenario(`${name}.json`);

export const scenarioBytes = async (file: string): Promise<Uint8Array<ArrayBuffer>> =>
  Uint8Array.from(await readFile(scenarioUrl(file)));

/** A scenario with no exchanges, whose replay fails any request. */
export const NO_EXCHANGES: Scenario = {
  name: "no-exchanges",
  description: "Any request fails the replay.",
  origin: { kind: "synthetic", derived_from: "none" },
  call: [],
  exchanges: [],
  expect: [],
};

/** A scenario's step, checked to be the operation the test reads it as. */
export function stepOf<TOp extends Step["op"]>(
  record: Scenario,
  index: number,
  op: TOp,
): Extract<Step, { op: TOp }> {
  const step = record.call[index];
  assert.equal(step?.op, op, `${record.name}: step ${index}`);
  return step as Extract<Step, { op: TOp }>;
}

/** The URL a recorded request went to, under the replay's base URL. */
function expectedUrl(base: URL, request: Exchange["request"]): string {
  if (request.url !== undefined) return new URL(request.url).href;
  if (request.origin_path !== undefined) return new URL(request.origin_path, base.origin).href;
  return new URL(`${base.pathname.replace(/\/$/, "")}${request.path ?? ""}`, base.origin).href;
}

/**
 * A transport whose `fetch` answers a scenario's exchanges in order, checking each request's
 * method, URL and listed JSON members against the record. Sleeps advance a fake clock and are
 * recorded, not waited: `waits` holds every sleep, and `retryWaits` the sleeps that are no
 * long build's poll wait. A poller records each poll wait just before it sleeps it, so a sleep
 * is a poll wait when the long builds' poll waits grew since the last sleep. `remaining` lists
 * the exchanges no request reached. `options` override the transport's; a `fetch` among them
 * replaces the replay.
 */
export function replay(
  record: Scenario,
  options: TransportOptions = {},
): {
  transport: Transport;
  waits: number[];
  retryWaits: number[];
  remaining: () => Exchange[];
  urls: string[];
} {
  const base = new URL(REPLAY_BASE_URL);
  const queue = [...record.exchanges];
  const waits: number[] = [];
  const retryWaits: number[] = [];
  const urls: string[] = [];
  const longBuilds: LongBuild[] = [];
  let pollWaitsSeen = 0;
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
    const body =
      response.body_file !== undefined
        ? await scenarioBytes(response.body_file)
        : response.json === undefined
          ? null
          : JSON.stringify(response.json);
    return new Response(body, { status: response.status, headers: new Headers(response.headers) });
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
      const pollWaits = longBuilds.reduce((sum, build) => sum + build.pollWaits.length, 0);
      if (pollWaits === pollWaitsSeen) retryWaits.push(ms);
      pollWaitsSeen = pollWaits;
      clock += ms;
      return Promise.resolve();
    },
    onWarning: () => undefined,
    ...options,
    onLongBuild: (build) => {
      longBuilds.push(build);
      options.onLongBuild?.(build);
    },
  });
  return { transport, waits, retryWaits, remaining: () => [...queue], urls };
}
