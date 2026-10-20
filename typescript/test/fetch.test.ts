import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Dataset } from "../src/dataset.ts";
import { DfoError } from "../src/errors.ts";
import { fetchDataset, fetchMembers } from "../src/fetch.ts";
import type { FetchOptions, MemberRequest, SpecInput } from "../src/fetch.ts";
import { DatasetRef } from "../src/ref.ts";
import type { DfoWarning } from "../src/warnings.ts";
import type { SpecLike } from "../src/ref.ts";
import { replay, scenario } from "./replay.ts";
import { contractJson } from "./support.ts";
import type { Scenario } from "./replay.ts";

type Json = Record<string, unknown>;
type Gap = { part: number; kind: string };
type ExpectedDataset = {
  rows: number;
  columns: string[];
  complete: boolean;
  members: { parts: string[]; spec_id: string; content_version: string; sentence: string }[];
  missing: Gap[];
};
type Outcome = { dataset?: ExpectedDataset; error?: { class: string; code: string | null } };

async function assertDataset(dataset: Dataset<Gap>, expected: ExpectedDataset): Promise<void> {
  assert.equal(dataset.rows, expected.rows);
  assert.deepEqual(dataset.columns, expected.columns);
  assert.equal(dataset.complete, expected.complete);
  assert.deepEqual(
    dataset.members.map((member) => ({
      parts: [...member.parts],
      spec_id: member.spec.spec_id,
      content_version: member.contentVersion,
      sentence: member.sentence,
    })),
    expected.members,
  );
  assert.deepEqual(dataset.missing, expected.missing);
  const rows = await dataset.toRows();
  assert.equal(rows.length, expected.rows);
  assert.deepEqual(Object.keys(rows[0] ?? {}), expected.columns);
}

/** Runs one fetch and checks it reaches the scenario's outcome, using every exchange. */
async function reaches(
  record: Scenario,
  outcome: Outcome,
  run: () => Promise<Dataset<Gap>>,
  remaining: () => number,
): Promise<void> {
  if (outcome.error !== undefined) {
    const { class: name, code } = outcome.error;
    await assert.rejects(run(), (error: unknown) => {
      assert.ok(error instanceof DfoError, `${record.name}: ${String(error)}`);
      assert.equal(error.name, name);
      if (code !== null) assert.equal(error.code, code);
      return true;
    });
  } else {
    await assertDataset(await run(), outcome.dataset!);
  }
  assert.equal(remaining(), 0, `${record.name}: exchanges left unrequested`);
}

/** The members an answer's fetch builds, read from the recorded search response: each
 *  definite part, or the candidate a choose step picks, keyed on its spec. */
function answerMembers(record: Scenario): MemberRequest[] {
  const answer = record.exchanges[0]!.response.json as { parts: Json[] };
  const choose = record.call.find((step) => step["op"] === "choose");
  const members: MemberRequest[] = [];
  for (const part of answer.parts) {
    let spec: (SpecLike & { resolved?: { rendered_sentence?: string } }) | undefined;
    if (part["status"] === "definite") spec = part["spec"] as typeof spec;
    if (part["status"] === "candidates" && choose !== undefined) {
      const specs = (part["candidates"] as { specs: NonNullable<typeof spec>[] }).specs;
      spec = specs[choose["option"] as number];
    }
    if (spec === undefined) continue;
    members.push({
      parts: [part["variable_text"] as string],
      spec,
      sentence: spec.resolved?.rendered_sentence,
    });
  }
  return members;
}

describe("an answer's fetch reaches each scenario's outcome", () => {
  for (const name of [
    "answer-definite-fetch",
    "answer-candidates-choose-fetch",
    "answer-mixed-fetch-partial",
    "answer-several-readings-folded",
    "fetch-null-member",
    "fetch-retry-after-504",
    "fetch-renamed-strict-field",
  ]) {
    test(name, async () => {
      const record = await scenario(name);
      const { transport, remaining } = replay(record, { skip: 1 });
      const outcome = record.expect.at(-1) as Outcome;
      const missing = outcome.dataset?.missing ?? [];
      await reaches(
        record,
        outcome,
        () => fetchMembers<Gap>(transport, answerMembers(record), { missing }),
        remaining,
      );
    });
  }
});

describe("a spec or ref fetch reaches each scenario's outcome", () => {
  for (const name of [
    "fetch-spec-known-sentence",
    "fetch-spec-narrowed",
    "fetch-spec-request-invalid",
    "fetch-ref",
    "fetch-ref-signed-url-refused",
    "fetch-ref-unknown-version",
  ]) {
    test(name, async () => {
      const record = await scenario(name);
      const { transport, remaining } = replay(record);
      const step = record.call[0]!;
      const target =
        step["ref"] === undefined ? (step["spec"] as SpecInput) : DatasetRef.fromJSON(step["ref"]);
      const options: FetchOptions = {};
      if (step["window"] !== undefined) options.window = step["window"] as [number, number];
      if (step["facets"] !== undefined) options.facets = step["facets"] as Record<string, string>;
      await reaches(
        record,
        record.expect[0] as Outcome,
        () => fetchDataset(transport, target, options),
        remaining,
      );
    });
  }

  test("a fetched spec's ref is the contract's ref for that member", async () => {
    const record = await scenario("fetch-spec-known-sentence");
    const dataset = await fetchDataset(
      replay(record).transport,
      record.call[0]!["spec"] as SpecInput,
    );
    const { ref } = await contractJson<{ ref: unknown }>("refs/ref-one-member.json");
    assert.deepEqual(JSON.parse(JSON.stringify(dataset.ref)), ref);
  });
});

describe("a manifest's warnings", () => {
  test("reach the warning handler, or raise the first under strict", async () => {
    const record = await scenario("fetch-spec-known-sentence");
    const spec = record.call[0]!["spec"] as SpecInput;
    const seen: DfoWarning[] = [];
    await fetchDataset(
      replay(record, { onWarning: (warning) => seen.push(warning) }).transport,
      spec,
    );
    assert.deepEqual(
      seen.map((warning) => warning.code),
      ["coverage_below_scope"],
    );
    await assert.rejects(fetchDataset(replay(record).transport, spec, { strict: true }), {
      name: "DfoWarning",
      code: "coverage_below_scope",
    });
  });
});

describe("arguments a fetch refuses before any request", () => {
  const { transport } = replay({
    name: "none",
    origin: { kind: "synthetic", derived_from: "none" },
    call: [],
    exchanges: [],
    expect: [],
  });
  const spec = (id: string): SpecLike => ({ spec_id: id, definition: { spec_id: id } });

  test("the frame layout with several members", async () => {
    await assert.rejects(
      fetchMembers(
        transport,
        [
          { parts: ["a"], spec: spec("spec_1") },
          { parts: ["b"], spec: spec("spec_2") },
        ],
        { layout: "frame" },
      ),
      { name: "InvalidRequestError", code: "invalid_argument" },
    );
  });

  test("a narrowed ref", async () => {
    const record = await scenario("fetch-ref");
    const ref = DatasetRef.fromJSON(record.call[0]!["ref"]);
    await assert.rejects(fetchDataset(transport, ref, { window: [2020, 2021] }), {
      name: "InvalidRequestError",
    });
  });

  test("a window that is not a pair of years", async () => {
    await assert.rejects(fetchDataset(transport, spec("spec_1"), { window: [2020.5, 2021] }), {
      name: "InvalidRequestError",
    });
  });
});
