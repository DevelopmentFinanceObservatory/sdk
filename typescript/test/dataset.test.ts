import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, test } from "node:test";

import { parquetMetadata } from "hyparquet";
import { parquetWriteBuffer } from "hyparquet-writer";

import { toArrow } from "../src/datasets/arrow.ts";
import { Dataset, tableParts } from "../src/datasets/dataset.ts";
import type { FetchedMember } from "../src/datasets/dataset.ts";
import { decodeStored, readParquet, widen } from "../src/datasets/parquet.ts";
import { partFacts } from "../src/core/parse.ts";
import type { ColumnType } from "../src/datasets/parquet.ts";
import { DatasetRef } from "../src/core/ref.ts";
import type { Gap } from "../src/search/answer.ts";
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
    spec: { spec_id: specId, definition: { schema_version: 1, spec_id: specId, identity: {} } },
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
      assert.equal(rows.length, dataset.rowCount);
      assert.ok(dataset.rowCount > 0);
      assert.deepEqual(Object.keys(rows[0]!), dataset.columns);
      // INT64 columns arrive as numbers, so the rows serialise as JSON: a bigint would throw.
      assert.deepEqual(JSON.parse(JSON.stringify(rows)), rows);

      const table = await toArrow(dataset);
      assert.equal(table.numRows, dataset.rowCount);
      assert.deepEqual(
        table.schema.fields.map((field) => field.name),
        dataset.columns,
      );
      // The long layout stores time_period as INT64, the frame layout as a string.
      const period = rows[0]!["time_period"];
      const int64 = typeof period === "number";
      assert.equal(String(table.getChild("time_period")?.type), int64 ? "Int64" : "Utf8");
      assert.equal(table.getChild("time_period")?.get(0), int64 ? BigInt(period) : period);
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
    const table = await toArrow(await types());
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

  test("a column named __proto__ reads as any other", async () => {
    const name = "__proto__";
    const data = new Uint8Array(
      parquetWriteBuffer({
        columnData: [
          { name, data: ["a", "b"] },
          { name: "value", data: [1, 2] },
        ],
      }),
    );
    const dataset = new Dataset([member(data)], { layout: "long" });
    // The column-order rule puts the reading column `value` first.
    assert.deepEqual(dataset.columns, ["value", name]);
    const rows = await dataset.toRows();
    assert.deepEqual(
      rows.map((row) => [
        Object.getPrototypeOf(row) === Object.prototype,
        Object.keys(row),
        row[name],
        row["value"],
      ]),
      [
        [true, ["value", name], "a", 1],
        [true, ["value", name], "b", 2],
      ],
    );
    const table = await toArrow(dataset);
    assert.deepEqual(
      table.schema.fields.map((field) => field.name),
      ["value", name],
    );
    assert.equal(table.getChild(name)?.get(1), "b");
    const saved = parquetMetadata((await dataset.bytes()).buffer as ArrayBuffer);
    assert.deepEqual(
      saved.schema.slice(1).map((element) => element.name),
      ["value", name],
    );
  });

  test("a file with two columns of one name raises ContractError", () => {
    const data = new Uint8Array(
      parquetWriteBuffer({
        columnData: [
          { name: "a", data: [1] },
          { name: "a", data: [2] },
        ],
      }),
    );
    assert.throws(() => new Dataset([member(data)], { layout: "long" }), {
      name: "ContractError",
      code: "contract_violation",
    });
  });
});

