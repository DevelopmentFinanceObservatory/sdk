// `StoredVersions`, its saved form, and the spec ids and answers of a check, beyond what the
// contract's `stored-versions-*` scenarios replay.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";
import { parquetWriteBuffer } from "hyparquet-writer";

import { ContractError, InvalidRequestError } from "../src/core/errors.ts";
import { DatasetRef, FormatError } from "../src/core/ref.ts";
import type { Spec } from "../src/core/ref.ts";
import { Dataset } from "../src/datasets/dataset.ts";
import { recipe, recipeOverTree } from "../src/datasets/recipe.ts";
import { readHeads, specIds, StoredVersions } from "../src/datasets/stored-versions.ts";
import { contractJson } from "./support.ts";

const A = `spec_${"a".repeat(32)}`;
const B = `spec_${"b".repeat(32)}`;
const C = `spec_${"c".repeat(32)}`;
const V1 = `cv_${"1".repeat(32)}`;
const V2 = `cv_${"2".repeat(32)}`;
const OPS = `ops_${"a".repeat(32)}`;

/** The text both clients write for `{A: V1, B: null}`, byte for byte; the Python test pins the
 *  same string. */
const SAVED_TEXT =
  '{"format_version":1,"heads":[' +
  '{"spec_id":"spec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",' +
  '"content_version":"cv_11111111111111111111111111111111"},' +
  '{"spec_id":"spec_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","content_version":null}]}';

/** The 32-hex spec id of `index`. */
const numbered = (index: number): string => `spec_${index.toString(16).padStart(32, "0")}`;

const spec = (specId: string): Spec => ({
  spec_id: specId,
  definition: { schema_version: 1, spec_id: specId },
});

/** A check holding `heads`, as a saved one reads back. */
const check = (heads: Record<string, string | null>): StoredVersions =>
  StoredVersions.fromJSON({
    format_version: 1,
    heads: Object.entries(heads).map(([spec_id, content_version]) => ({
      spec_id,
      content_version,
    })),
  });

const exampleRef = async (name: string): Promise<DatasetRef> =>
  DatasetRef.fromJSON((await contractJson<{ ref: unknown }>(`refs/${name}.json`)).ref);

test("toJSON writes the saved form sorted, and fromJSON reads it back", async () => {
  const found = check({ [B]: null, [A]: V1 });
  const ajv = new Ajv2020({ strict: false });
  const validate = ajv.compile(await contractJson<object>("stored-versions.schema.json"));
  assert.ok(validate(found.toJSON()), JSON.stringify(validate.errors));
  assert.deepEqual(
    found.toJSON().heads.map((head) => head.spec_id),
    [A, B],
  );
  assert.ok(StoredVersions.fromJSON(JSON.stringify(found)).equals(found));
  assert.equal(String(found), "StoredVersions(2 specs, 1 with a stored version)");
});

test("JSON.stringify writes the text both clients write", () => {
  assert.equal(JSON.stringify(check({ [B]: null, [A]: V1 })), SAVED_TEXT);
});

describe("changedSince names each spec whose head differs", () => {
  const now = check({ [A]: V1, [B]: null });
  const cases: [string, Record<string, string | null>, string[]][] = [
    ["same", { [A]: V1, [B]: null }, []],
    ["other version", { [A]: V2, [B]: null }, [A]],
    ["was null", { [A]: null, [B]: null }, [A]],
    ["now null", { [A]: V1, [B]: V2 }, [B]],
    ["not listed", { [A]: V1 }, [B]],
    ["extra", { [A]: V1, [B]: null, [C]: V1 }, []],
  ];
  for (const [name, built, changed] of cases) {
    test(name, () => {
      assert.deepEqual(now.changedSince(check(built)), changed);
    });
  }
  test("saved text is refused", () => {
    assert.throws(
      () => now.changedSince(JSON.stringify(now) as unknown as StoredVersions),
      (error) =>
        error instanceof InvalidRequestError &&
        error.code === "invalid_argument" &&
        /fromJSON/.test(error.message),
    );
  });
});

describe("fromJSON refuses a record that breaks the format", () => {
  const saved = (changes: Record<string, unknown>) => ({
    format_version: 1,
    heads: [
      { spec_id: A, content_version: V1 },
      { spec_id: B, content_version: null },
    ],
    ...changes,
  });
  const cases: [Record<string, unknown>, string][] = [
    [saved({ format_version: 2 }), "/format_version"],
    [saved({ heads: [] }), "/heads"],
    [saved({ extra: 1 }), "/extra"],
    [saved({ heads: [{ spec_id: A }] }), "/heads/0/content_version"],
    [saved({ heads: [{ spec_id: A, content_version: V1, x: 1 }] }), "/heads/0/x"],
    [
      saved({ heads: [{ spec_id: `ops_${"a".repeat(32)}`, content_version: null }] }),
      "/heads/0/spec_id",
    ],
    [
      saved({ heads: [{ spec_id: A, content_version: `ocv_${"1".repeat(32)}` }] }),
      "/heads/0/content_version",
    ],
    [
      saved({
        heads: [
          { spec_id: A, content_version: V1 },
          { spec_id: A, content_version: V2 },
        ],
      }),
      "/heads/1/spec_id",
    ],
  ];
  for (const [record, pointer] of cases) {
    test(pointer, () => {
      assert.throws(
        () => StoredVersions.fromJSON(JSON.stringify(record)),
        (error) =>
          error instanceof FormatError &&
          error.code === "format_invalid" &&
          error.pointer === pointer,
      );
    });
  }
});

