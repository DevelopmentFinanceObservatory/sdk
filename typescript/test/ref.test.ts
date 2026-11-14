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

/** A stored ref with every rendering's cut spelled `without_party_totals: true`, as a client
 *  writes it whichever spelling it read. */
function cutWrittenOld(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cutWrittenOld);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value).map(([key, item]) => [key, cutWrittenOld(item)] as const);
  if (!Object.hasOwn(value, "party_totals")) return Object.fromEntries(entries);
  return {
    ...Object.fromEntries(entries.filter(([key]) => key !== "party_totals")),
    without_party_totals: true,
  };
}

describe("the contract's DatasetRef records", async () => {
  const all = await records();
  for (const record of all) {
    test(record.name, () => {
      if (record.expect === "accept") {
        const ref = DatasetRef.fromJSON(JSON.stringify(record.ref));
        // A loaded ref writes back the stored format exactly, definition included, with the
        // party-totals cut in the spelling clients older than 0.2.0 read.
        assert.equal(JSON.stringify(ref), JSON.stringify(cutWrittenOld(record.ref)));
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

  test("every spelling of the cut loads to one ref", () => {
    const named = (name: string) => {
      const record = all.find((each) => each.name === name);
      assert.ok(record, `the contract holds no ${name} record`);
      return DatasetRef.fromJSON(record.ref);
    };
    const old = named("ref-without-party-totals");
    for (const name of ["ref-party-totals", "ref-party-totals-both"]) {
      const ref = named(name);
      assert.ok(ref.equals(old), name);
      assert.ok(ref.sameData(old), name);
    }
  });
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
      [["artifact", "rendering", "party_totals"], true],
      [["artifact", "rendering", "party_totals"], "false"],
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
    assert.throws(() => new DatasetRef([datasetMember, derivedMember]), {
      name: "InvalidRequestError",
      code: "invalid_argument",
    });
  });

  test("compares its data with a ref alone", async () => {
    const ref = DatasetRef.fromJSON(await derived());
    // The ref's JSON in place of the ref, the mistake the check names.
    const stored: unknown = ref.toJSON();
    assert.throws(() => ref.sameData(stored as DatasetRef), {
      name: "InvalidRequestError",
      code: "invalid_argument",
    });
    assert.equal(ref.sameData(ref), true);
  });
});

const grouped = async (): Promise<{ members: Record<string, unknown>[] }> =>
  (
    await contractJson<{ ref: { members: Record<string, unknown>[] } }>(
      "refs/ref-derived-grouped-root.json",
    )
  ).ref;

describe("a grouped root", () => {
  test("keeps its groupby as a typed field", async () => {
    const [member] = DatasetRef.fromJSON(await grouped()).members;
    assert.ok(member && isDerived(member));
    const [root] = member.roots;
    assert.ok(root?.groupby);
    assert.deepEqual(JSON.parse(JSON.stringify(root.groupby)), {
      by: ["crsPurpose", "time_period"],
      op: "sum",
      levels: { crsPurpose: 0 },
    });
    assert.ok(Object.isFrozen(root.groupby.levels));
  });

  test("refuses a second root whose levels differ only in key order", async () => {
    const ref = structuredClone(await grouped());
    const roots = ref.members[0]!["roots"] as { rendering: { groupby: { levels: object } } }[];
    roots[0]!.rendering.groupby.levels = { crsPurpose: 0, time_period: 1 };
    const again = structuredClone(roots[0]!);
    again.rendering.groupby.levels = { time_period: 1, crsPurpose: 0 };
    roots.push(again);
    assert.throws(() => DatasetRef.fromJSON(ref), {
      reason: "format_invalid",
      pointer: "/members/0/roots/1",
    });
  });

  test("keeps a __proto__ level and writes a ref that loads again", async () => {
    const ref = structuredClone(await grouped());
    const roots = ref.members[0]!["roots"] as { rendering: { groupby: { levels: unknown } } }[];
    roots[0]!.rendering.groupby.levels = JSON.parse('{"__proto__": 1}');
    const loaded = DatasetRef.fromJSON(JSON.stringify(ref));
    const again = DatasetRef.fromJSON(JSON.stringify(loaded)).members[0];
    assert.ok(again && isDerived(again));
    assert.deepEqual(Object.keys(again.roots[0]!.groupby!.levels!), ["__proto__"]);
  });

  test("writes a hand-built groupby with empty levels without them", async () => {
    const [member] = DatasetRef.fromJSON(await grouped()).members;
    assert.ok(member && isDerived(member));
    const root = {
      ...member.roots[0]!,
      groupby: { by: ["time_period"], op: "sum" as const, levels: {} },
    };
    const written = new DatasetRef([{ ...member, roots: [root] }]);
    const [loaded] = DatasetRef.fromJSON(JSON.stringify(written)).members;
    assert.ok(loaded && isDerived(loaded));
    assert.deepEqual(loaded.roots[0]!.groupby, { by: ["time_period"], op: "sum" });
  });

  // Each row breaks one check of a root's groupby that no contract record pins.
  const cases: [path: string[], value: unknown][] = [
    [["by"], []],
    [["by"], [""]],
    [["by"], ["time_period", "time_period"]],
    [["levels"], {}],
    [["levels", "crsPurpose"], 100],
    [["levels", "crsPurpose"], true],
    [["axis"], "time_period"],
  ];
  for (const [path, value] of cases) {
    test(`refuses ${JSON.stringify(value)} at groupby/${path.join("/")}`, async () => {
      const broken = structuredClone(await grouped());
      const roots = broken.members[0]!["roots"] as { rendering: { groupby: unknown } }[];
      let holder = roots[0]!.rendering.groupby as Record<string, unknown>;
      for (const step of path.slice(0, -1)) holder = holder[step] as Record<string, unknown>;
      holder[path.at(-1)!] = value;
      assert.throws(() => DatasetRef.fromJSON(broken), {
        reason: "format_invalid",
        pointer: `/members/0/roots/0/rendering/groupby/${path.join("/")}`,
      });
    });
  }
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