describe("DECIMAL values", async () => {
  // Written by pyarrow 26 with store_decimal_as_integer: wide decimal128(22, 4) as a
  // FIXED_LEN_BYTE_ARRAY holding 12345678901234567.8912, -0.0001 and null; mid
  // decimal128(18, 3) as INT64 holding 123456789012345.678, -1.000 and null; narrow
  // decimal128(9, 2) as INT32 holding 1234567.89, null and -0.01.
  const data = new Uint8Array(await readFile(new URL("data/decimals.parquet", import.meta.url)));
  const unscaled = {
    wide: [123456789012345678912n, -1n, null],
    mid: [123456789012345678n, -1000n, null],
    narrow: [123456789n, null, -1n],
  };
  const valuesOf = async (dataset: Dataset) =>
    Object.fromEntries(
      (await decodeStored(tableParts(dataset))).map(({ name, values }) => [name, values]),
    );

  test("bytes() writes each decimal exact, as the unscaled integer the file stores", async () => {
    const dataset = new Dataset([member(data)], { layout: "long" });
    assert.deepEqual(await valuesOf(dataset), unscaled);
    const written = new Dataset([member(await dataset.bytes())], { layout: "long" });
    assert.deepEqual(await valuesOf(written), unscaled);
    assert.deepEqual(written.columns, dataset.columns);
  });

  test("toRows() and toArrow() give each decimal the nearest float", async () => {
    // Number() parses decimal text to the nearest float.
    const nearest = { wide: Number("12345678901234567.8912"), mid: Number("123456789012345.678") };
    const dataset = new Dataset([member(data)], { layout: "long" });
    const rows = await dataset.toRows();
    assert.deepEqual(rows[0], {
      ...nearest,
      narrow: 1234567.89,
    });
    assert.deepEqual(rows[1], { wide: -0.0001, mid: -1, narrow: null });
    const table = await toArrow(dataset);
    assert.equal(table.getChild("wide")?.get(0), nearest.wide);
    assert.equal(table.getChild("narrow")?.get(2), -0.01);
  });

  test("a stacked decimal rescales each member's unscaled integers to the stacked scale", async () => {
    const other = new Uint8Array(
      parquetWriteBuffer({
        columnData: [
          { name: "wide", data: [150n] },
          { name: "narrow", data: [7] },
        ],
        schema: [
          { name: "root", num_children: 2 },
          {
            name: "wide",
            repetition_type: "OPTIONAL",
            type: "INT32",
            converted_type: "DECIMAL",
            precision: 10,
            scale: 2,
          },
          { name: "narrow", repetition_type: "OPTIONAL", type: "INT32", converted_type: "INT_8" },
        ],
      }),
    );
    const dataset = new Dataset(
      [
        member(data, { parts: ["one"] }),
        member(other, { parts: ["two"], spec: { spec_id: "s2", definition: {} } }),
      ],
      { layout: "long" },
    );
    const expected = {
      part: ["one", "one", "one", "two"],
      wide: [...unscaled.wide, 15000n],
      mid: [...unscaled.mid, null],
      narrow: [...unscaled.narrow, 700n],
    };
    assert.deepEqual(await valuesOf(dataset), expected);
    const written = new Dataset([member(await dataset.bytes())], { layout: "long" });
    assert.deepEqual(await valuesOf(written), expected);
    assert.deepEqual((await written.toRows()).at(-1), {
      part: "two",
      wide: 1.5,
      mid: null,
      narrow: 7,
    });
  });
});

