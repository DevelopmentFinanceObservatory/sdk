// Recipes: the tree each step sends, the roots it starts from, and the arguments it refuses
// before any request. The rows mirror python/tests/datasets/test_recipe.py.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";

import { Dataset } from "../src/datasets/dataset.ts";
import type { FetchedMember } from "../src/datasets/dataset.ts";
import { Recipe, recipe } from "../src/datasets/recipe.ts";
import { LatestYear, latestYear } from "../src/core/periods.ts";
import { DatasetRef, isDerived } from "../src/core/ref.ts";
import type { Rendering, Spec } from "../src/core/ref.ts";
import { scenarioBytes } from "./replay.ts";
import { recordedJson } from "./support.ts";

const AID: Spec = { spec_id: `spec_${"a".repeat(32)}`, definition: {} };
const POPULATION: Spec = { spec_id: `spec_${"b".repeat(32)}`, definition: {} };
const SPEC_ROOT = { spec_id: AID.spec_id, rendering: { without_party_totals: true } };
const OTHER_ROOT = { spec_id: POPULATION.spec_id, rendering: { without_party_totals: true } };

type Tree = { verb: string; arguments: unknown; inputs: Record<string, unknown> };

function step(chain: Recipe): Tree {
  const tree = chain.tree() as Tree;
  assert.deepEqual(tree.inputs["data"], SPEC_ROOT);
  return tree;
}

async function versions(...renderings: Rendering[]): Promise<Dataset> {
  const data = await scenarioBytes("fetch-ref.parquet");
  const digest = `sha256:${createHash("sha256").update(data).digest("hex")}`;
  const members = renderings.map((rendering, index): FetchedMember => {
    const specId = `spec_${String(index).repeat(32)}`;
    return {
      parts: [`part ${index}`],
      spec: { spec_id: specId, definition: { schema_version: 1, spec_id: specId, identity: {} } },
      sentence: "A sentence.",
      contentVersion: `cv_${String(index).repeat(32)}`,
      manifest: {},
      digest,
      rendering,
      data,
    };
  });
  return Dataset.create(members, { layout: "long" });
}

const derivedRef = async (): Promise<DatasetRef> =>
  DatasetRef.fromJSON((await recordedJson<{ ref: unknown }>("analysis-rank-ready.json")).ref);

describe("a one-reading step", () => {
  for (const [name, build, verb, args] of [
    [
      "filter",
      (r: Recipe) => r.filter({ keep: { destination: ["country/KEN"], origin: "x" } }),
      "filter",
      {
        predicates: [
          { kind: "category_match", column: "destination", values: ["country/KEN"] },
          { kind: "category_match", column: "origin", values: ["x"] },
        ],
      },
    ],
    [
      "aggregate",
      (r: Recipe) => r.aggregate({ by: "origin" }),
      "aggregate",
      { group_by: ["origin"], aggregation: "sum" },
    ],
    [
      "aggregate-mean",
      (r: Recipe) => r.aggregate({ by: ["origin", "destination"], how: "mean" }),
      "aggregate",
      { group_by: ["origin", "destination"], aggregation: "mean" },
    ],
    [
      "growth-rolling",
      (r: Recipe) => r.growth({ by: "origin", window: [latestYear(-4), latestYear()] }),
      "growth",
      {
        window_start: { anchor: "latest", offset: -4 },
        window_end: { anchor: "latest", offset: 0 },
        entity_by: ["origin"],
        change: "relative",
      },
    ],
    [
      "growth-fixed",
      (r: Recipe) => r.growth({ window: [2015, 2020], change: "difference" }),
      "growth",
      { window_start: "2015", window_end: "2020", entity_by: [], change: "absolute" },
    ],
    ["rank", (r: Recipe) => r.rank({ by: "origin" }), "rank", { rank_by: ["origin"] }],
    [
      "rank-window",
      (r: Recipe) =>
        r.rank({ by: "origin", window: [latestYear(), latestYear()], how: "sum", limit: 10 }),
      "rank",
      {
        rank_by: ["origin"],
        window_start: { anchor: "latest", offset: 0 },
        window_end: { anchor: "latest", offset: 0 },
        aggregation: "sum",
        limit: 10,
      },
    ],
    [
      "share-of-by",
      (r: Recipe) => r.shareOf({ by: "origin" }),
      "share_of",
      { numerator_by: ["origin"] },
    ],
  ] as const) {
    test(`sends the engine's arguments (${name})`, () => {
      const tree = step(build(recipe(AID)));
      assert.deepEqual([tree.verb, tree.arguments], [verb, args]);
      assert.ok(!("other" in tree.inputs));
    });
  }
});

