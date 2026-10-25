import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";

import { clientOver } from "../src/client.ts";
import { DfoError, NotFoundError, serverCode } from "../src/core/errors.ts";
import { describing } from "../src/core/trace.ts";
import { DataWarning, DfoWarning } from "../src/core/warnings.ts";
import { Dataset } from "../src/datasets/dataset.ts";
import { RawResponse, Transport } from "../src/http/transport.ts";
import { answerFromBody, SearchWarning } from "../src/search/answer.ts";
import { NO_EXCHANGES, replay, scenarioBytes, scenarios } from "./replay.ts";

const SPEC_ID = `spec_${"3f1a".repeat(8)}`;
const VERSION = `cv_${"b92d".repeat(8)}`;

const dataset = new Dataset(
  [
    {
      parts: [],
      spec: { spec_id: SPEC_ID, definition: {} },
      sentence: "Germany's gross ODA disbursements to Nigeria.",
      contentVersion: VERSION,
      manifest: {},
      digest: "sha256:offline",
      rendering: { format: "parquet", bundle: false },
      data: await scenarioBytes("answer-definite-fetch.parquet"),
    },
  ],
  { layout: "long" },
);

const recorded = (await scenarios()).find(({ name }) => name === "answer-definite-fetch")!;
const answer = answerFromBody(
  structuredClone(recorded.exchanges[0]!.response.json),
  { transport: replay(NO_EXCHANGES).transport },
  null,
);

const lookup = clientOver(new Transport({ baseUrl: "https://api.example", apiKey: false })).lookup;

// Each row builds the object and gives what it prints: the whole text when `whole` is set, which
// holds at most two lines of at most 200 characters, else the start of the text.
const ROWS: [string, () => { toString(): string }, string, boolean][] = [
  ["answer", () => answer, String(answer).split("\n")[0]!, false],
  ["dataset", () => dataset, "<Dataset Germany's gross ODA disbursements to Nigeria.\n", false],
  ["dataset-ref", () => dataset.ref, `DatasetRef(1 member: ${SPEC_ID} at ${VERSION}, exact)`, true],
  ["lookup", () => lookup, "<Lookup: resolve(names), node(dcid), code(code), catalogue()>", true],
  [
    "raw-response",
    () =>
      new RawResponse(
        200,
        new Headers({ "content-type": "application/json" }),
        new Uint8Array([123, 125]),
      ),
    "RawResponse(200, application/json, 2 bytes)",
    true,
  ],
  [
    "raw-response-untyped",
    () => new RawResponse(204, new Headers(), new Uint8Array([0])),
    "RawResponse(204, 1 byte)",
    true,
  ],
];

for (const [name, build, expected, whole] of ROWS) {
  test(`${name} prints its summary in a template string and through util.inspect`, () => {
    const value = build();
    // What a template string prints.
    const text = value.toString();
    assert.equal(inspect(value), text);
    assert.ok(!text.includes("[object Object]"), text);
    if (!whole) {
      assert.ok(text.startsWith(expected), text);
      return;
    }
    assert.equal(text, expected);
    const lines = text.split("\n");
    assert.ok(lines.length <= 2 && lines.every((line) => line.length <= 200), text);
  });
}

// Each row gives an error or warning and the message it carries, the bracket at its end.
for (const [name, build, message] of [
  [
    "an error with a trace id",
    () =>
      new NotFoundError({
        code: serverCode("code_not_found"),
        detail: "No entry.",
        traceId: "4f2a",
      }),
    "No entry. [code_not_found · trace 4f2a]",
  ],
  [
    "an error with no trace id",
    () => new DfoError({ code: "invalid_argument", detail: "Bad window." }),
    "Bad window. [invalid_argument]",
  ],
  [
    "an error of several lines",
    () => new DfoError({ code: "invalid_argument", detail: "Bad window.\n  Use [2022, 2022]." }),
    "Bad window.\n  Use [2022, 2022].\n[invalid_argument]",
  ],
  [
    "an error that settles the trace id of the response it describes",
    () => {
      try {
        return describing("trace-9", () => {
          throw new DfoError({ code: "contract_violation", detail: "No members." });
        });
      } catch (error) {
        return error as DfoError;
      }
    },
    "No members. [contract_violation · trace trace-9]",
  ],
  [
    "a data warning, whose trace id stays out",
    () => new DataWarning("empty_result", "No rows.", "warn", "4f2a"),
    "No rows. [empty_result]",
  ],
  [
    "a search warning of several lines",
    () => new SearchWarning("closest_match", "Differs:\n  shows 2022"),
    "Differs:\n  shows 2022\n[closest_match]",
  ],
  ["a warning with no code", () => new DfoWarning(null, "Differs."), "Differs."],
  [
    "an error whose trace id holds terminal controls",
    () => new DfoError({ code: "invalid_argument", detail: "Bad.", traceId: "x\u001b[31mRED" }),
    "Bad. [invalid_argument · trace x[31mRED]",
  ],
  [
    "a warning whose code holds terminal controls",
    () => new DfoWarning("odd\u009b2J", "Differs."),
    "Differs. [odd2J]",
  ],
] as const) {
  test(`${name} ends its message with its code`, () => {
    const value = build();
    assert.equal(value.message, message);
    assert.equal(String(value), `${value.name}: ${message}`);
  });
}
