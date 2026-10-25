import assert from "node:assert/strict";
import { test } from "node:test";

import { renderColumnOrder } from "../scripts/generate-contract.ts";

const rule = (slots: unknown, overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    format_version: 1,
    rule: "column-order",
    reading_columns: slots,
    ...overrides,
  });

test("the reading columns come out as the rule's slots", () => {
  assert.deepEqual(renderColumnOrder(rule([["a"], ["b_label", "b"]])), {
    READING_COLUMNS: [["a"], ["b_label", "b"]],
  });
});

for (const [name, text] of [
  ["a wrong format version", rule([["a"]], { format_version: 2 })],
  ["a wrong rule name", rule([["a"]], { rule: "key-format" })],
  ["no slot", rule([])],
  ["an empty slot", rule([[]])],
  ["a slot that holds a non-name", rule([["a", 1]])],
  ["a name in two slots", rule([["a"], ["b", "a"]])],
  ["a name twice in a slot", rule([["a", "a"]])],
  ["stat_var in a slot", rule([["a"], ["stat_var"]])],
] as const) {
  test(`the column-order rule with ${name} is refused`, () => {
    assert.throws(() => renderColumnOrder(text));
  });
}
