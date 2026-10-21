// The live journey against `DFO_BASE_URL`, through the package's public surface. Each step
// asserts on what the wire carries: codes, ids, digests, row counts and years. A step the
// server cannot serve yet is skipped with the server's answer as the reason.
//
//   DFO_BASE_URL=https://.../api pnpm test:e2e
//
// `DFO_E2E_DIR` names a directory both clients share: this suite writes `ref-typescript.json`
// there, and fetches `ref-python.json` when the Python suite has written it.
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
import type { Answer, Dataset, Gap, Row, SpecInput } from "../../src/index.ts";

const baseUrl = process.env["DFO_BASE_URL"];
if (baseUrl === undefined || baseUrl === "") {
  throw new Error("Set DFO_BASE_URL to the API's base URL, such as https://<host>/api.");
}
const e2eDir = process.env["DFO_E2E_DIR"];

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

/** Search's spec for `spec` over another year range, from resubmitting its identity. */
async function specOver(spec: SpecInput, start: number, end: number): Promise<SpecInput> {
  const identity = {
    ...(spec.definition["identity"] as Record<string, unknown>),
    requested_window: { kind: "range", start_year: start, end_year: end },
  };
  const response = await client.request("POST", "/search/resolve", {
    json: {
      schema_version: 1,
      input: {
        kind: "dataset_resubmit",
        entries: [{ entry_kind: "identity", variable_text: "dataset", identity }],
      },
    },
  });
  const { parts } = response.json() as { parts: { status: string; spec?: SpecInput }[] };
  const [part] = parts;
  assert.ok(part?.status === "definite" && part.spec, `the resubmit of ${start} to ${end}`);
  return part.spec;
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
      // DAC2a for every recipient and provider: 108,798 rows from 2017 to 2024, and more from
      // any earlier start. A window the server has not stored makes it start a long build; a
      // mint builds the spec as it stands, so Search gives the spec of the new window first.
      const dac2a = JSON.parse(
        await readFile(new URL("dac2a-all.json", import.meta.url), "utf8"),
      ) as SpecInput;
      const start = 1990 + Math.floor(Math.random() * 27);
      const spec = await specOver(dac2a, start, 2024);
      const { value: operation, exchanges } = await exchangesOf(() => client.mint(spec));
      const [posted] = exchanges.filter((exchange) => exchange.method === "POST");
      assert.ok(posted, "the mint posted a build");
      if (posted.status !== 202) {
        t.skip(
          `the build of ${start} to 2024 answered ${posted.status}, not 202: the server built it inline`,
        );
        return;
      }
      const { operationId } = operation;
      assert.ok(operationId?.startsWith("op_") === true, `operation id ${String(operationId)}`);

      const resumed = resumeElsewhere(operationId);
      const { value: dataset, exchanges: polls } = await exchangesOf(() => operation.result());
      assert.ok(dataset.rows > 100_000, `${dataset.rows} rows`);

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
      assert.equal(other.content_version, dataset.members[0]?.contentVersion);
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
): Promise<{ content_version: string; rows: number }> {
  const entry = new URL("../../src/index.ts", import.meta.url).href;
  const code = `
    const { Client } = await import(${JSON.stringify(entry)});
    const client = new Client({ baseUrl: ${JSON.stringify(baseUrl)} });
    const operation = await client.operation(${JSON.stringify(operationId)});
    const dataset = await operation.result();
    process.stdout.write(JSON.stringify({
      content_version: dataset.members[0].contentVersion,
      rows: dataset.rows,
    }));
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "--eval", code],
    { maxBuffer: 1 << 20, timeout: 900_000 },
  );
  return JSON.parse(stdout) as { content_version: string; rows: number };
}
