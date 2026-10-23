import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { describe, test } from "node:test";

import { DatasetRef, FormatError } from "../src/core/ref.ts";
import { contractJson } from "./support.ts";

type RefRecord = {
  name: string;
  ref: unknown;
  expect?: "accept";
  error?: { by: "schema" } | { by: "rule"; reason: string };
};

const records = async (): Promise<RefRecord[]> => {
  const names = (await readdir(new URL("../../contract/refs/", import.meta.url))).filter((name) =>
    name.endsWith(".json"),
  );
  assert.ok(names.length > 0, "the contract holds no ref records");
  return Promise.all(names.map((name) => contractJson<RefRecord>(`refs/${name}`)));
};

describe("the contract's DatasetRef records", async () => {
  for (const record of await records()) {
    test(record.name, () => {
      if (record.expect === "accept") {
        const ref = DatasetRef.fromJSON(JSON.stringify(record.ref));
        // A loaded ref writes back the stored format exactly, definition included.
        assert.equal(JSON.stringify(ref), JSON.stringify(record.ref));
        return;
      }
      assert.throws(
        () => DatasetRef.fromJSON(record.ref),
        (error: unknown) => {
          assert.ok(error instanceof FormatError);
          const { error: expected } = record;
          assert.equal(error.reason, expected?.by === "rule" ? expected.reason : "format_invalid");
          return true;
        },
      );
    });
  }
});

describe("DatasetRef.fromJSON", () => {
  test("keeps a definition of another integer schema_version as stored", async () => {
    const { ref } = await contractJson<{ ref: { members: Record<string, unknown>[] } }>(
      "refs/ref-one-member.json",
    );
    const stored = structuredClone(ref);
    const spec = stored.members[0]!["spec"] as { definition: Record<string, unknown> };
    spec.definition["schema_version"] = 2;
    assert.equal(JSON.stringify(DatasetRef.fromJSON(stored)), JSON.stringify(stored));
  });

  test("refuses text that is not JSON with a pointer to the root", () => {
    assert.throws(() => DatasetRef.fromJSON("{"), { name: "FormatError", pointer: "" });
  });

  test("names the offending value by JSON Pointer", async () => {
    const { ref } = await contractJson<{ ref: { members: Record<string, unknown>[] } }>(
      "refs/ref-one-member.json",
    );
    const cases: [path: string[], value: unknown][] = [
      [["content_version"], "cv_short"],
      [["spec", "definition", "schema_version"], true],
      [["spec", "definition", "schema_version"], 1.5],
      [["spec", "definition", "sentence"], "a sentence"],
      [["spec", "definition", "identity"], "spec1"],
    ];
    for (const [path, value] of cases) {
      const broken = structuredClone(ref);
      const key = path.at(-1)!;
      let holder: Record<string, unknown> = broken.members[0]!;
      for (const step of path.slice(0, -1)) {
        holder = holder[step] as Record<string, unknown>;
      }
      holder[key] = value;
      assert.throws(() => DatasetRef.fromJSON(broken), {
        reason: "format_invalid",
        pointer: `/members/0/${path.join("/")}`,
      });
    }
  });
});
