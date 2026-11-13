import assert from "node:assert/strict";
import { test } from "node:test";

import { trimEnd, trimTrailingSlashes, WHITESPACE } from "../src/core/text.ts";

test("trimTrailingSlashes drops every trailing slash and nothing else", () => {
  for (const [text, trimmed] of [
    ["", ""],
    ["/", ""],
    ["///", ""],
    ["/api/v1", "/api/v1"],
    ["/api/v1/", "/api/v1"],
    ["/api//v1///", "/api//v1"],
    ["//a", "//a"],
  ] as const) {
    assert.equal(trimTrailingSlashes(text), trimmed, JSON.stringify(text));
  }
});

test("trimTrailingSlashes takes linear time on a long run of slashes that does not end the text", () => {
  const text = `${"/".repeat(200_000)}x`;
  const start = performance.now();
  assert.equal(trimTrailingSlashes(text), text);
  assert.ok(performance.now() - start < 1000);
});

test("trimEnd strips only the trailing characters it is given", () => {
  for (const [text, chars, trimmed] of [
    ["", "=", ""],
    ["abc==", "=", "abc"],
    ["a=b==", "=", "a=b"],
    ["...", ".", ""],
    ["Done.. .", `.${WHITESPACE}`, "Done"],
    ["Done \u00a0\n\ufeff", `.${WHITESPACE}`, "Done"],
    ["a b", `.${WHITESPACE}`, "a b"],
    ["key = 1 \t ", " \t", "key = 1"],
    ["a \r", " \t", "a \r"],
  ] as const) {
    assert.equal(trimEnd(text, chars), trimmed, JSON.stringify([text, chars]));
  }
});

test("WHITESPACE holds exactly the characters a regular expression's \\s matches", () => {
  for (let code = 0; code < 0x10000; code += 1) {
    const char = String.fromCharCode(code);
    assert.equal(WHITESPACE.includes(char), /\s/.test(char), code.toString(16));
  }
});

test("trimEnd takes linear time on a long run that does not end the text", () => {
  const text = `${"=".repeat(200_000)}x`;
  const start = performance.now();
  assert.equal(trimEnd(text, "="), text);
  assert.ok(performance.now() - start < 1000);
});
