// The answer format: `answer.toJSON()` and `Answer.fromJSON`. The fixture under test/data is
// the format the Python client reads and writes too.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

import { Answer } from "../src/search/answer.ts";
import { answerJson } from "../src/search/answer-json.ts";
import { clientOver } from "../src/client.ts";
import { FormatError } from "../src/core/ref.ts";
import { IncompleteAnswerError } from "../src/core/errors.ts";
import { replay, scenario, stepOf } from "./replay.ts";
import type { Scenario } from "./replay.ts";

const FIXTURE = "answer-choose-candidate-two-parts.json";
const fixture = await readFile(new URL(`data/${FIXTURE}`, import.meta.url), "utf8");
const record = await scenario("choose-candidate-two-parts");

/** A client that answers from the scenario's exchanges from `from` on. */
const clientFrom = (from: number, of: Scenario = record) => {
  const replayed = replay({ ...of, exchanges: of.exchanges.slice(from) });
  return { client: clientOver(replayed.transport), remaining: replayed.remaining };
};

/** The scenario's answer, read from its recorded Search response. */
async function searched(): Promise<Answer> {
  const { client } = clientFrom(0, { ...record, exchanges: record.exchanges.slice(0, 1) });
  return client.search(stepOf(record, 0, "search").question);
}

describe("the answer format", () => {
  test(`the recorded answer writes ${FIXTURE}, and the fixture reads back to itself`, async () => {
    const answer = await searched();
    assert.deepEqual(JSON.parse(JSON.stringify(answer)), JSON.parse(fixture));
    const { client } = clientFrom(1);
    assert.deepEqual(Answer.fromJSON(fixture, client).toJSON(), JSON.parse(fixture));
  });

  test("a revived fixture chooses and fetches as the recorded answer does", async () => {
    const { client, remaining } = clientFrom(1);
    const revived = Answer.fromJSON(JSON.parse(fixture), client);
    const step = stepOf(record, 1, "choose");
    const chosen = await revived.choose(step.option, { part: step.part! });
    const dataset = await chosen.fetch();
    assert.deepEqual(remaining(), []);
    const expected = record.expect[2]!;
    assert.ok("dataset" in expected);
    assert.deepEqual(
      dataset.members.map((member) => member.contentVersion),
      expected.dataset.members.map((member) => member.content_version),
    );
  });

  test("a revived answer keeps its question, sentence, gaps and trace id", async () => {
    const answer = await searched();
    const revived = Answer.fromJSON(JSON.stringify(answer), clientFrom(1).client);
    assert.equal(revived.question, answer.question);
    assert.equal(revived.sentence, answer.sentence);
    assert.equal(String(revived), String(answer));
    const read = (held: Answer) =>
      held.gaps.map(({ partIndex, kind, message, options }) => ({
        partIndex,
        kind,
        message,
        options: options.map((option) =>
          option.kind === "candidate" ? { ...option, spec: option.spec.spec_id } : option,
        ),
      }));
    assert.deepEqual(read(revived), read(answer));
    assert.ok(answer.traceId !== null);
    assert.equal(revived.traceId, answer.traceId);
    await assert.rejects(revived.fetch(), (error: unknown) => {
      assert.ok(error instanceof IncompleteAnswerError);
      assert.equal(error.traceId, answer.traceId);
      return true;
    });
  });

  const parsed = (): Record<string, unknown> => JSON.parse(fixture) as Record<string, unknown>;
  const refusals: [string, () => unknown, string][] = [
    ["text that is not JSON", () => "{", ""],
    ["a value that is not an object", () => [parsed()], ""],
    ["a missing member", () => ({ ...parsed(), question: undefined }), "/question"],
    ["a member the format does not name", () => ({ ...parsed(), extra: 1 }), "/extra"],
    ["another format version", () => ({ ...parsed(), format_version: 2 }), "/format_version"],
    ["a question that is not a string", () => ({ ...parsed(), question: 5 }), "/question"],
    ["an answer that is not an object", () => ({ ...parsed(), answer: [] }), "/answer"],
  ];
  for (const [name, value, pointer] of refusals) {
    test(`refuses ${name} as format_invalid`, () => {
      const given = value();
      const json = typeof given === "string" ? given : JSON.stringify(given);
      assert.throws(
        () => Answer.fromJSON(json, clientFrom(1).client),
        (error: unknown) => {
          assert.ok(error instanceof FormatError);
          assert.equal(error.reason, "format_invalid");
          assert.equal(error.pointer, pointer);
          return true;
        },
      );
    });
  }

  test("checks the body as a fresh Search response, with its trace id", () => {
    const value = parsed();
    const body = value["answer"] as { parts: Record<string, unknown>[]; trace_id: string };
    delete body.parts[1]!["status"];
    assert.throws(() => Answer.fromJSON(value, clientFrom(1).client), {
      name: "ContractError",
      code: "contract_violation",
      pointer: "/parts/1/status",
      traceId: body.trace_id,
    });
  });

  test("reads a trace id that is not an HTTP token as none", async () => {
    const value = parsed();
    (value["answer"] as Record<string, unknown>)["trace_id"] = "x\u001b[31mRED\nINJECTED line";
    const revived = Answer.fromJSON(value, clientFrom(1).client);
    assert.equal(revived.traceId, null);
    await assert.rejects(revived.fetch(), (error: unknown) => {
      assert.ok(error instanceof IncompleteAnswerError);
      assert.equal(error.traceId, null);
      assert.match(error.message, /\n\[answer_incomplete\]$/);
      return true;
    });
  });

  test("drops members named after Object.prototype's properties", () => {
    const body = JSON.parse(
      '{"kind":"resolution","constructor":{"a":1},"toString":"x","hasOwnProperty":2,' +
        '"__proto__":{"b":1},"secret":1}',
    ) as Record<string, unknown>;
    const { answer } = answerJson(null, body, null);
    assert.deepEqual(answer, { kind: "resolution" });
    assert.equal(Object.getPrototypeOf(answer), Object.prototype);
  });

  test("refuses a client that is not a Client", () => {
    assert.throws(() => Answer.fromJSON(fixture, {} as never), {
      name: "InvalidRequestError",
      code: "invalid_argument",
    });
  });
});
