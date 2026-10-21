// The live journey against `DFO_BASE_URL`, through the package's public surface. Each step
// asserts on what the wire carries: codes, ids, digests, row counts and years. A step the
// server cannot serve yet is skipped with the server's answer as the reason.
//
//   DFO_BASE_URL=https://.../api pnpm test:e2e
//
// `DFO_E2E_DIR` names a directory both clients share: this suite writes `ref-typescript.json`
// there, and fetches `ref-python.json` when the Python suite has written it.
//
// Step 6 builds the spec `e2e/long-builds.json` assigns to this run by the UTC day's parity, the
// language and `DFO_E2E_TARGET`. Each spec there is posted every 48 hours, so its stored head is
// past the server's 24-hour maximum age and the build runs again as an operation.
// `DFO_E2E_SCHEDULED=true` marks a scheduled run, where a build served inline fails the step; any
// other run skips it.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";

import {
  Client,
  DatasetRef,
  IncompleteAnswerError,
  InvalidRequestError,
  NotFoundError,
} from "../../src/index.ts";
import type { Answer, Dataset, Gap, Operation, Row, SpecInput } from "../../src/index.ts";

const baseUrl = process.env["DFO_BASE_URL"];
if (baseUrl === undefined || baseUrl === "") {
  throw new Error("Set DFO_BASE_URL to the API's base URL, such as https://<host>/api.");
}
const e2eDir = process.env["DFO_E2E_DIR"];
const LANGUAGE = "typescript";
const LONG_BUILDS = new URL("../../../e2e/long-builds.json", import.meta.url);

/** One request the client made and what the server answered. */
type Exchange = {
  method: string;
  url: string;
  sentAt: number;
  answeredAt: number;
  status: number;
  retryAfterMs: number | null;
  json: unknown;
};

const wire: Exchange[] = [];

/** The platform's fetch, recording every exchange; JSON bodies are read from a clone. */
const recording: typeof fetch = async (input, init) => {
  const url = input instanceof URL ? input.href : input instanceof Request ? input.url : input;
  const sentAt = performance.now();
  const response = await fetch(input, init);
  const isJson = response.headers.get("content-type")?.includes("json") === true;
  const json: unknown = isJson ? await response.clone().json() : null;
  // An operation resource carries its pacing as `operation.retry_after_ms`.
  const hinted = (json as { operation?: { retry_after_ms?: unknown } } | null)?.operation
    ?.retry_after_ms;
  const header = response.headers.get("retry-after");
  wire.push({
    method: init?.method ?? "GET",
    url,
    sentAt,
    answeredAt: performance.now(),
    status: response.status,
    retryAfterMs:
      typeof hinted === "number" ? hinted : header === null ? null : Number(header) * 1000,
    json,
  });
  return response;
};

const client = new Client({ baseUrl, fetch: recording });

type LongBuild = { day_parity: number; language: string; target: string; spec: SpecInput };

/** The spec `LONG_BUILDS` assigns to this run's UTC day, language and target. */
async function longBuild(): Promise<SpecInput> {
  const target = process.env["DFO_E2E_TARGET"];
  assert.ok(target, "DFO_E2E_TARGET is unset; step 6 picks its spec by target");
  const parity = Math.floor(Date.now() / 86_400_000) % 2;
  const entries = JSON.parse(await readFile(LONG_BUILDS, "utf8")) as LongBuild[];
  const found = entries.filter(
    (entry) =>
      entry.day_parity === parity && entry.language === LANGUAGE && entry.target === target,
  );
  assert.equal(found.length, 1, `long-builds.json entries for ${parity}, ${LANGUAGE}, ${target}`);
  return found[0]!.spec;
}

/** The rows Search says a build of `spec` downloads, from resubmitting its identity. */
async function downloadRows(spec: SpecInput): Promise<number> {
  const response = await client.request("POST", "/search/resolve", {
    json: {
      schema_version: 1,
      input: {
        kind: "dataset_resubmit",
        entries: [
          {
            entry_kind: "identity",
            variable_text: "dataset",
            identity: spec.definition["identity"],
          },
        ],
      },
    },
  });
  const { parts } = response.json() as {
    parts: {
      status: string;
      spec?: { spec_id: string; resolved: { download: { rows: number } } };
    }[];
  };
  assert.equal(parts.length, 1);
  const [part] = parts;
  assert.ok(part?.status === "definite" && part.spec, `Search read ${spec.spec_id} as definite`);
  assert.equal(part.spec.spec_id, spec.spec_id);
  return part.spec.resolved.download.rows;
}

