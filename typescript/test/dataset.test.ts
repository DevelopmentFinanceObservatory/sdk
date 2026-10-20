import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, test } from "node:test";

import { Dataset } from "../src/dataset.ts";
import type { FetchedMember } from "../src/dataset.ts";
import { scenarioBytes } from "./replay.ts";

const SCENARIOS = new URL("../../contract/scenarios/", import.meta.url);

const digestOf = (data: Uint8Array): string =>
  `sha256:${createHash("sha256").update(data).digest("hex")}`;

function member(
  data: Uint8Array,
  overrides: Partial<FetchedMember> & { manifest?: Record<string, unknown> } = {},
): FetchedMember {
  const specId = `spec_${"0".repeat(32)}`;
  return {
    parts: [],
    spec: { spec_id: specId, definition: { spec_id: specId } },
    sentence: "A sentence.",
    contentVersion: `cv_${"0".repeat(32)}`,
    manifest: {},
    digest: digestOf(data),
    rendering: { format: "parquet", bundle: false },
    data,
    ...overrides,
  };
}

const parquetFiles = async (): Promise<string[]> => {
  const names = (await readdir(SCENARIOS)).filter((name) => name.endsWith(".parquet"));
  assert.ok(names.length > 0, "the contract holds no Parquet bodies");
  return names;
};

describe("every scenario Parquet body decodes", async () => {
  for (const name of await parquetFiles()) {
    test(name, async () => {
      const dataset = new Dataset([member(await scenarioBytes(name))], { layout: "long" });
      const rows = await dataset.toRows();
      assert.equal(rows.length, dataset.rows);
      assert.ok(dataset.rows > 0);
      assert.deepEqual(Object.keys(rows[0]!), dataset.columns);
      // INT64 columns arrive as numbers, so the rows serialise as JSON.
      assert.equal(typeof rows[0]!["time_period"], "number");
      assert.deepEqual(JSON.parse(JSON.stringify(rows)), rows);

      const table = await dataset.toArrow();
      assert.equal(table.numRows, dataset.rows);
      assert.deepEqual(
        table.schema.fields.map((field) => field.name),
        dataset.columns,
      );
      assert.equal(String(table.getChild("time_period")?.type), "Int64");
      assert.equal(
        table.getChild("time_period")?.get(0),
        BigInt(rows[0]!["time_period"] as number),
      );
      assert.equal(table.getChild("value")?.get(0), rows[0]!["value"]);
      assert.equal(table.getChild("stat_var")?.get(0), rows[0]!["stat_var"]);
    });
  }
});

describe("Parquet types", () => {
  // Written by pyarrow 26: year int64, big int64 holding 2**60, small uint8, share float64,
  // flag bool, label string, stamp timestamp[us, UTC], day date32, amount decimal128(10, 2),
  // blob binary, nothing null; three rows with a null in the second.
  const types = async () =>
    new Dataset(
      [member(new Uint8Array(await readFile(new URL("data/types.parquet", import.meta.url))))],
      {
        layout: "long",
      },
    );

  test("toArrow keeps each type, every int64 bit and the timestamp's microseconds", async () => {
    const table = await (await types()).toArrow();
    const type = (name: string) => String(table.getChild(name)?.type);
    assert.equal(type("year"), "Int64");
    assert.equal(type("big"), "Int64");
    assert.equal(type("small"), "Uint8");
    assert.equal(type("share"), "Float64");
    assert.equal(type("flag"), "Bool");
    assert.equal(type("label"), "Utf8");
    assert.equal(type("stamp"), "Timestamp<MICROSECOND, UTC>");
    assert.equal(type("day"), "Date32<DAY>");
    assert.equal(type("amount"), "Float64");
    assert.equal(type("blob"), "Binary");
    assert.equal(type("nothing"), "Null");
    assert.equal(table.getChild("big")?.get(1), 2n ** 60n);
    assert.equal(table.getChild("year")?.get(1), null);
    assert.equal(table.getChild("year")?.nullCount, 1);
    const stamps: unknown = table.getChild("stamp")?.toArray();
    assert.ok(stamps instanceof BigInt64Array);
    assert.equal(stamps[0], BigInt(Date.UTC(2026, 9, 20, 12)) * 1000n + 123_456n);
    assert.equal(table.getChild("amount")?.get(0), 12.34);
    assert.deepEqual(table.getChild("blob")?.get(0), new Uint8Array([0, 1]));
  });

  test("toRows refuses an int64 beyond a number's exact range", async () => {
    await assert.rejects((await types()).toRows(), RangeError);
  });
});