test("specIds reads each spec once, sorted", () => {
  const chain = recipe(spec(C)).shareOf(spec(A), { by: "origin" });
  assert.deepEqual(specIds([spec(B), chain, spec(A)]), [A, B, C]);
});

test("a recipe of several readings reads each member", async () => {
  const members = [
    (await exampleRef("ref-one-member")).members[0]!,
    (await exampleRef("ref-answer-member")).members[0]!,
  ];
  const ref = new DatasetRef(members);
  const asked = specIds([recipe(ref).rank({ by: "origin", limit: 5 })]);
  assert.deepEqual(asked, members.map((member) => member.spec.spec_id).sort());
  assert.equal(asked.length, 2);
});

test("a Dataset names the specs its ref names", async () => {
  const bytes = await readFile(new URL("data/saved-typescript.parquet", import.meta.url));
  const data = await Dataset.fromBytes(new Uint8Array(bytes));
  const expected = [
    "spec_7a02b6facd2dc17b5d0d7c35c11bf5d2",
    "spec_b5673e60c045b10f8beeed2ce50dbd18",
  ];
  assert.deepEqual(specIds([data]), expected);
  assert.deepEqual(specIds([data.ref]), expected);
});

test("a Dataset that names no version is refused", async () => {
  const { metadata } = await contractJson<{ metadata: Record<string, string> }>(
    "saved-files/saved-minimal.json",
  );
  const bytes = parquetWriteBuffer({
    columnData: [{ name: "value", data: [] }],
    schema: [
      { name: "root", num_children: 1 },
      { name: "value", type: "INT64", repetition_type: "OPTIONAL" },
    ],
    kvMetadata: Object.entries(metadata).map(([key, value]) => ({ key, value })),
  });
  const data = await Dataset.fromBytes(new Uint8Array(bytes));
  assert.throws(
    () => specIds([data]),
    (error) => error instanceof InvalidRequestError && error.code === "ref_unavailable",
  );
});

test("a derived member names its roots", async () => {
  assert.deepEqual(specIds([await exampleRef("ref-derived-member")]), [
    "spec_cb5baa4161de718f18583060674dbca6",
  ]);
});

test("a check names 64 specs and refuses 65", () => {
  const specs = Array.from({ length: 65 }, (_, index) => spec(numbered(index)));
  assert.equal(specIds(specs.slice(0, 64)).length, 64);
  assert.throws(
    () => specIds(specs),
    (error) => error instanceof InvalidRequestError && error.code === "invalid_argument",
  );
});

describe("a target that names no spec id is refused", () => {
  const cases: [string, unknown][] = [
    ["spec, bad id", spec("spec_A")],
    ["spec, ops id", spec(OPS)],
    ["recipe, bad id", recipe(spec("spec_A")).aggregate()],
    ["root, null id", recipeOverTree({ spec_id: null })],
    ["root, no id", recipeOverTree({ rendering: {} })],
  ];
  for (const [name, target] of cases) {
    test(name, () => {
      assert.throws(
        () => specIds([target]),
        (error) =>
          error instanceof InvalidRequestError &&
          error.code === "invalid_argument" &&
          !/undefined/.test(error.message),
      );
    });
  }
});

describe("specIds refuses what is not an array of targets", () => {
  const cases: [string, unknown][] = [
    ["one target", spec(A)],
    ["text", A],
    ["an id", [A]],
    ["null", [null]],
  ];
  for (const [name, targets] of cases) {
    test(name, () => {
      assert.throws(
        () => specIds(targets),
        (error) => error instanceof InvalidRequestError && error.code === "invalid_argument",
      );
    });
  }
});

describe("readHeads refuses an answer it cannot read", () => {
  const cases: [string, unknown, string][] = [
    ["not an object", [], ""],
    ["not a list", { heads: {} }, "/heads"],
    ["not an entry", { heads: ["x"] }, "/heads/0"],
    [
      "spec id not a string",
      { heads: [{ spec_id: 1, content_version: null }] },
      "/heads/0/spec_id",
    ],
    ["not asked", { heads: [{ spec_id: C, content_version: null }] }, "/heads/0/spec_id"],
    [
      "repeated",
      {
        heads: [
          { spec_id: A, content_version: null },
          { spec_id: A, content_version: null },
        ],
      },
      "/heads/1/spec_id",
    ],
    ["no version", { heads: [{ spec_id: A }] }, "/heads/0/content_version"],
    ["bad version", { heads: [{ spec_id: A, content_version: 1 }] }, "/heads/0/content_version"],
    ["missing spec", { heads: [{ spec_id: A, content_version: V1 }] }, "/heads"],
  ];
  for (const [name, body, pointer] of cases) {
    test(name, () => {
      assert.throws(
        () => readHeads(body, [A, B], "trace"),
        (error) =>
          error instanceof ContractError &&
          error.code === "contract_violation" &&
          error.pointer === pointer &&
          error.traceId === "trace",
      );
    });
  }
});

test("readHeads reads entries in any order and ignores added members", () => {
  const body = {
    heads: [
      { spec_id: B, content_version: null, added: 1 },
      { spec_id: A, content_version: V1 },
    ],
    added: true,
  };
  assert.ok(readHeads(body, [A, B], null).equals(check({ [A]: V1, [B]: null })));
});
