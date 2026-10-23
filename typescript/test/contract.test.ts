// Replays every scenario in `contract/scenarios` through `clientOver(transport)` under its
// recorded base URL and under each of `REPLAY_BASE_URLS`, one step at a time, and checks every
// member of each step's expected outcome. A member this replay does not know fails the scenario,
// so a contract that grows an expectation fails here until the replay checks it. Every recorded exchange must be requested. A step's retry waits and warnings are
// checked on every outcome, as none when the outcome gives none. Each scenario starts as a fresh
// process does, with no warning emitted.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { Answer, SearchWarning } from "../src/search/answer.ts";
import { clientOver } from "../src/client.ts";
import type { Client } from "../src/client.ts";
import { Dataset } from "../src/datasets/dataset.ts";
import { newestVersion } from "../src/datasets/resolve.ts";
import type { FetchOptions, Narrowing } from "../src/datasets/fetch.ts";
import { Operation } from "../src/datasets/operation.ts";
import type { LongBuild } from "../src/datasets/operation.ts";
import { DatasetRef, renderingFor } from "../src/core/ref.ts";
import type { Transport } from "../src/http/transport.ts";
import { DfoError, isDfoError, VersionUnavailableError } from "../src/core/errors.ts";
import { CLIENT_CODE_CLASSES } from "../src/generated/client-codes.ts";
import { DataWarning, DfoWarning, forgetEmittedWarnings } from "../src/core/warnings.ts";
import { recordedBaseUrl, replay, REPLAY_BASE_URLS, scenarios } from "./replay.ts";
import type { LongBuildSummary, Outcome, Scenario, Step } from "./replay.ts";

const all = await scenarios();

/** A `newest_version` step's version. */
type NewestVersion = { readonly newestVersion: string | null };

type Reached = Answer | Dataset | Operation | NewestVersion;

const WARNING_CLASSES = new Set(["SearchWarning", "DataWarning"]);

/** The narrowing, layout and strictness members a step sets, as call options. */
function callOptions(step: Narrowing & { layout?: unknown; strict?: unknown }) {
  const options: Record<string, unknown> = {};
  for (const key of ["window", "entities", "facets", "layout", "strict", "partial"]) {
    const value = (step as Record<string, unknown>)[key];
    if (value !== undefined) options[key] = value;
  }
  return options;
}

/** What a step issued beside its outcome: its warnings, the long builds it polled, and its
 *  waits before retries other than polls, in seconds. */
type Observed = { warnings: unknown[]; longBuilds: LongBuild[]; retryWaits: number[] };

/** A long build as the contract states it, its waits in seconds. */
const longBuildSummary = (build: LongBuild): LongBuildSummary => ({
  operation_id: build.operationId ?? "",
  poll_waits: build.pollWaits.map((ms) => ms / 1000),
  resubmissions: build.resubmissions,
});

/** Runs one step from the previous step's outcome. */
async function run(
  client: Client,
  transport: Transport,
  step: Step,
  previous: Reached | undefined,
): Promise<Reached> {
  switch (step.op) {
    case "search":
      return client.search(step.question);
    case "choose":
      assert.ok(previous instanceof Answer, "a choice follows an answer");
      return step.part === undefined
        ? previous.choose(step.option)
        : previous.choose(step.part, step.option);
    case "fetch": {
      const { spec, ref, ...rest } = step;
      const options = callOptions(rest) as FetchOptions;
      if (ref !== undefined) return client.fetch(DatasetRef.fromJSON(ref), options);
      if (spec !== undefined) return client.fetch(spec, options);
      assert.ok(previous instanceof Answer, "a fetch of no spec or ref follows an answer");
      return previous.fetch(options);
    }
    case "newest_version":
      // The step names a spec alone, so it asks for the newest plain version.
      return {
        newestVersion: await newestVersion(transport, step.spec.spec_id, renderingFor("long"), {
          deadline: Infinity,
        }),
      };
    case "mint": {
      const { spec, ...rest } = step;
      return client.mint(spec, callOptions(rest));
    }
    case "operation":
      return client.operation(
        step.operation_id,
        step.layout === undefined ? {} : { layout: step.layout },
      );
    case "result":
      assert.ok(previous instanceof Operation, "a result follows a mint");
      return previous.result();
    default:
      assert.fail(`the replay does not know the step ${JSON.stringify(step)}`);
  }
}

