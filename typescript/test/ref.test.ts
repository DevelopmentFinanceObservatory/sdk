import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { describe, test } from "node:test";

import { DatasetRef, FormatError, renderingFor, renderingMatches } from "../src/core/ref.ts";
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

  test("holds a frozen copy of the value it loads", async () => {
    const { ref } = await contractJson<{ ref: { members: Record<string, unknown>[] } }>(
      "refs/ref-one-member.json",
    );
    const stored = structuredClone(ref);
    const loaded = DatasetRef.fromJSON(stored);
    const written = JSON.stringify(loaded);
    const spec = stored.members[0]!["spec"] as {
      definition: { identity: Record<string, unknown> };
    };
    spec.definition.identity["entities"] = { origin: ["country/XXX"] };
    assert.equal(JSON.stringify(loaded), written);
    const [member] = loaded.members;
    assert.ok(member);
    const definition = member.spec.definition as { identity: Record<string, unknown> };
    assert.throws(() => {
      definition.identity["entities"] = {};
    }, TypeError);
    assert.throws(() => {
      (member.spec as { spec_id: string }).spec_id = "spec_x";
    }, TypeError);
    assert.equal(JSON.stringify(loaded), written);
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
      [["artifact", "rendering", "without_party_totals"], false],
      [["artifact", "rendering", "without_party_totals"], "true"],
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

describe("a party-totals cut in a ref", () => {
  test("is written only when true, so a plain recorded ref stays byte-identical", async () => {
    const { ref } = await contractJson<{ ref: { members: Record<string, unknown>[] } }>(
      "refs/ref-one-member.json",
    );
    const plain = DatasetRef.fromJSON(JSON.stringify(ref));
    assert.equal(JSON.stringify(plain), JSON.stringify(ref));
    assert.ok(!("without_party_totals" in plain.members[0]!.rendering));
    assert.ok(!("without_party_totals" in renderingFor("long")));

    const cut = structuredClone(ref);
    const artifact = cut.members[0]!["artifact"] as { rendering: Record<string, unknown> };
    artifact.rendering["without_party_totals"] = true;
    const loaded = DatasetRef.fromJSON(JSON.stringify(cut));
    assert.equal(loaded.members[0]!.rendering.without_party_totals, true);
    assert.equal(JSON.stringify(loaded), JSON.stringify(cut));
  });

  test("tells a cut artifact from a plain one both ways", () => {
    const plain = renderingFor("long");
    const cut = renderingFor("long", true);
    const served = { format: "parquet", bundle: false, layout: 4 };
    // Each row gives a rendering, a manifest artifact's rendering object, and whether they match.
    for (const [rendering, object, matches] of [
      [plain, served, true],
      [plain, { ...served, without_party_totals: true }, false],
      [plain, { ...served, without_party_totals: false }, true],
      [cut, served, false],
      [cut, { ...served, without_party_totals: true }, true],
      [
        renderingFor("frame", true),
        { ...served, layout: "frame", without_party_totals: true },
        true,
      ],
    ] as const) {
      assert.equal(
        renderingMatches(rendering, object),
        matches,
        JSON.stringify([rendering, object]),
      );
    }
  });
});
