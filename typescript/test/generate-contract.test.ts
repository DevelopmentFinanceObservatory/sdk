import assert from "node:assert/strict";
import { test } from "node:test";

import {
  renderFileSelector,
  renderReadingOrder,
  renderRoleKeys,
} from "../scripts/generate-contract.ts";

const rule = (slots: unknown, overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    format_version: 1,
    rule: "reading-order",
    reading_columns: slots,
    ...overrides,
  });

test("the reading columns come out as the rule's slots", () => {
  assert.deepEqual(renderReadingOrder(rule([["a"], ["b_label", "b"]])), {
    READING_COLUMNS: [["a"], ["b_label", "b"]],
  });
});

for (const [name, text] of [
  ["a wrong format version", rule([["a"]], { format_version: 2 })],
  ["a wrong rule name", rule([["a"]], { rule: "column-order" })],
  ["no slot", rule([])],
  ["an empty slot", rule([[]])],
  ["a slot that holds a non-name", rule([["a", 1]])],
  ["a name in two slots", rule([["a"], ["b", "a"]])],
  ["a name twice in a slot", rule([["a", "a"]])],
  ["stat_var in a slot", rule([["a"], ["stat_var"]])],
  ["part in a slot", rule([["part"], ["a"]])],
] as const) {
  test(`the reading-order rule with ${name} is refused`, () => {
    assert.throws(() => renderReadingOrder(text));
  });
}

const roleRule = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    format_version: 1,
    rule: "role-keys",
    keys: { place: "observationAbout", origin: "origin", destination: "destination" },
    flow_keys: ["origin", "destination"],
    ...overrides,
  });

test("the role keys come out as the rule's keys and flow keys", () => {
  assert.deepEqual(renderRoleKeys(roleRule()), {
    ROLE_KEYS: { place: "observationAbout", origin: "origin", destination: "destination" },
    FLOW_KEYS: ["origin", "destination"],
  });
});

for (const [name, text] of [
  ["a wrong format version", roleRule({ format_version: 2 })],
  ["a wrong rule name", roleRule({ rule: "reading-order" })],
  ["no keys", roleRule({ keys: {} })],
  ["keys as a list", roleRule({ keys: ["place"] })],
  ["a key mapped to an empty wire role", roleRule({ keys: { place: "", origin: "origin" } })],
  ["two keys mapped to one wire role", roleRule({ keys: { place: "origin", origin: "origin" } })],
  ["no flow keys", roleRule({ flow_keys: [] })],
  ["a flow key twice", roleRule({ flow_keys: ["origin", "origin"] })],
  ["a flow key that is no caller key", roleRule({ flow_keys: ["origin", "recipient"] })],
  ["a flow key posted as another role", roleRule({ flow_keys: ["place"] })],
] as const) {
  test(`the role-keys rule with ${name} is refused`, () => {
    assert.throws(() => renderRoleKeys(text));
  });
}

const selectorRule = (keys: unknown, overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({ format_version: 1, rule: "file-selector", query_keys: keys, ...overrides });

test("the file selector's keys come out as the rule's query keys", () => {
  assert.deepEqual(renderFileSelector(selectorRule(["format", "bundle"])), {
    SELECTOR_QUERY_KEYS: ["format", "bundle"],
  });
});

for (const [name, text] of [
  ["a wrong format version", selectorRule(["format"], { format_version: 2 })],
  ["a wrong rule name", selectorRule(["format"], { rule: "role-keys" })],
  ["no key", selectorRule([])],
  ["keys as a string", selectorRule("format")],
  ["an empty key", selectorRule(["format", ""])],
  ["a key that is no name", selectorRule(["format", 1])],
  ["a key twice", selectorRule(["format", "format"])],
] as const) {
  test(`the file-selector rule with ${name} is refused`, () => {
    assert.throws(() => renderFileSelector(text));
  });
}
