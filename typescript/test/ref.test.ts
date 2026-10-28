import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { describe, test } from "node:test";

import {
  DatasetRef,
  FormatError,
  isDerived,
  renderingFor,
  renderingMatches,
} from "../src/core/ref.ts";
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

/** The stored ref of the contract's one-member record. */
const oneMember = async (): Promise<{ members: Record<string, unknown>[] }> =>
  (await contractJson<{ ref: { members: Record<string, unknown>[] } }>("refs/ref-one-member.json"))
    .ref;

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
    const ref = await oneMember();
    const stored = structuredClone(ref);
    const spec = stored.members[0]!["spec"] as { definition: Record<string, unknown> };
    spec.definition["schema_version"] = 2;
    assert.equal(JSON.stringify(DatasetRef.fromJSON(stored)), JSON.stringify(stored));
  });

  test("holds a frozen copy of the value it loads", async () => {
    const ref = await oneMember();
    const stored = structuredClone(ref);
    const loaded = DatasetRef.fromJSON(stored);
    const written = JSON.stringify(loaded);
    const spec = stored.members[0]!["spec"] as {
      definition: { identity: Record<string, unknown> };
    };
    spec.definition.identity["entities"] = { origin: ["country/XXX"] };
    assert.equal(JSON.stringify(loaded), written);
    const [member] = loaded.members;
    assert.ok(member && !isDerived(member));
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
    const ref = await oneMember();
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

/** The stored ref of the contract's derived-member record. */
const derived = async (): Promise<{ members: Record<string, unknown>[] }> =>
  (
    await contractJson<{ ref: { members: Record<string, unknown>[] } }>(
      "refs/ref-derived-member.json",
    )
  ).ref;

describe("a derived ref", () => {
  // Each row breaks one check of a derived member that no contract record pins.
  const cases: [path: (string | number)[], value: unknown][] = [
    [["spec", "spec_id"], `spec_${"0".repeat(32)}`],
    [["spec", "recipe", "replay_key"], `rnf_${"0".repeat(32)}`],
    [["content_version"], `cv_${"0".repeat(32)}`],
    [["output_digest"], `sha256:${"0".repeat(64)}`],
    [["roots"], []],
    [["roots", 0, "content_version"], `ocv_${"0".repeat(32)}`],
    [["execution_identity"], "0.9.0|1.1.0"],
    [["resolved_periods", 0, "offset"], -1.5],
    [["resolved_periods", 0, "period"], "20x0"],
    [["resolved_periods", 1], { anchor: "latest", offset: -3, rule: "half1", period: "2020" }],
  ];
  for (const [path, value] of cases) {
    test(`refuses ${JSON.stringify(value)} at ${path.join("/")}`, async () => {
      const broken = structuredClone(await derived());
      let holder: Record<string | number, unknown> = broken.members[0]!;
      for (const step of path.slice(0, -1)) {
        holder = holder[step] as Record<string | number, unknown>;
      }
      holder[path.at(-1)!] = value;
      assert.throws(() => DatasetRef.fromJSON(broken), {
        reason: "format_invalid",
        pointer: `/members/0/${path.join("/")}`,
      });
    });
  }

  test("holds no dataset member beside a derived one", async () => {
    const [datasetMember] = DatasetRef.fromJSON(await oneMember()).members;
    const [derivedMember] = DatasetRef.fromJSON(await derived()).members;
    assert.ok(datasetMember && derivedMember && isDerived(derivedMember));
    assert.throws(() => new DatasetRef([datasetMember, derivedMember]), TypeError);
  });

  test("is not the same data as what is not a ref", async () => {
    const ref = DatasetRef.fromJSON(await derived());
    assert.equal(ref.sameData(ref.toJSON()), false);
    assert.equal(ref.sameData(ref), true);
  });
});

describe("a party-totals cut in a ref", () => {
  test("is written only when true, so a plain recorded ref stays byte-identical", async () => {
    const ref = await oneMember();
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

  // The contract matches an artifact on format, bundle and frame layout only, so the cut flag
  // on either side changes nothing and the layout still does.
  test("matches an artifact whatever party totals either side leaves out", () => {
    const plain = renderingFor("long");
    const cut = renderingFor("long", true);
    const served = { format: "parquet", bundle: false, layout: 4 };
    // Each row gives a rendering, a manifest artifact's rendering object, and whether they match.
    for (const [rendering, object, matches] of [
      [plain, served, true],
      [plain, { ...served, without_party_totals: true }, true],
      [plain, { ...served, without_party_totals: false }, true],
      [cut, served, true],
      [cut, { ...served, without_party_totals: true }, true],
      [cut, { ...served, layout: "frame", without_party_totals: true }, false],
      [
        renderingFor("frame", true),
        { ...served, layout: "frame", without_party_totals: true },
        true,
      ],
      [renderingFor("frame", true), { ...served, without_party_totals: true }, false],
    ] as const) {
      assert.equal(
        renderingMatches(rendering, object),
        matches,
        JSON.stringify([rendering, object]),
      );
    }
  });
});

describe("DatasetRef.equals", () => {
  const changed = (edit: (member: Record<string, unknown>) => void) => async () => {
    const stored = structuredClone(await oneMember());
    edit(stored.members[0]!);
    return DatasetRef.fromJSON(stored);
  };
  const artifact = (member: Record<string, unknown>) =>
    member["artifact"] as { digest: string; rendering: Record<string, unknown> };
  // Each row edits the stored member and says whether the ref still equals the original.
  for (const [name, edit, equal] of [
    ["another digest", (m) => (artifact(m).digest = `sha256:${"e".repeat(64)}`), true],
    ["another sentence", (m) => (m["sentence"] = "Another sentence."), true],
    ["other parts", (m) => (m["parts"] = ["another part"]), true],
    ["another version", (m) => (m["content_version"] = `cv_${"1".repeat(32)}`), false],
    ["a party-totals cut", (m) => (artifact(m).rendering["without_party_totals"] = true), false],
  ] as const satisfies readonly (readonly [
    string,
    (member: Record<string, unknown>) => void,
    boolean,
  ])[]) {
    test(`a ref with ${name} is ${equal ? "equal" : "unequal"}`, async () => {
      const original = DatasetRef.fromJSON(await oneMember());
      const other = await changed(edit)();
      assert.equal(original.equals(other), equal);
      assert.equal(other.equals(original), equal);
    });
  }

  test("is false for a ref of other members, and for what is not a ref", async () => {
    const original = DatasetRef.fromJSON(await oneMember());
    const [member] = original.members;
    assert.equal(original.equals(new DatasetRef([member!, member!])), false);
    assert.equal(original.equals(original.toJSON()), false);
    assert.equal(original.equals(undefined), false);
  });
});

describe("String(ref)", () => {
  test("names each spec at its exact version", async () => {
    const ref = DatasetRef.fromJSON(await oneMember());
    const [member] = ref.members;
    assert.equal(
      String(ref),
      `DatasetRef(1 member: ${member!.spec.spec_id} at ${member!.contentVersion}, exact)`,
    );
    assert.match(String(new DatasetRef([member!, member!])), /^DatasetRef\(2 members: /);
  });
});