describe("a dataset of several members", async () => {
  const health = await scenarioBytes("answer-several-readings-folded.parquet");
  const gdp = await scenarioBytes("answer-several-readings-folded-2.parquet");
  const gdpSpec = `spec_${"2".repeat(32)}`;
  const assumed = {
    kind: "declared_default",
    binding_ref: "how:dac2aAidType",
    text: "official development assistance",
    refs: ["DAC2aAidType206"],
  };
  const answered = (assumptions: unknown[]) => [partFacts({ status: "definite", assumptions })];
  const dataset = new Dataset(
    [
      member(health, {
        parts: ["health ODA", "education ODA"],
        sentence: "Health.",
        answerFacts: answered([assumed]),
        manifest: {
          artifacts: [
            {
              artifact_digest: digestOf(health),
              rendering: { format: "parquet", bundle: false, layout: "long_v2" },
            },
          ],
        },
      }),
      member(gdp, {
        sentence: "GDP.",
        spec: {
          spec_id: gdpSpec,
          definition: { schema_version: 1, spec_id: gdpSpec, identity: {} },
        },
        answerFacts: answered([
          { ...assumed },
          { kind: "place_scope", binding_ref: "where:", text: "every country" },
        ]),
      }),
    ],
    { layout: "long" },
  );
  const placeScope = {
    kind: "place_scope",
    binding_ref: "where:",
    text: "every country",
    refs: [],
  };

  test("stacks into one table with the part column first", async () => {
    const rows = await dataset.toRows();
    assert.equal(rows.length, dataset.rowCount);
    assert.equal(dataset.columns[0], "part");
    assert.equal(rows[0]!["part"], "health ODA; education ODA");
    // A member that answers no part is labelled with its sentence.
    assert.equal(rows.at(-1)!["part"], "GDP.");
    // A column only the second member has is null in the first member's rows.
    assert.equal(rows[0]!["observationAbout"], null);
    assert.notEqual(rows.at(-1)!["observationAbout"], null);

    const table = await toArrow(dataset);
    assert.equal(table.numRows, dataset.rowCount);
    assert.deepEqual(
      table.schema.fields.map((field) => field.name),
      dataset.columns,
    );
    assert.equal(table.getChild("part")?.get(table.numRows - 1), "GDP.");
  });

  test("joins the members' sentences and gives each member's file on its own", () => {
    assert.equal(dataset.sentence, "Health. GDP.");
    assert.deepEqual(dataset.memberBytes(1), gdp);
  });

  test("collects the parts' assumptions once each, and the members' layouts", () => {
    assert.deepEqual(dataset.assumptions, [assumed, placeScope]);
    assert.equal(dataset.layoutVersion, "long_v2; long");
  });

  test("bytes() writes one Parquet file of the stacked table, with the provenance", async () => {
    const stacked = await dataset.bytes();
    // The file holds the stacked table's columns in its order, `part` first. Read back as one
    // member, the `part` column is one more column, so it moves behind the reading columns.
    assert.deepEqual(
      parquetMetadata(stacked.slice().buffer)
        .schema.slice(1)
        .map((element) => element.name),
      dataset.columns,
    );
    const reread = new Dataset([member(stacked)], { layout: "long" });
    assert.deepEqual(reread.columns.toSorted(), dataset.columns.toSorted());
    assert.deepEqual(await reread.toRows(), await dataset.toRows());

    const metadata = Object.fromEntries(
      (parquetMetadata(stacked.slice().buffer).key_value_metadata ?? []).map(({ key, value }) => [
        key,
        value,
      ]),
    );
    assert.deepEqual(Object.keys(metadata).toSorted(), [
      "dfo.citation",
      "dfo.dataset",
      "dfo.format_version",
      "dfo.licence",
      "dfo.ref",
      "dfo.sentence",
      "dfo.sources",
    ]);
    assert.equal(metadata["dfo.format_version"], "1");
    assert.equal(metadata["dfo.sentence"], "Health. GDP.");
    const ref = DatasetRef.fromJSON(JSON.parse(metadata["dfo.ref"]!));
    assert.deepEqual(ref.toJSON(), dataset.ref.toJSON());
    const saved = JSON.parse(metadata["dfo.dataset"]!) as Record<string, unknown>;
    assert.deepEqual(Object.keys(saved).toSorted(), [
      "assumptions",
      "complete",
      "departures",
      "held_until",
      "layout_version",
      "member_citations",
      "missing",
      "pinned",
      "requested_operations",
      "stale",
      "warnings",
    ]);
    assert.equal(saved["complete"], true);
    assert.deepEqual(saved["assumptions"], [assumed, placeScope]);
    assert.equal(saved["layout_version"], "long_v2; long");
  });
});