describe("a dataset of several members", async () => {
  const health = await scenarioBytes("answer-several-readings-folded.parquet");
  const gdp = await scenarioBytes("answer-several-readings-folded-2.parquet");
  const dataset = new Dataset(
    [
      member(health, { parts: ["health ODA", "education ODA"], sentence: "Health." }),
      member(gdp, { sentence: "GDP.", spec: { spec_id: "spec_2", definition: {} } }),
    ],
    { layout: "long" },
  );

  test("stacks into one table with the part column first", async () => {
    const rows = await dataset.toRows();
    assert.equal(rows.length, dataset.rows);
    assert.equal(dataset.columns[0], "part");
    assert.equal(rows[0]!["part"], "health ODA; education ODA");
    // A member that answers no part is labelled with its sentence.
    assert.equal(rows.at(-1)!["part"], "GDP.");
    // A column only the second member has is null in the first member's rows.
    assert.equal(rows[0]!["observationAbout"], null);
    assert.notEqual(rows.at(-1)!["observationAbout"], null);

    const table = await dataset.toArrow();
    assert.equal(table.numRows, dataset.rows);
    assert.deepEqual(
      table.schema.fields.map((field) => field.name),
      dataset.columns,
    );
    assert.equal(table.getChild("part")?.get(table.numRows - 1), "GDP.");
  });

  test("joins the members' sentences and gives each member's file on its own", () => {
    assert.equal(dataset.sentence, "Health. GDP.");
    assert.throws(() => dataset.bytes(), TypeError);
    assert.deepEqual(dataset.memberBytes(1), gdp);
  });
});

describe("retention", () => {
  const bytes = () => scenarioBytes("fetch-ref.parquet");
  const retained = async (...retentions: unknown[]) =>
    new Dataset(
      await Promise.all(
        retentions.map(async (retention, index) =>
          member(await bytes(), {
            spec: { spec_id: `spec_${index}`, definition: {} },
            manifest: retention === undefined ? {} : { retention },
          }),
        ),
      ),
      { layout: "long" },
    );

  test("is held until the earliest member's date, and pinned only when every member is", async () => {
    const dataset = await retained(
      { pinned: false, held_until: "2026-11-18T10:00:00Z" },
      { pinned: false, held_until: "2026-11-02T08:30:00Z" },
      { pinned: true },
    );
    assert.equal(dataset.heldUntil?.toISOString(), "2026-11-02T08:30:00.000Z");
    assert.equal(dataset.pinned, false);
  });

  test("is pinned with no date when every member is pinned", async () => {
    const dataset = await retained({ pinned: true }, { pinned: true });
    assert.equal(dataset.heldUntil, null);
    assert.equal(dataset.pinned, true);
  });

  test("is unknown while the server sends no retention", async () => {
    const dataset = await retained(undefined);
    assert.equal(dataset.heldUntil, null);
    assert.equal(dataset.pinned, false);
  });
});

test("bytes() returns a copy of the checked file", async () => {
  const data = await scenarioBytes("fetch-ref.parquet");
  const dataset = new Dataset([member(data)], { layout: "long" });
  const copy = dataset.bytes();
  assert.deepEqual(copy, data);
  copy[0] = 0;
  assert.deepEqual(dataset.bytes(), data);
});