describe("a two-reading step", () => {
  for (const verb of ["quotientOf", "shareOf", "join", "sumOf", "compare"] as const) {
    for (const [name, on, sent] of [
      ["mapping", { destination: "place" }, { on: { destination: "place" } }],
      ["list", ["place"], { on: ["place"] }],
      ["one role", "place", { on: ["place"] }],
      ["none", undefined, {}],
    ] as const) {
      test(`${verb} sends on and the other reading (${name})`, () => {
        const options = on === undefined ? {} : { on };
        const tree = step(recipe(AID)[verb](POPULATION, options));
        const wire = verb.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
        assert.deepEqual([tree.verb, tree.arguments], [wire, sent]);
        assert.deepEqual(tree.inputs["other"], OTHER_ROOT);
      });
    }
  }

  test("shareOf a total keeps its by columns", () => {
    const tree = step(recipe(AID).shareOf(POPULATION, { by: "origin", on: ["place"] }));
    assert.deepEqual(tree.arguments, { numerator_by: ["origin"], on: ["place"] });
  });
});

test("a chain nests each step over the one before", () => {
  const chain = recipe(AID)
    .growth({ by: "origin", window: [latestYear(-4), latestYear()] })
    .rank({ by: "origin", limit: 10 });
  const tree = chain.tree() as Tree;
  const data = tree.inputs["data"] as Tree;
  assert.equal(tree.verb, "rank");
  assert.equal(data.verb, "growth");
  assert.deepEqual(data.inputs["data"], SPEC_ROOT);
  const other = recipe(POPULATION).aggregate({ by: "place" });
  const paired = recipe(AID)
    .quotientOf(other, { on: { destination: "place" } })
    .tree() as Tree;
  assert.deepEqual(paired.inputs["other"], other.tree());
  assert.equal(
    String(chain),
    `recipe(${AID.spec_id}).growth({ by: "origin", window: [latestYear(-4), latestYear()] })` +
      '.rank({ by: "origin", limit: 10 })',
  );
});

test("a recipe prints the chain as it was called", () => {
  const chain = recipe(AID)
    .quotientOf(POPULATION, { on: { destination: "place" } })
    .growth({ by: "destination", window: [latestYear(-1), latestYear()], change: "difference" });
  assert.equal(
    String(chain),
    `recipe(${AID.spec_id}).quotientOf(${POPULATION.spec_id}, { on: { destination: "place" } })` +
      '.growth({ by: "destination", window: [latestYear(-1), latestYear()], change: ' +
      '"difference" })',
  );
});

describe("a recipe starts from what a dataset or ref names", () => {
  test("a dataset version, in its party-totals cut", async () => {
    const dataset = await versions({ format: "parquet", bundle: false });
    const [member] = dataset.members;
    assert.ok(member);
    assert.deepEqual((recipe(dataset).rank({ by: "origin" }).tree() as Tree).inputs["data"], {
      spec_id: member.spec.spec_id,
      content_version: member.contentVersion,
      rendering: { without_party_totals: false },
    });
  });

  test("a derived ref, and alone its bare root", async () => {
    const ref = await derivedRef();
    const [member] = ref.members;
    assert.ok(member && isDerived(member));
    const root = { spec_id: member.spec.spec_id, content_version: member.contentVersion };
    assert.deepEqual((recipe(ref).rank({ by: "origin" }).tree() as Tree).inputs["data"], root);
    assert.deepEqual(recipe(ref).tree(), root);
  });

  test("several members, as the ref DFO refuses", async () => {
    const cut = { format: "parquet", bundle: false, without_party_totals: true } as const;
    const dataset = await versions(cut, cut);
    assert.deepEqual((recipe(dataset).rank({ by: "origin" }).tree() as Tree).inputs["data"], {
      ref: JSON.parse(JSON.stringify(dataset.ref)) as unknown,
    });
  });

  test("a recipe given as it is", () => {
    const chain = recipe(AID).rank({ by: "origin" });
    assert.equal(recipe(chain), chain);
  });
});