test("a stacked file keeps every column type the members store", async () => {
  const data = new Uint8Array(await readFile(new URL("data/types.parquet", import.meta.url)));
  const dataset = new Dataset(
    [
      member(data, { parts: ["one"] }),
      member(data, { parts: ["two"], spec: { spec_id: "s2", definition: {} } }),
    ],
    { layout: "long" },
  );
  const stacked = await dataset.bytes();
  const reread = new Dataset([member(stacked)], { layout: "long" });
  const [original, written] = await Promise.all(
    [dataset, reread].map((table) => decodeStored(tableParts(table))),
  );
  assert.deepEqual(written, original);
  assert.equal(written!.find((column) => column.name === "big")?.values[1], 2n ** 60n);
  // hyparquet-writer writes the INTEGER logical type in a form pyarrow cannot read, so
  // integers carry the legacy converted type alone.
  const schema = parquetMetadata(stacked.slice().buffer).schema;
  assert.ok(schema.every((element) => element.logical_type?.type !== "INTEGER"));
  assert.equal(schema.find((element) => element.name === "small")?.converted_type, "UINT_8");
});

describe("an empty member beside a member with rows", async () => {
  // The file dev builds for a window before the data starts, every column typed as a string.
  const empty = new Uint8Array(
    await readFile(new URL("data/empty-build.parquet", import.meta.url)),
  );
  const filled = await scenarioBytes("answer-several-readings-folded.parquet");
  const emptySpec = `spec_${"3".repeat(32)}`;
  const dataset = new Dataset(
    [
      member(filled, { sentence: "Health." }),
      member(empty, {
        sentence: "No data.",
        spec: {
          spec_id: emptySpec,
          definition: { schema_version: 1, spec_id: emptySpec, identity: {} },
        },
      }),
    ],
    { layout: "long" },
  );
  const alone = new Dataset([member(filled)], { layout: "long" });

  test("stacks, keeping the empty member and the other member's column types", async () => {
    assert.deepEqual(
      dataset.members.map((entry) => entry.spec.spec_id),
      [`spec_${"0".repeat(32)}`, emptySpec],
    );
    assert.equal(dataset.rowCount, alone.rowCount);
    assert.deepEqual(dataset.columns, ["part", ...alone.columns]);
    const types = (columns: { name: string; type: ColumnType }[]) =>
      columns.filter(({ name }) => name !== "part");
    assert.deepEqual(
      types(await decodeStored(tableParts(dataset))).map(({ name, type }) => [name, type]),
      types(await decodeStored(tableParts(alone))).map(({ name, type }) => [name, type]),
    );
  });

  test("an empty member alone keeps its own columns", () => {
    assert.ok(new Dataset([member(empty)], { layout: "long" }).columns.includes("value"));
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

describe("String(dataset)", async () => {
  const data = await scenarioBytes("fetch-ref.parquet");
  const manifest = {
    retention: { pinned: false, held_until: "2026-11-11T09:00:00Z" },
    citation: { text: "WDI.", sources: [{ ref: "dc:WDI", label: "World Development Indicators" }] },
  };

  test("ends with the line that keeps the ref and fetches its newest version later", () => {
    const dataset = new Dataset([member(data, { manifest })], { layout: "long" });
    const lines = String(dataset).split("\n");
    assert.deepEqual(lines, [
      "<Dataset A sentence.",
      "  Source: World Development Indicators",
      `  Version: cv_${"0".repeat(32)} (exact), held until 11 November 2026, not pinned`,
      `  Rows: ${dataset.rowCount.toLocaleString("en-GB")}`,
      "  Keep: JSON.stringify(data.ref) · newest later: client.fetch(data.ref, { latest: true })>",
    ]);
  });

  test("says when the data is pinned, and how many parts a partial fetch left out", () => {
    const pinned = { ...manifest, retention: { pinned: true } };
    const gap = { partIndex: 1, part: "GDP", kind: "not_understood", message: "", options: [] };
    const dataset = new Dataset([member(data, { manifest: pinned })], {
      layout: "long",
      missing: [gap as unknown as Gap],
    });
    assert.match(String(dataset), /\(exact\), pinned\n/);
    assert.match(String(dataset), /\n {2}Incomplete: 1 part\(s\) left out\n/);
  });
});

describe("one member", async () => {
  const data = await scenarioBytes("fetch-ref.parquet");
  const assumed = {
    kind: "declared_default",
    binding_ref: "how:dac2aAidType",
    text: "official development assistance",
    refs: ["DAC2aAidType206"],
  };
  const dataset = new Dataset(
    [member(data, { answerFacts: [partFacts({ status: "definite", assumptions: [assumed] })] })],
    { layout: "long" },
  );

  test("memberBytes(0) returns a copy of the checked file, unchanged", () => {
    const copy = dataset.memberBytes(0);
    assert.deepEqual(copy, data);
    copy[0] = 0;
    assert.deepEqual(dataset.memberBytes(0), data);
  });

  test("copies input once at construction and keeps an exact input buffer while reading", () => {
    const raw = data.slice();
    const dataset = new Dataset([member(raw)], { layout: "long" });
    raw[0] = 0;
    assert.deepEqual(dataset.memberBytes(0), data);

    const exact = readParquet(data);
    assert.equal(exact.buffer, data.buffer);
    const backed = new Uint8Array(data.length + 2);
    backed.set(data, 1);
    const view = backed.subarray(1, data.length + 1);
    assert.notEqual(readParquet(view).buffer, backed.buffer);

    const nodeBuffer = Buffer.from(data);
    const fromBuffer = new Dataset([member(nodeBuffer)], { layout: "long" });
    nodeBuffer.fill(0);
    assert.deepEqual(fromBuffer.memberBytes(0), data);
    const slicedBuffer = Buffer.from(backed).subarray(1, data.length + 1);
    const parsed = readParquet(slicedBuffer);
    assert.notEqual(parsed.buffer, slicedBuffer.buffer);
    assert.equal(parsed.buffer.byteLength, data.length);
  });

  test("bytes() writes the member's table with the provenance and no part column", async () => {
    const written = await dataset.bytes();
    const metadata = Object.fromEntries(
      (parquetMetadata(written.slice().buffer).key_value_metadata ?? []).map(({ key, value }) => [
        key,
        value,
      ]),
    );
    assert.equal(metadata["dfo.format_version"], "1");
    const saved = JSON.parse(metadata["dfo.dataset"]!) as Record<string, unknown>;
    assert.deepEqual(saved["assumptions"], [assumed]);
    const reread = new Dataset([member(written)], { layout: "long" });
    assert.deepEqual(reread.columns, dataset.columns);
    assert.ok(!reread.columns.includes("part"));
    assert.deepEqual(await reread.toRows(), await dataset.toRows());
  });
});

describe("members whose column types differ", () => {
  type Spec = {
    type: string;
    logical?: Record<string, unknown>;
    converted?: "UINT_32" | "UINT_64";
    data: unknown[];
  };
  const file = (columns: Record<string, Spec>): Uint8Array =>
    new Uint8Array(
      parquetWriteBuffer({
        columnData: Object.entries(columns).map(([name, { data }]) => ({ name, data })),
        schema: [
          { name: "root", num_children: Object.keys(columns).length },
          ...Object.entries(columns).map(([name, { type, logical, converted }]) => ({
            name,
            repetition_type: "OPTIONAL" as const,
            type: type as "INT32",
            ...(logical === undefined ? {} : { logical_type: logical as { type: "NULL" } }),
            ...(converted === undefined ? {} : { converted_type: converted }),
          })),
        ],
      }),
    );
  const stamp = (unit: string) => ({ type: "TIMESTAMP", isAdjustedToUTC: true, unit });
  const stacked = () =>
    new Dataset(
      [
        member(
          file({
            year: { type: "INT32", data: [2020] },
            value: { type: "INT64", data: [7n] },
            at: { type: "INT64", logical: stamp("MILLIS"), data: [1_000n] },
          }),
          { parts: ["one"] },
        ),
        member(
          file({
            year: { type: "INT64", data: [2021n] },
            value: { type: "DOUBLE", data: [0.5] },
            at: { type: "INT64", logical: stamp("MICROS"), data: [2_000_000n] },
          }),
          { parts: ["two"], spec: { spec_id: "s2", definition: {} } },
        ),
      ],
      { layout: "long" },
    );

  test("stack widened as pyarrow widens them", async () => {
    const dataset = stacked();
    const table = await toArrow(dataset);
    const type = (name: string) => String(table.getChild(name)?.type);
    assert.equal(type("year"), "Int64");
    assert.equal(type("value"), "Float64");
    assert.equal(type("at"), "Timestamp<MICROSECOND, UTC>");
    assert.deepEqual(
      (await dataset.toRows()).map(({ year, value, at }) => [year, value, at]),
      [
        [2020, 7, new Date(1_000)],
        [2021, 0.5, new Date(2_000)],
      ],
    );
    const reread = new Dataset([member(await dataset.bytes())], { layout: "long" });
    assert.deepEqual(await reread.toRows(), await dataset.toRows());
    const stored = await decodeStored(tableParts(reread));
    // Read back as one member, `part` is one more column and moves behind `value`.
    const typed = (columns: readonly { name: string; type: unknown }[]) =>
      columns
        .map(({ name, type }) => ({ name, type }))
        .toSorted((a, b) => (a.name < b.name ? -1 : 1));
    assert.deepEqual(typed(stored), typed(await decodeStored(tableParts(dataset))));
    assert.deepEqual(stored.find((column) => column.name === "at")?.values, [
      1_000_000n,
      2_000_000n,
    ]);
  });

  test("raise ContractError when a column's types do not widen to one", () => {
    const flag = file({ year: { type: "BOOLEAN", data: [true] } });
    const year = file({ year: { type: "INT32", data: [2020] } });
    assert.throws(
      () =>
        new Dataset([member(flag), member(year, { spec: { spec_id: "s2", definition: {} } })], {
          layout: "long",
        }),
      { name: "ContractError", code: "contract_violation" },
    );
  });

  test("raise ContractError for a column type the client cannot read", () => {
    const nested = new Uint8Array(
      parquetWriteBuffer({
        columnData: [{ name: "x", data: [new Uint8Array([0])] }],
        schema: [
          { name: "root", num_children: 1 },
          { name: "x", repetition_type: "OPTIONAL", type: "BYTE_ARRAY", converted_type: "BSON" },
        ],
      }),
    );
    assert.throws(() => new Dataset([member(nested)], { layout: "long" }), {
      name: "ContractError",
      code: "contract_violation",
    });
  });

  test("raise ContractError when a member's file holds its own part column", () => {
    const own = file({ part: { type: "BYTE_ARRAY", logical: { type: "STRING" }, data: ["x"] } });
    const year = file({ year: { type: "INT32", data: [2020] } });
    assert.throws(
      () =>
        new Dataset([member(year), member(own, { spec: { spec_id: "s2", definition: {} } })], {
          layout: "long",
        }),
      { name: "ContractError", code: "contract_violation" },
    );
    // One member is not stacked, so its own part column is its data.
    assert.deepEqual(new Dataset([member(own)], { layout: "long" }).columns, ["part"]);
  });

  test("stacks UINT32 with INT64, converts it to INT64, and saves the widened table", async () => {
    const unsigned = file({ count: { type: "INT32", converted: "UINT_32", data: [2 ** 32 - 1] } });
    const signed = file({ count: { type: "INT64", data: [-1n] } });
    const dataset = new Dataset(
      [
        member(unsigned, { parts: ["unsigned"] }),
        member(signed, { parts: ["signed"], spec: { spec_id: "s2", definition: {} } }),
      ],
      { layout: "long" },
    );
    assert.equal(String((await toArrow(dataset)).getChild("count")?.type), "Int64");
    assert.deepEqual(
      (await dataset.toRows()).map(({ count }) => count),
      [2 ** 32 - 1, -1],
    );
    const saved = new Dataset([member(await dataset.bytes())], { layout: "long" });
    assert.deepEqual(await saved.toRows(), await dataset.toRows());
  });

  test("refuses UINT64 with a signed member while accepting UINT64 alone", () => {
    const unsigned = file({ count: { type: "INT64", converted: "UINT_64", data: [1n] } });
    const signed = file({ count: { type: "INT64", data: [-1n] } });
    assert.deepEqual(new Dataset([member(unsigned)], { layout: "long" }).columns, ["count"]);
    assert.throws(
      () =>
        new Dataset(
          [member(unsigned), member(signed, { spec: { spec_id: "s2", definition: {} } })],
          { layout: "long" },
        ),
      { name: "ContractError", code: "contract_violation" },
    );
  });

  test("preserves the UINT64 maximum through Arrow conversion and save", async () => {
    const maximum = (1n << 64n) - 1n;
    const unsigned = file({ count: { type: "INT64", converted: "UINT_64", data: [maximum] } });
    const dataset = new Dataset([member(unsigned)], { layout: "long" });
    assert.equal((await toArrow(dataset)).getChild("count")?.get(0), maximum);
    const saved = new Dataset([member(await dataset.bytes())], { layout: "long" });
    assert.equal((await toArrow(saved)).getChild("count")?.get(0), maximum);
  });
});

describe("widen", () => {
  const int = (bits: 8 | 16 | 32 | 64, signed = true): ColumnType => ({
    kind: "int",
    bits,
    signed,
  });
  const float = (bits: 32 | 64): ColumnType => ({ kind: "float", bits });
  const decimal = (precision: number, scale: number): ColumnType => ({
    kind: "decimal",
    precision,
    scale,
  });
  const stamp = (unit: "MILLIS" | "MICROS" | "NANOS", utc = false): ColumnType => ({
    kind: "timestamp",
    unit,
    utc,
  });
  // Each row is what pyarrow 26's concat_tables(promote_options="permissive") gives the pair.
  const rows: [ColumnType, ColumnType, ColumnType | undefined][] = [
    [{ kind: "null" }, { kind: "bool" }, { kind: "bool" }],
    [int(32), int(64), int(64)],
    [int(8), int(8, false), int(16)],
    [int(16), int(32, false), int(64)],
    [int(64), int(64, false), undefined],
    [int(8, false), int(32, false), int(32, false)],
    [int(16), float(32), float(32)],
    [int(32), float(32), float(64)],
    [int(64), float(64), float(64)],
    [float(32), float(64), float(64)],
    [stamp("MILLIS"), stamp("MICROS"), stamp("MICROS")],
    [stamp("NANOS", true), stamp("MILLIS", true), stamp("NANOS", true)],
    [stamp("MILLIS"), stamp("MILLIS", true), undefined],
    [{ kind: "string" }, { kind: "binary" }, { kind: "binary" }],
    [{ kind: "bool" }, int(8), undefined],
    [{ kind: "date" }, stamp("MILLIS"), undefined],
    [float(64), { kind: "string" }, undefined],
    [decimal(10, 2), decimal(12, 4), decimal(12, 4)],
    [decimal(38, 2), decimal(12, 4), decimal(40, 4)],
    [decimal(76, 0), decimal(10, 5), undefined],
    [decimal(10, 2), int(8), decimal(10, 2)],
    [decimal(10, 2), int(32), undefined],
    [decimal(12, 2), int(32), decimal(12, 2)],
    [decimal(21, 2), int(64), decimal(21, 2)],
    [decimal(21, 2), int(64, false), undefined],
    [decimal(10, 2), float(32), float(32)],
    [decimal(10, 2), float(64), float(64)],
    [decimal(10, 2), { kind: "null" }, decimal(10, 2)],
    [decimal(10, 2), { kind: "bool" }, undefined],
    [decimal(10, 2), { kind: "string" }, undefined],
    [decimal(10, 2), stamp("MILLIS"), undefined],
  ];
  for (const [left, right, expected] of rows) {
    test(`${JSON.stringify(left)} with ${JSON.stringify(right)}`, () => {
      assert.deepEqual(widen(left, right), expected);
      assert.deepEqual(widen(right, left), expected);
    });
  }
});