/** Why the build answered 200, with the age of the version it served. The server publishes no
 *  head age, so this is the age of the served version's `prepared_at`, at least the head's. */
async function servedInline(spec: SpecInput, operation: Operation): Promise<string> {
  const [member] = (await operation.result()).members;
  assert.ok(member);
  const snapshot = await client.request(
    "GET",
    `/datasets/${member.spec.spec_id}/${member.contentVersion}`,
  );
  const { prepared_at } = snapshot.json() as { prepared_at: string };
  const hours = (Date.now() - Date.parse(prepared_at)) / 3_600_000;
  return (
    `POST /datasets served ${spec.spec_id} inline (200) at ${member.contentVersion}, ` +
    `prepared ${hours.toFixed(1)} h ago; a 48-hour rotation should find its head past the ` +
    "server's maximum age"
  );
}

/** The exchanges made while `run` ran. */
async function exchangesOf<T>(run: () => Promise<T>): Promise<{ value: T; exchanges: Exchange[] }> {
  const start = wire.length;
  const value = await run();
  return { value, exchanges: wire.slice(start) };
}

const isResolve = (exchange: Exchange) => exchange.url.endsWith("/search/resolve");

const sha256 = (bytes: Uint8Array): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const yearOf = (row: Row): number => Number(String(row["time_period"]).slice(0, 4));

