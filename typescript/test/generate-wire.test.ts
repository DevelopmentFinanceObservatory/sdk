import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { renderWire } from "../scripts/generate-wire.ts";

const DOCUMENT = fileURLToPath(new URL("../../contract/served/openapi.json", import.meta.url));

/** The served document's wire types with `extra` schemas added beside its own. */
async function renderWith(extra: Record<string, unknown>): Promise<string> {
  const document = JSON.parse(await readFile(DOCUMENT, "utf8")) as {
    components: { schemas: Record<string, unknown> };
  };
  Object.assign(document.components.schemas, extra);
  return renderWire(JSON.stringify(document));
}

const probe = (properties: Record<string, unknown>): Record<string, unknown> => ({
  type: "object",
  required: Object.keys(properties),
  properties,
});

test("an integer enum is typed as its closed literal union and a string enum stays open", async () => {
  const source = await renderWith({
    VersionedProbe: probe({
      format_version: { type: "integer", enum: [1, 2] },
      layout: { type: "string", enum: ["long", "frame"] },
    }),
  });
  const members = /VersionedProbe: \{([\s\S]*?)\n\s*\};/.exec(source)?.[1] ?? "";
  assert.match(members, /format_version: 1 \| 2;/);
  assert.match(members, /layout: \("long" \| "frame"\) \| \(string & \{\}\);/);
});

test("a schema named with a leading underscore takes the alias prefix Field", async () => {
  const source = await renderWith({
    AliasProbe: probe({ a: { type: "string" } }),
    _AliasProbe: probe({ b: { type: "string" } }),
  });
  assert.match(source, /export type AliasProbe = components\["schemas"\]\["AliasProbe"\];/);
  assert.match(source, /export type FieldAliasProbe = components\["schemas"\]\["_AliasProbe"\];/);
});