/** The members every outcome may give, with the value a step that gives none has. */
const STEP_MEMBERS = { retry_waits: [], warnings: [] };

/** The codes of the warnings a step's API responses issued: every warning but a
 *  `SearchWarning` or a `DataWarning`, which come from an answer or a manifest. */
const responseWarnings = (warnings: readonly unknown[]): (string | null)[] =>
  warnings
    .filter(
      (warning): warning is DfoWarning =>
        warning instanceof DfoWarning &&
        !(warning instanceof SearchWarning) &&
        !(warning instanceof DataWarning),
    )
    .map((warning) => warning.code);

/** Checks each expected member against the value the step reached for it, failing on a member
 *  the replay does not know, and the step's retry waits and warnings, which an outcome that
 *  leaves them out expects none of. */
function checkMembers(
  name: string,
  expected: Record<string, unknown>,
  reached: Record<string, unknown>,
  observed: Observed,
): void {
  const step = {
    retry_waits: observed.retryWaits,
    warnings: responseWarnings(observed.warnings),
  };
  for (const [member, none] of Object.entries(STEP_MEMBERS)) {
    assert.deepEqual(
      step[member as keyof typeof step],
      expected[member] ?? none,
      `${name}: ${member}`,
    );
  }
  for (const [member, want] of Object.entries(expected)) {
    if (Object.hasOwn(STEP_MEMBERS, member)) continue;
    assert.ok(
      Object.hasOwn(reached, member),
      `${name}: the replay does not know the expected member ${member}`,
    );
    assert.deepEqual(reached[member], want, `${name}: ${member}`);
  }
}

function checkAnswer(
  answer: Answer,
  expected: Record<string, unknown>,
  name: string,
  observed: Observed,
): void {
  checkMembers(
    name,
    expected,
    {
      kind: answer.kind,
      status: answer.status,
      sentence: answer.sentence,
      complete: answer.complete,
      specs: answer.specs.map((spec) => spec.spec_id),
      gaps: answer.gaps.map((gap) => ({
        part: gap.partIndex,
        kind: gap.kind,
        options: gap.options.length,
      })),
    },
    observed,
  );
}

/** Checks a dataset, its decoded rows included. */
async function checkDataset(
  dataset: Dataset,
  expected: Record<string, unknown>,
  name: string,
  observed: Observed,
): Promise<void> {
  const rows = await dataset.toRows();
  assert.equal(rows.length, dataset.rows, `${name}: decoded rows`);
  assert.deepEqual(Object.keys(rows[0] ?? {}), dataset.columns, `${name}: decoded columns`);
  const partRows = new Map<string, number>();
  for (const row of rows) {
    const part = String(row["part"]);
    partRows.set(part, (partRows.get(part) ?? 0) + 1);
  }
  checkMembers(
    name,
    expected,
    {
      rows: dataset.rows,
      columns: dataset.columns,
      complete: dataset.complete,
      members: dataset.members.map((member) => ({
        parts: [...member.parts],
        spec_id: member.spec.spec_id,
        content_version: member.contentVersion,
        sentence: member.sentence,
      })),
      missing: dataset.missing.map((gap) => ({ part: gap.partIndex, kind: gap.kind })),
      part_rows: [...partRows].map(([part, count]) => ({ part, rows: count })),
      search_warning: observed.warnings.some((warning) => warning instanceof SearchWarning),
      long_builds: observed.longBuilds.map(longBuildSummary),
    },
    observed,
  );
}

/** Checks a refusal's class and code, and a `VersionUnavailableError`'s newest version. A
 *  strict fetch throws a `SearchWarning` or a `DataWarning`, each a `DfoWarning`; a
 *  `SearchWarning`'s code is null when the readings differ in several ways. */
function checkError(
  error: unknown,
  expected: Record<string, unknown>,
  name: string,
  observed: Observed,
): void {
  assert.ok(isDfoError(error) || error instanceof DfoWarning, `${name}: ${String(error)}`);
  if (!WARNING_CLASSES.has(String(expected["class"]))) {
    assert.ok(error instanceof DfoError, `${name}: ${String(error)}`);
  }
  checkMembers(
    name,
    expected,
    {
      class: error.name,
      code: error.code,
      trace_id: error.traceId,
      ...(error instanceof VersionUnavailableError ? { newest_version: error.newestVersion } : {}),
      long_builds: observed.longBuilds.map(longBuildSummary),
    },
    observed,
  );
}