test("a recipe is immutable: each step is a new recipe and tree() a new object", () => {
  const start = recipe(AID);
  const ranked = start.rank({ by: "origin" });
  assert.notEqual(ranked, start);
  const tree = ranked.tree() as Tree;
  (tree.arguments as Record<string, unknown>)["rank_by"] = ["changed"];
  assert.deepEqual((ranked.tree() as Tree).arguments, { rank_by: ["origin"] });
  assert.ok(Object.isFrozen(ranked));
});

describe("a malformed step is refused when it is added", () => {
  /** Each row passes what a JavaScript caller could, outside the declared types. */
  const loose = (value: unknown): never => value as never;
  for (const [name, build] of [
    ["no step", () => recipe(AID).tree()],
    ["spec id alone", () => recipe(loose(`spec_${"a".repeat(32)}`))],
    ["keep empty", () => recipe(AID).filter({ keep: {} })],
    ["keep no values", () => recipe(AID).filter({ keep: { origin: [] } })],
    ["keep value not text", () => recipe(AID).filter({ keep: loose({ origin: [1] }) })],
    ["by empty", () => recipe(AID).rank({ by: [] })],
    ["limit zero", () => recipe(AID).rank({ by: "origin", limit: 0 })],
    ["limit past 1000", () => recipe(AID).rank({ by: "origin", limit: 1001 })],
    ["limit not an integer", () => recipe(AID).rank({ by: "origin", limit: 2.5 })],
    ["window one year", () => recipe(AID).growth({ window: loose([2020]) })],
    ["window not an integer", () => recipe(AID).growth({ window: [2020.5, 2024] })],
    ["window text", () => recipe(AID).growth({ window: loose(["2020", 2024]) })],
    [
      "growth change in the engine's words",
      () => recipe(AID).growth({ window: [2020, 2024], change: loose("absolute") }),
    ],
    [
      "growth change in the stat card's words",
      () => recipe(AID).growth({ window: [2020, 2024], change: loose("percent") }),
    ],
    ["share of nothing", () => recipe(AID).shareOf(loose(undefined))],
    ["share of by with on", () => recipe(AID).shareOf({ by: "origin", on: ["place"] })],
    ["on empty", () => recipe(AID).quotientOf(POPULATION, { on: {} })],
    ["other a spec id", () => recipe(AID).quotientOf(loose("spec_b"))],
    ["an unknown option", () => recipe(AID).rank(loose({ by: "origin", top: 3 }))],
    ["latestYear ahead", () => latestYear(1)],
    ["latestYear too far", () => latestYear(-10_000)],
    ["latestYear not an integer", () => latestYear(loose(true))],
  ] as const) {
    test(name, () => {
      assert.throws(build, { name: "InvalidRequestError", code: "invalid_argument" });
    });
  }
});

test("latestYear prints the call that makes it", () => {
  assert.deepEqual(
    [String(latestYear()), String(latestYear(-4))],
    ["latestYear()", "latestYear(-4)"],
  );
  assert.ok(latestYear(-4) instanceof LatestYear);
  assert.equal(latestYear(-4).offset, -4);
});

test("recipes that send the same tree are equal", () => {
  const chain = (by: string | string[], window: [number, number]): Recipe =>
    recipe(AID).growth({ by, window }).rank({ by: "origin" });
  assert.ok(chain("origin", [2020, 2024]).equals(chain(["origin"], [2020, 2024])));
  assert.ok(!chain("origin", [2020, 2024]).equals(chain("origin", [2019, 2024])));
  assert.notEqual(String(chain("origin", [2020, 2024])), String(chain("origin", [2019, 2024])));
  assert.ok(
    !recipe(AID)
      .rank({ by: "origin" })
      .equals(recipe(POPULATION).rank({ by: "origin" })),
  );
  assert.ok(!recipe(AID).rank({ by: "origin" }).equals({ spec_id: AID.spec_id }));
});
