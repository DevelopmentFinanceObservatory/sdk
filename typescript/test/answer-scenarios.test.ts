// Replays every contract scenario that starts with a search, through `Client.search`, `choose`
// and `Answer.fetch` with the fetch module's own `fetchMembers`, and asserts each step's expected
// outcome, the built dataset's rows included. Every recorded exchange must be requested.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { Answer, SearchWarning } from "../src/answer.ts";
import type { Gap } from "../src/answer.ts";
import { clientOver } from "../src/client.ts";
import type { Dataset } from "../src/dataset.ts";
import { assertDataset, assertError, replay, scenarios } from "./replay.ts";
import type { AnswerSummary, Scenario } from "./replay.ts";

const all = await scenarios();
const searchScenarios = all.filter((record) => record.call[0]?.op === "search");

function summarise(answer: Answer): AnswerSummary {
  return {
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
  };
}

async function replayAnswer(record: Scenario): Promise<void> {
  const warnings: unknown[] = [];
  const { transport, remaining } = replay(record, {
    onWarning: (warning) => warnings.push(warning),
  });
  const client = clientOver(transport);

  let answer: Answer | undefined;
  for (const [index, step] of record.call.entries()) {
    const expected = record.expect[index]!;
    const name = `${record.name}: step ${index}`;
    let outcome: Answer | Dataset<Gap>;
    warnings.length = 0;
    try {
      if (step.op === "search") outcome = await client.search(step.question);
      else if (step.op === "choose") {
        assert.ok(answer, name);
        outcome =
          step.part === undefined
            ? await answer.choose(step.option)
            : await answer.choose(step.part, step.option);
      } else if (step.op === "fetch") {
        assert.ok(answer, name);
        const { partial, strict, layout, timeout } = step;
        outcome = await answer.fetch({
          ...(partial === undefined ? {} : { partial }),
          ...(strict === undefined ? {} : { strict }),
          ...(layout === undefined ? {} : { layout }),
          ...(timeout === undefined ? {} : { timeout }),
        });
      } else throw new Error(`${name}: ${step.op} does not start from an answer`);
    } catch (error) {
      if (!("error" in expected)) throw error;
      assertError(error, expected.error, name);
      continue;
    }
    if (outcome instanceof Answer) {
      answer = outcome;
      assert.ok("answer" in expected, `${name} gave an answer`);
      const want = expected.answer;
      const got = summarise(outcome);
      assert.deepEqual(
        want.status === undefined ? { ...got, status: undefined } : got,
        { ...want, status: want.status },
        name,
      );
      continue;
    }
    assert.ok("dataset" in expected, `${name} gave a dataset`);
    await assertDataset(outcome, expected.dataset, name);
    if (expected.dataset.search_warning !== undefined) {
      const issued = warnings.some((warning) => warning instanceof SearchWarning);
      assert.equal(issued, expected.dataset.search_warning, `${name}: SearchWarning issued`);
    }
  }
  assert.deepEqual(remaining(), [], `${record.name}: exchanges left unrequested`);
}

describe("scenarios that start with a search", () => {
  test("cover search, choose and fetch", () => {
    const ops = new Set(searchScenarios.flatMap((record) => record.call.map((step) => step.op)));
    assert.deepEqual([...ops].toSorted(), ["choose", "fetch", "search"]);
  });

  test("include an answer the fetch module builds after a choice", () => {
    const built = searchScenarios.filter(
      (record) =>
        record.name.startsWith("answer-") &&
        record.call.some((step) => step.op === "choose") &&
        record.expect.some((outcome) => "dataset" in outcome),
    );
    assert.ok(built.length > 0);
  });

  for (const record of searchScenarios) {
    test(record.name, () => replayAnswer(record));
  }
});
