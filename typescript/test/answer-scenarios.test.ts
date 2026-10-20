// Replays every contract scenario that starts with a search, through `search`, `choose` and
// `Answer.fetch`, and asserts each step's expected outcome. A fetch that builds hands its members
// to a fake `fetchMembers`; the replay checks the members it receives and that no request after
// the searches was made.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { Answer } from "../src/answer.ts";
import type { AnswerContext } from "../src/answer.ts";
import { DfoError, isDfoError } from "../src/errors.ts";
import type { Dataset, FetchMember, FetchMembersOptions } from "../src/fetch-members.ts";
import { search } from "../src/search.ts";
import type { DfoWarning } from "../src/warnings.ts";
import { replayFetch, replayTransport, scenarios } from "./replay.ts";
import type { AnswerSummary, Outcome, Scenario } from "./replay.ts";

const all = await scenarios();
const searchScenarios = all.filter((scenario) => scenario.call[0]?.op === "search");

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

type Built = { members: readonly FetchMember[]; options: FetchMembersOptions };

async function replay(scenario: Scenario): Promise<{ built: Built[]; warnings: DfoWarning[] }> {
  const { fetch, remaining } = replayFetch(scenario);
  const { transport } = replayTransport(fetch);
  const built: Built[] = [];
  const warnings: DfoWarning[] = [];
  const dataset: Dataset = { complete: true, missing: [] };
  const context: AnswerContext = {
    transport,
    onWarning: (warning) => warnings.push(warning),
    fetchMembers: (_, members, options) => {
      built.push({ members, options });
      return Promise.resolve(dataset);
    },
  };

  let answer: Answer | undefined;
  for (const [index, step] of scenario.call.entries()) {
    const expected: Outcome = scenario.expect[index]!;
    let outcome: Answer | Dataset;
    try {
      if (step.op === "search") outcome = await search(context, step.question);
      else if (step.op === "choose") {
        assert.ok(answer);
        outcome =
          step.part === undefined
            ? await answer.choose(step.option)
            : await answer.choose(step.part, step.option);
      } else if (step.op === "fetch") {
        assert.ok(answer);
        outcome = await answer.fetch({
          ...(step.partial === undefined ? {} : { partial: step.partial }),
          ...(step.strict === undefined ? {} : { strict: step.strict }),
        });
      } else throw new Error(`${scenario.name}: step ${step.op} does not start from an answer`);
    } catch (error) {
      if (!("error" in expected)) throw error;
      assert.ok(isDfoError(error) && error instanceof DfoError, String(error));
      assert.equal(error.name, expected.error.class, scenario.name);
      if (expected.error.code === null) assert.equal(error.problem, null, scenario.name);
      else assert.equal(error.code, expected.error.code, scenario.name);
      continue;
    }
    if (outcome instanceof Answer) {
      answer = outcome;
      assert.ok("answer" in expected, `${scenario.name}: step ${index} gave an answer`);
      const want = expected.answer;
      const got = summarise(outcome);
      assert.deepEqual(
        want.status === undefined ? { ...got, status: undefined } : got,
        { ...want, status: want.status },
        `${scenario.name}: step ${index}`,
      );
      continue;
    }
    // The fake builder answered: the build's own outcome is the fetch module's to replay.
    assert.equal(outcome, dataset);
    if ("dataset" in expected) {
      const [build] = built;
      assert.ok(build);
      assert.deepEqual(
        build.members.map((member) => ({
          parts: member.parts,
          spec_id: member.spec.spec_id,
          sentence: member.sentence,
        })),
        expected.dataset.members.map(({ parts, spec_id, sentence }) => ({
          parts,
          spec_id,
          sentence,
        })),
        scenario.name,
      );
      assert.deepEqual(
        build.options.missing.map((gap) => ({ part: gap.partIndex, kind: gap.kind })),
        expected.dataset.missing,
        scenario.name,
      );
    }
  }
  for (const exchange of remaining()) {
    assert.notEqual(
      exchange.request.path,
      "/search/resolve",
      `${scenario.name}: a Search exchange was never requested`,
    );
  }
  return { built, warnings };
}

describe("scenarios that start with a search", () => {
  test("cover search, choose and fetch", () => {
    const ops = new Set(searchScenarios.flatMap((scenario) => scenario.call.map((s) => s.op)));
    assert.deepEqual([...ops].toSorted(), ["choose", "fetch", "search"]);
  });

  for (const scenario of searchScenarios) {
    test(scenario.name, async () => {
      const { built } = await replay(scenario);
      const builds = scenario.exchanges.some((exchange) => exchange.request.path === "/datasets");
      assert.equal(built.length, builds ? 1 : 0, `${scenario.name}: fetchMembers calls`);
    });
  }
});