/** The error a promise rejects with; the step fails when it resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return assert.fail("the call resolved");
}

const recordedColumns = async (): Promise<string[]> => {
  const scenario = JSON.parse(
    await readFile(
      new URL("../../../contract/scenarios/answer-definite-fetch.json", import.meta.url),
      "utf8",
    ),
  ) as { expect: [unknown, { dataset: { columns: string[] } }] };
  return scenario.expect[1].dataset.columns;
};

const STEP_TIMEOUT = 300_000;

// State the later steps read from the earlier ones.
let health: Answer | undefined;
let healthData: Dataset<Gap> | undefined;

describe(`the journey against ${baseUrl}`, { concurrency: false }, () => {
  test("1. a definite answer carries the wire's sentence", { timeout: STEP_TIMEOUT }, async () => {
    const { value: answer, exchanges } = await exchangesOf(() =>
      client.search("ODA disbursements from Germany to Nigeria for basic health care"),
    );
    const [resolve] = exchanges.filter(isResolve);
    assert.ok(resolve, "the search posted to /search/resolve");
    const body = resolve.json as { status: string; rendered_sentence: string };
    assert.equal(body.status, "definite");
    assert.equal(answer.status, "definite");
    assert.ok(answer.complete);
    assert.equal(answer.sentence, body.rendered_sentence);
    health = answer;
  });

  test(
    "2. the answer's dataset, its ref, and the ref fetched again",
    { timeout: STEP_TIMEOUT },
    async (t) => {
      assert.ok(health, "step 1 gave an answer");
      const dataset = await health.fetch();
      healthData = dataset;
      assert.ok(dataset.rows > 0);
      assert.deepEqual(dataset.columns, await recordedColumns());
      const [member] = dataset.members;
      assert.ok(member);
      assert.equal(sha256(await dataset.bytes()), member.digest);

      const text = JSON.stringify(dataset.ref);
      const ref = DatasetRef.fromJSON(text);
      assert.deepEqual(ref.toJSON(), dataset.ref.toJSON());
      assert.deepEqual(
        ref.members.map((m) => m.sentence),
        dataset.members.map((m) => m.sentence),
      );

      const { value: again, exchanges } = await exchangesOf(() => client.fetch(ref));
      assert.ok(
        !exchanges.some((exchange) => exchange.method === "POST"),
        "a ref fetch reads the stored version and builds nothing",
      );
      const [fetched] = again.members;
      assert.ok(fetched);
      assert.equal(fetched.contentVersion, member.contentVersion);
      assert.equal(fetched.digest, member.digest);
      assert.equal(sha256(await again.bytes()), member.digest);
      t.diagnostic(`${dataset.rows} rows, ${member.contentVersion}`);
    },
  );

  test("2b. a cached ref loads offline", (t) => {
    t.skip("the TypeScript client keeps no cache, so there is no offline load to check");
  });

  test(
    "3. three readings, and the first fetched by choice and by candidate",
    { timeout: STEP_TIMEOUT },
    async () => {
      const answer = await client.search("GNI of Germany from 2015 to 2022");
      const error = await rejection(answer.fetch());
      assert.ok(error instanceof IncompleteAnswerError, String(error));
      assert.equal(error.code, "answer_incomplete");
      const numbered = error.message.split("\n").filter((line) => /^\s+\[\d+\] /.test(line));
      assert.equal(numbered.length, 3, error.message);

      const chosen = await (await answer.choose(0)).fetch();
      assert.ok(chosen.rows > 0);
      const candidate = answer.gaps[0]?.options[0];
      assert.ok(candidate?.kind === "candidate");
      const direct = await candidate.fetch();
      assert.equal(direct.members[0]?.contentVersion, chosen.members[0]?.contentVersion);
      assert.equal(direct.rows, chosen.rows);
    },
  );

  test(
    "4. a part with no reading raises, and a partial fetch takes the rest",
    { timeout: STEP_TIMEOUT },
    async () => {
      const answer = await client.search("debt service of Kenya and the price of tea in Kenya");
      const error = await rejection(answer.fetch());
      assert.ok(error instanceof IncompleteAnswerError, String(error));
      const dataset = await answer.fetch({ partial: true });
      assert.equal(dataset.members.length, 1);
      assert.equal(dataset.complete, false);
      assert.equal(dataset.missing.length, 1);
      assert.ok(dataset.rows > 0);
    },
  );

  test(
    "5. several readings stack into one dataset with a part column",
    { timeout: STEP_TIMEOUT },
    async () => {
      const answer = await client.search(
        "ODA disbursements for health and for education from Germany to Kenya, and GDP of Kenya",
      );
      const dataset = await answer.fetch();
      const specs = answer.specs.map((spec) => spec.spec_id);
      assert.ok(specs.length > 1, `the answer reads as ${specs.length} spec`);
      assert.deepEqual(
        dataset.members.map((member) => member.spec.spec_id),
        specs,
      );
      assert.equal(dataset.columns[0], "part");
      const rows = await dataset.toRows();
      assert.equal(rows.length, dataset.rows);
      const partValues = new Set(rows.map((row) => row["part"]));
      assert.equal(partValues.size, dataset.members.length);
    },
  );

  test(
    "6. a long build answers 202, polls at the server's pacing, and resumes elsewhere",
    { timeout: 900_000 },
    async (t) => {
      const spec = await longBuild();
      const capabilities = await client.request("GET", "/datasets/capabilities");
      const { caps } = capabilities.json() as {
        caps: { sync_budget_rows: number; sync_budget_requests: number };
      };
      assert.equal(typeof caps.sync_budget_requests, "number");
      // The server publishes a build's row count before it runs, through Search; it publishes no
      // request count, so only the rows budget is checked here.
      const estimate = await downloadRows(spec);
      assert.ok(
        estimate > caps.sync_budget_rows,
        `${spec.spec_id} downloads ${estimate} rows, within the ${caps.sync_budget_rows} budget`,
      );

      const { value: operation, exchanges } = await exchangesOf(() => client.mint(spec));
      const [posted] = exchanges.filter((exchange) => exchange.method === "POST");
      assert.ok(posted, "the mint posted a build");
      if (posted.status === 200) {
        const reason = await servedInline(spec, operation);
        if (process.env["DFO_E2E_SCHEDULED"] === "true") assert.fail(reason);
        t.skip(reason);
        return;
      }
      assert.equal(posted.status, 202);
      const { operationId } = operation;
      assert.ok(operationId?.startsWith("op_") === true, `operation id ${String(operationId)}`);

      const resumed = resumeElsewhere(operationId);
      const { value: dataset, exchanges: polls } = await exchangesOf(() => operation.result());
      const [built] = dataset.members;
      assert.ok(built);
      assert.equal(built.spec.spec_id, spec.spec_id);
      assert.ok(dataset.rows > caps.sync_budget_rows, `${dataset.rows} rows`);

      const opPolls = [
        posted,
        ...polls.filter((exchange) => exchange.url.includes("/datasets/operations/")),
      ];
      for (const [index, poll] of opPolls.entries()) {
        if (index === 0) continue;
        const previous = opPolls[index - 1]!;
        // With no hint the client backs off from 1 second.
        const floor = previous.retryAfterMs ?? 1_000;
        const waited = poll.sentAt - previous.answeredAt;
        assert.ok(
          waited >= floor - 50,
          `poll ${index} came ${Math.round(waited)} ms after a ${floor} ms wait was due`,
        );
      }
      const other = await resumed;
      assert.equal(other.spec_id, spec.spec_id);
      assert.equal(other.content_version, built.contentVersion);
      assert.equal(other.rows, dataset.rows);
      const hinted = opPolls.filter((poll) => poll.retryAfterMs !== null).length;
      t.diagnostic(
        `${operationId}: ${opPolls.length - 1} polls, ${hinted} of ${opPolls.length} ` +
          `answers paced by the server, ${dataset.rows} rows`,
      );
    },
  );

  test("7. a place choice settles the Congo", { timeout: STEP_TIMEOUT }, async (t) => {
    const answer = await client.search("ODA disbursements from Germany to Congo");
    const gap = answer.gaps[0];
    if (gap !== undefined && gap.options.length === 0) {
      t.skip(`the server offers no place options: the ${gap.kind} gap says "${gap.message}"`);
      return;
    }
    const chosen = await answer.choose("Congo", "Congo [DRC]");
    assert.equal(chosen.status, "definite");
  });

  test(
    "8. a window builds a new spec over those years only",
    { timeout: STEP_TIMEOUT },
    async () => {
      assert.ok(health, "step 1 gave an answer");
      const spec = health.specs[0]!;
      const dataset = await client.fetch(spec, { window: [2020, 2023] });
      const [member] = dataset.members;
      assert.ok(member);
      assert.notEqual(member.spec.spec_id, spec.spec_id);
      const years = new Set((await dataset.toRows()).map(yearOf));
      assert.ok(years.size > 0);
      for (const year of years) assert.ok(year >= 2020 && year <= 2023, `year ${year}`);
      assert.match(member.sentence, /2020 to 2023/);
    },
  );

  test(
    "9. an unknown version and a malformed request raise their codes",
    { timeout: STEP_TIMEOUT },
    async () => {
      assert.ok(healthData, "step 2 gave a dataset");
      const json = healthData.ref.toJSON();
      const unknown = DatasetRef.fromJSON({
        ...json,
        members: json.members.map((member) => ({
          ...member,
          content_version: `cv_${"0".repeat(32)}`,
        })),
      });
      const missing = await rejection(client.fetch(unknown));
      assert.ok(missing instanceof NotFoundError, String(missing));
      assert.equal(missing.code, "snapshot_not_found");

      const spec = health!.specs[0]!;
      const malformed = await rejection(client.fetch(spec, { facets: { colour: "blue" } }));
      assert.ok(malformed instanceof InvalidRequestError, String(malformed));
      assert.equal(malformed.code, "request_invalid");
    },
  );

  test(
    "10. a ref crosses between the Python and TypeScript clients",
    { timeout: STEP_TIMEOUT },
    async (t) => {
      if (e2eDir === undefined || e2eDir === "") {
        t.skip("DFO_E2E_DIR is unset, so there is no directory the two clients share");
        return;
      }
      assert.ok(healthData, "step 2 gave a dataset");
      await mkdir(e2eDir, { recursive: true });
      await writeFile(join(e2eDir, "ref-typescript.json"), JSON.stringify(healthData.ref, null, 2));

      let text: string;
      try {
        text = await readFile(join(e2eDir, "ref-python.json"), "utf8");
      } catch {
        t.skip(`wrote ref-typescript.json; ${e2eDir} holds no ref-python.json to fetch`);
        return;
      }
      const ref = DatasetRef.fromJSON(text);
      const dataset = await client.fetch(ref);
      assert.deepEqual(
        dataset.members.map((member) => [member.contentVersion, member.digest]),
        ref.members.map((member) => [member.contentVersion, member.digest]),
      );
    },
  );
});

/** Resumes an operation from a second Node process and returns what its result holds. */
async function resumeElsewhere(
  operationId: string,
): Promise<{ spec_id: string; content_version: string; rows: number }> {
  const entry = new URL("../../src/index.ts", import.meta.url).href;
  const code = `
    const { Client } = await import(${JSON.stringify(entry)});
    const client = new Client({ baseUrl: ${JSON.stringify(baseUrl)} });
    const operation = await client.operation(${JSON.stringify(operationId)});
    const dataset = await operation.result();
    process.stdout.write(JSON.stringify({
      spec_id: dataset.members[0].spec.spec_id,
      content_version: dataset.members[0].contentVersion,
      rows: dataset.rows,
    }));
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "--eval", code],
    { maxBuffer: 1 << 20, timeout: 900_000 },
  );
  return JSON.parse(stdout) as { spec_id: string; content_version: string; rows: number };
}
