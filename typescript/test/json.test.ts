// The client's own bound on JSON nesting, independent of the call stack.
import assert from "node:assert/strict";
import { test } from "node:test";

import { JSON_MAX_DEPTH, parseJson } from "../src/core/json.ts";

const AT = JSON_MAX_DEPTH;
const PAST = JSON_MAX_DEPTH + 1;

for (const [name, text] of [
  ["an array at the bound", "[".repeat(AT) + "]".repeat(AT)],
  ["an object at the bound", '{"a":'.repeat(AT - 1) + "{}" + "}".repeat(AT - 1)],
  ["brackets in a string", `["${"[".repeat(PAST)}"]`],
  ["brackets after an escaped quote", `["\\"${"{".repeat(PAST)}"]`],
] as const) {
  test(`parse ${name}`, () => {
    parseJson(text);
  });
}

for (const [name, text] of [
  ["an array", "[".repeat(PAST) + "]".repeat(PAST)],
  ["an object", '{"a":'.repeat(AT) + "{}" + "}".repeat(AT)],
] as const) {
  test(`refuse ${name} one level past the bound`, () => {
    assert.throws(() => parseJson(text), SyntaxError);
  });
}
