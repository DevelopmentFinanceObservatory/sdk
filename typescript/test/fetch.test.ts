import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { clientOver } from "../src/client.ts";
import type { Dataset } from "../src/dataset.ts";
import { fetchDataset, fetchMembers } from "../src/fetch.ts";
import type { FetchOptions } from "../src/fetch.ts";
import { DatasetRef } from "../src/ref.ts";
import type { SpecLike } from "../src/ref.ts";
import type { DfoWarning } from "../src/warnings.ts";
import { assertDataset, assertError, NO_EXCHANGES, replay, scenario, stepOf } from "./replay.ts";
import type { Exchange, Outcome, Scenario } from "./replay.ts";
import { contractJson } from "./support.ts";

/** Runs one fetch and checks it reaches the scenario's outcome, using every exchange. */
async function reaches(
  record: Scenario,
  outcome: Outcome,
  run: () => Promise<Dataset>,
  remaining: () => Exchange[],
): Promise<void> {
  if ("error" in outcome) {
    await assert.rejects(run(), (error: unknown) => {
      assertError(error, outcome.error, record.name);
      return true;
    });
  } else {
    assert.ok("dataset" in outcome, `${record.name}: the outcome is a dataset`);
    await assertDataset(await run(), outcome.dataset, record.name);
  }
  assert.deepEqual(remaining(), [], `${record.name}: exchanges left unrequested`);
}

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
      const { spec, ref, window, facets } = stepOf(record, 0, "fetch");
      const target = ref === undefined ? spec : DatasetRef.fromJSON(ref);
      assert.ok(target, `${record.name}: the step names a spec or a ref`);
      const options: FetchOptions = {
        ...(window === undefined ? {} : { window }),
        ...(facets === undefined ? {} : { facets }),
      };
      await reaches(
        record,
        record.expect[0]!,
        () => clientOver(transport).fetch(target, options),
        remaining,
      );
    });
  }

  test("a fetched spec's ref is the contract's ref for that member", async () => {
    const record = await scenario("fetch-spec-known-sentence");
    const { spec } = stepOf(record, 0, "fetch");
    assert.ok(spec);
    const dataset = await fetchDataset(replay(record).transport, spec);
    const { ref } = await contractJson<{ ref: unknown }>("refs/ref-one-member.json");
    assert.deepEqual(JSON.parse(JSON.stringify(dataset.ref)), ref);
  });
});

describe("a manifest's warnings", () => {
  test("reach the warning handler, or raise the first under strict", async () => {
    const record = await scenario("fetch-spec-known-sentence");
    const { spec } = stepOf(record, 0, "fetch");
    assert.ok(spec);
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
  const { transport } = replay(NO_EXCHANGES);
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
    const ref = DatasetRef.fromJSON(stepOf(record, 0, "fetch").ref);
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
