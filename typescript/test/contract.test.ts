// Replays every scenario in `contract/scenarios` through `clientOver(transport)`, one step at a
// time, and checks every member of each step's expected outcome. A member this replay does not
// know fails the scenario, so a contract that grows an expectation fails here until the replay
// checks it. Every recorded exchange must be requested.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { Answer, SearchWarning } from "../src/answer.ts";
import type { Gap } from "../src/answer.ts";
import { clientOver } from "../src/client.ts";
import type { Client } from "../src/client.ts";
import { Dataset } from "../src/dataset.ts";
import type { FetchOptions, Narrowing } from "../src/fetch.ts";
import { Operation } from "../src/operation.ts";
import { DatasetRef } from "../src/ref.ts";
import { DfoError, isDfoError } from "../src/errors.ts";
import { replay, scenarios } from "./replay.ts";
import type { Outcome, Scenario, Step } from "./replay.ts";

const all = await scenarios();

type Reached = Answer | Dataset<Gap> | Operation;

/** The narrowing, layout, strictness and timeout members a step sets, as call options. */
function callOptions(step: Narrowing & { layout?: unknown; strict?: unknown; timeout?: unknown }) {
  const options: Record<string, unknown> = {};
  for (const key of ["window", "entities", "facets", "layout", "strict", "timeout", "partial"]) {
    const value = (step as Record<string, unknown>)[key];
    if (value !== undefined) options[key] = value;
  }
  return options;
}

/** Runs one step from the previous step's outcome. */
async function run(client: Client, step: Step, previous: Reached | undefined): Promise<Reached> {
  switch (step.op) {
    case "search":
      return client.search(
        step.question,
        step.timeout === undefined ? {} : { timeout: step.timeout },
      );
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
    case "mint": {
      const { spec, ...rest } = step;
      return client.mint(spec, callOptions(rest));
    }
    case "result":
      assert.ok(previous instanceof Operation, "a result follows a mint");
      return previous.result(step.timeout === undefined ? {} : { timeout: step.timeout });
    default:
      assert.fail(`the replay does not know the step ${JSON.stringify(step)}`);
  }
}

/** Checks each expected member against the value the step reached for it, failing on a member
 *  the replay does not know. */
function checkMembers(
  name: string,
  expected: Record<string, unknown>,
  reached: Record<string, unknown>,
): void {
  for (const [member, want] of Object.entries(expected)) {
    assert.ok(
      Object.hasOwn(reached, member),
      `${name}: the replay does not know the expected member ${member}`,
    );
    assert.deepEqual(reached[member], want, `${name}: ${member}`);
  }
}

function checkAnswer(answer: Answer, expected: Record<string, unknown>, name: string): void {
  checkMembers(name, expected, {
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
  });
}

/** Checks a dataset, its decoded rows included. */
async function checkDataset(
  dataset: Dataset<Gap>,
  expected: Record<string, unknown>,
  name: string,
  warnings: readonly unknown[],
): Promise<void> {
  const rows = await dataset.toRows();
  assert.equal(rows.length, dataset.rows, `${name}: decoded rows`);
  assert.deepEqual(Object.keys(rows[0] ?? {}), dataset.columns, `${name}: decoded columns`);
  const partRows = new Map<string, number>();
  for (const row of rows) {
    const part = String(row["part"]);
    partRows.set(part, (partRows.get(part) ?? 0) + 1);
  }
  checkMembers(name, expected, {
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
    search_warning: warnings.some((warning) => warning instanceof SearchWarning),
  });
}

/** Checks a refusal's class and code. A strict fetch throws a `SearchWarning`, which is a
 *  `DfoWarning` and whose code is null when the readings differ in several ways. */
function checkError(error: unknown, expected: Record<string, unknown>, name: string): void {
  assert.ok(isDfoError(error) || error instanceof SearchWarning, `${name}: ${String(error)}`);
  if (expected["class"] !== "SearchWarning") {
    assert.ok(error instanceof DfoError, `${name}: ${String(error)}`);
  }
  checkMembers(name, expected, { class: error.name, code: error.code });
}

/** Checks a step's outcome; the outcome's own kind must be one the replay knows. */
async function checkOutcome(
  reached: Reached,
  expected: Outcome,
  name: string,
  warnings: readonly unknown[],
): Promise<void> {
  const [kind, ...extra] = Object.keys(expected);
  assert.deepEqual(extra, [], `${name}: an outcome names one kind`);
  if ("answer" in expected) {
    assert.ok(reached instanceof Answer, `${name}: gave an answer`);
    checkAnswer(reached, expected.answer, name);
    return;
  }
  if ("dataset" in expected) {
    assert.ok(reached instanceof Dataset, `${name}: gave a dataset`);
    return checkDataset(reached, expected.dataset, name, warnings);
  }
  if ("operation" in expected) {
    assert.ok(reached instanceof Operation, `${name}: gave an operation`);
    checkMembers(name, expected.operation, {
      operation_id: reached.operationId,
      status: reached.status,
    });
    return;
  }
  assert.fail(`${name}: the replay does not know the outcome ${kind}`);
}

async function replayScenario(record: Scenario): Promise<void> {
  assert.equal(record.expect.length, record.call.length, `${record.name}: one outcome per step`);
  const warnings: unknown[] = [];
  const { transport, remaining } = replay(record, {
    onWarning: (warning) => warnings.push(warning),
  });
  const client = clientOver(transport);
  let previous: Reached | undefined;
  for (const [index, step] of record.call.entries()) {
    const expected = record.expect[index]!;
    const name = `${record.name}: step ${index} (${step.op})`;
    warnings.length = 0;
    let reached: Reached;
    try {
      reached = await run(client, step, previous);
    } catch (error) {
      if (!("error" in expected)) throw error;
      checkError(error, expected.error, name);
      continue;
    }
    assert.ok(!("error" in expected), `${name}: expected ${JSON.stringify(expected)}`);
    await checkOutcome(reached, expected, name, warnings);
    previous = reached;
  }
  assert.deepEqual(remaining(), [], `${record.name}: exchanges left unrequested`);
}

describe("every contract scenario", () => {
  for (const record of all) {
    test(record.name, () => replayScenario(record));
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