/** Checks a step's outcome; the outcome's own kind must be one the replay knows. */
async function checkOutcome(
  reached: Reached,
  expected: Outcome,
  name: string,
  observed: Observed,
): Promise<void> {
  const [kind, ...extra] = Object.keys(expected);
  assert.deepEqual(extra, [], `${name}: an outcome names one kind`);
  if ("answer" in expected) {
    assert.ok(reached instanceof Answer, `${name}: gave an answer`);
    checkAnswer(reached, expected.answer, name, observed);
    return;
  }
  if ("dataset" in expected) {
    assert.ok(reached instanceof Dataset, `${name}: gave a dataset`);
    return checkDataset(reached, expected.dataset, name, observed);
  }
  if ("operation" in expected) {
    assert.ok(reached instanceof Operation, `${name}: gave an operation`);
    checkMembers(
      name,
      expected.operation,
      {
        operation_id: reached.operationId,
        status: reached.status,
      },
      observed,
    );
    return;
  }
  if ("newest_version" in expected) {
    assert.ok("newestVersion" in reached, `${name}: gave a newest version`);
    checkMembers(
      name,
      expected.newest_version,
      {
        content_version: reached.newestVersion,
      },
      observed,
    );
    return;
  }
  assert.fail(`${name}: the replay does not know the outcome ${kind}`);
}

async function replayScenario(record: Scenario, baseUrl?: string): Promise<void> {
  assert.equal(record.expect.length, record.call.length, `${record.name}: one outcome per step`);
  forgetEmittedWarnings();
  const observed: Observed = { warnings: [], longBuilds: [], retryWaits: [] };
  const { transport, retryWaits, remaining } = replay(record, {
    ...(baseUrl === undefined ? {} : { baseUrl }),
    onWarning: (warning) => observed.warnings.push(warning),
    onLongBuild: (build) => observed.longBuilds.push(build),
  });
  const client = clientOver(transport);
  let previous: Reached | undefined;
  for (const [index, step] of record.call.entries()) {
    const expected = record.expect[index]!;
    const name = `${record.name}: step ${index} (${step.op})`;
    observed.warnings.length = 0;
    observed.longBuilds.length = 0;
    const retriesBefore = retryWaits.length;
    let reached: Reached;
    try {
      reached = await run(client, transport, step, previous);
    } catch (error) {
      observed.retryWaits = retryWaits.slice(retriesBefore).map((ms) => ms / 1000);
      if (!("error" in expected)) throw error;
      checkError(error, expected.error, name, observed);
      continue;
    }
    observed.retryWaits = retryWaits.slice(retriesBefore).map((ms) => ms / 1000);
    assert.ok(!("error" in expected), `${name}: expected ${JSON.stringify(expected)}`);
    await checkOutcome(reached, expected, name, observed);
    previous = reached;
  }
  assert.deepEqual(remaining(), [], `${record.name}: exchanges left unrequested`);
}

describe("every contract scenario", () => {
  for (const record of all) {
    const baseUrls = { recorded: recordedBaseUrl(record), ...REPLAY_BASE_URLS };
    for (const [form, baseUrl] of Object.entries(baseUrls)) {
      test(`${record.name} at the ${form} base URL`, () => replayScenario(record, baseUrl));
    }
  }
});

/** The client codes of errors that describe a response; every other client code describes the
 *  caller's input or a storage-host fetch. A server's code always describes its refusal. */
const DESCRIBING_CODES = new Set([
  "unexpected_response",
  "contract_violation",
  "answer_declined",
  "answer_incomplete",
  "refusal_without_code",
]);

const describesResponse = (error: DfoError | DfoWarning): boolean =>
  error instanceof DfoWarning ||
  !Object.hasOwn(CLIENT_CODE_CLASSES, error.code) ||
  DESCRIBING_CODES.has(error.code);

// Each API response of an error scenario gains its own x-dfo-trace-id where it names none, so
// every error that describes a response must carry the trace id of the last API response the
// client read before raising it: the refusal, the body it read, or for an error about a held
// answer, the Search response that answered it. Any other error carries none.
describe("every error carries the trace id of the response it describes", () => {
  const traced = (index: number): string => (index + 1).toString(16).padStart(32, "a");
  for (const original of all.filter((record) =>
    record.expect.some((outcome) => "error" in outcome),
  )) {
    test(original.name, async () => {
      const record = structuredClone(original);
      for (const [index, { request, response }] of record.exchanges.entries()) {
        const body = response.json as { trace_id?: unknown } | undefined;
        const named = response.headers?.["x-dfo-trace-id"] ?? body?.trace_id;
        if (request.url === undefined && named === undefined) {
          response.headers = { ...response.headers, "x-dfo-trace-id": traced(index) };
        }
      }
      forgetEmittedWarnings();
      const { transport, urls } = replay(record, { onWarning: () => undefined });
      const client = clientOver(transport);
      let previous: Reached | undefined;
      for (const [index, step] of record.call.entries()) {
        const expected = record.expect[index]!;
        try {
          previous = await run(client, transport, step, previous);
          continue;
        } catch (error) {
          if (!("error" in expected)) throw error;
          assert.ok(isDfoError(error) || error instanceof DfoWarning, String(error));
          const read = record.exchanges
            .slice(0, urls.length)
            .findLastIndex((exchange) => exchange.request.url === undefined);
          const lastRead = read === -1 ? null : record.exchanges[read]!;
          const want =
            expected.error.trace_id ??
            (describesResponse(error) && lastRead !== null
              ? (lastRead.response.headers?.["x-dfo-trace-id"] ?? null)
              : null);
          assert.equal(error.traceId, want, `${record.name}: step ${index} trace id`);
        }
      }
    });
  }
});

describe("an error's trace id is the one of the response it describes", () => {
  const BODY_TRACE = "b".repeat(32);
  const HEADER_TRACE = "c".repeat(32);
  type Row = {
    name: string;
    scenario: string;
    edit: (record: Scenario) => void;
    code: string;
    traceId: string;
  };
  const named = (record: Scenario, index: number): void => {
    const { response } = record.exchanges[index]!;
    response.headers = { ...response.headers, "x-dfo-trace-id": HEADER_TRACE };
  };
  const rows: Row[] = [
    {
      name: "a stored version answered as another version",
      scenario: "fetch-ref",
      edit: (record) => {
        record.exchanges = record.exchanges.slice(0, 1);
        named(record, 0);
        (record.exchanges[0]!.response.json as Record<string, unknown>)["content_version"] =
          `cv_${"0".repeat(32)}`;
      },
      code: "contract_violation",
      traceId: HEADER_TRACE,
    },
    {
      name: "an operation resource without its status, by its body's trace id over the header",
      scenario: "fetch-spec-async-build",
      edit: (record) => {
        record.exchanges = record.exchanges.slice(0, 1);
        named(record, 0);
        const resource = record.exchanges[0]!.response.json as Record<string, unknown>;
        resource["trace_id"] = BODY_TRACE;
        delete (resource["operation"] as Record<string, unknown>)["status"];
      },
      code: "contract_violation",
      traceId: BODY_TRACE,
    },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const record = structuredClone(all.find((each) => each.name === row.scenario)!);
      row.edit(record);
      const { transport, remaining } = replay(record, { onWarning: () => undefined });
      const client = clientOver(transport);
      const steps = record.call;
      let previous: Reached | undefined;
      for (const step of steps.slice(0, -1))
        previous = await run(client, transport, step, previous);
      await assert.rejects(run(client, transport, steps.at(-1)!, previous), {
        code: row.code,
        traceId: row.traceId,
      });
      assert.deepEqual(remaining(), []);
    });
  }
});

describe("the replay refuses what it cannot check", () => {
  const definite = all.find((record) => record.name === "answer-definite-fetch")!;
  const edited = (edit: (record: Scenario) => void): Scenario => {
    const copy = structuredClone(definite);
    edit(copy);
    return copy;
  };

  test("an expected member it does not know", async () => {
    const record = edited((copy) => {
      Object.assign((copy.expect[0] as { answer: object }).answer, { labels: [] });
    });
    await assert.rejects(replayScenario(record), /does not know the expected member/);
  });

  test("an outcome it does not know", async () => {
    const record = edited((copy) => {
      copy.expect[1] = { table: {} } as unknown as Outcome;
    });
    await assert.rejects(replayScenario(record), /does not know the outcome table/);
  });

  test("a step it does not know", async () => {
    const record = edited((copy) => {
      copy.call[0] = { op: "explain" } as unknown as Step;
    });
    await assert.rejects(replayScenario(record), /does not know the step/);
  });
});
