import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { parquetMetadata } from "hyparquet";
import { parquetWriteBuffer } from "hyparquet-writer";

import { toArrow } from "../src/datasets/arrow.ts";
import { Dataset, datasetTable, pinnedDataset } from "../src/datasets/dataset.ts";
import type { FetchedMember } from "../src/datasets/dataset.ts";
import { decodeRows, decodeStored, readParquet, widen } from "../src/datasets/parquet.ts";
import { partFacts } from "../src/core/parse.ts";
import type { ColumnType, Row, StoredColumn, Table } from "../src/datasets/parquet.ts";
import { derivedDataset } from "../src/datasets/derived.ts";
import { DatasetRef, isDerived } from "../src/core/ref.ts";
import type { DerivedRefMember } from "../src/core/ref.ts";
import type { Gap } from "../src/search/answer.ts";
import { replay, scenario, scenarioBytes, stepOf } from "./replay.ts";
import { clientOver } from "../src/client.ts";
import { InvalidRequestError } from "../src/core/errors.ts";
import { installFileWriter } from "../src/datasets/save.ts";
import { writeDatasetFile } from "../src/datasets/save-node.ts";
import { recordedBytes, recordedJson } from "./support.ts";

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

/** A file `toBytes()` wrote, read as it stands: its columns and rows in file order, and the
 *  member row counts its `dfo.dataset` records, which Python's `dfo.load` splits it by. */
function readSaved(bytes: Uint8Array): {
  rows: () => Promise<Row[]>;
  stored: () => Promise<StoredColumn[]>;
  memberRows: unknown;
} {
  const file = readParquet(bytes);
  const table: Table = {
    parts: [{ file, label: "" }],
    order: {
      columns: file.columns.map(({ name }) => name),
      rows: Uint32Array.from({ length: file.rows }, (_, index) => index),
    },
  };
  const saved = file.metadata.key_value_metadata?.find(({ key }) => key === "dfo.dataset");
  const memberRows = (JSON.parse(saved?.value ?? "{}") as Record<string, unknown>)["member_rows"];
  return { rows: () => decodeRows(table), stored: () => decodeStored(table), memberRows };
}

const parquetFiles = async (): Promise<string[]> => {
  const names = (await readdir(SCENARIOS)).filter((name) => name.endsWith(".parquet"));
  assert.ok(names.length > 0, "the contract holds no Parquet bodies");
  return names;
};

describe("every scenario Parquet body decodes", async () => {
  for (const name of await parquetFiles()) {
    test(name, async () => {
      const dataset = await Dataset.create([member(await scenarioBytes(name))], { layout: "long" });
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
  // blob binary, nothing null; three rows with a null in the second, which sorts last by year.
  const types = async () =>
    await Dataset.create(
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
    assert.equal(table.getChild("big")?.get(2), 2n ** 60n);
    assert.equal(table.getChild("year")?.get(2), null);
    assert.equal(table.getChild("year")?.nullCount, 1);
    const stamps: unknown = table.getChild("stamp")?.toArray();
    assert.ok(stamps instanceof BigInt64Array);
    assert.equal(stamps[0], BigInt(Date.UTC(2026, 9, 20, 12)) * 1000n + 123_456n);
    assert.equal(table.getChild("amount")?.get(0), 12.34);
    assert.deepEqual(table.getChild("blob")?.get(0), new Uint8Array([0, 1]));
  });

  test("toRows refuses an int64 beyond a number's exact range", async () => {
    await assert.rejects((await types()).toRows(), {
      name: "InvalidRequestError",
      code: "invalid_argument",
    });
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
    const dataset = await Dataset.create([member(data)], { layout: "long" });
    // The reading-order rule puts the reading column `value` first.
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
    const saved = parquetMetadata((await dataset.toBytes()).buffer as ArrayBuffer);
    assert.deepEqual(
      saved.schema.slice(1).map((element) => element.name),
      ["value", name],
    );
  });

  test("a file with two columns of one name raises ContractError", async () => {
    const data = new Uint8Array(
      parquetWriteBuffer({
        columnData: [
          { name: "a", data: [1] },
          { name: "a", data: [2] },
        ],
      }),
    );
    await assert.rejects(() => Dataset.create([member(data)], { layout: "long" }), {
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
  // In reading order, the rows sorted by `wide`: the file's second row, then its first.
  const unscaled = {
    wide: [-1n, 123456789012345678912n, null],
    mid: [-1000n, 123456789012345678n, null],
    narrow: [null, 123456789n, -1n],
  };
  const valuesOf = async (dataset: Dataset) =>
    Object.fromEntries(
      (await decodeStored(datasetTable(dataset))).map(({ name, values }) => [name, values]),
    );

  test("toBytes() writes each decimal exact, as the unscaled integer the file stores", async () => {
    const dataset = await Dataset.create([member(data)], { layout: "long" });
    assert.deepEqual(await valuesOf(dataset), unscaled);
    const written = await Dataset.create([member(await dataset.toBytes())], { layout: "long" });
    assert.deepEqual(await valuesOf(written), unscaled);
    assert.deepEqual(written.columns, dataset.columns);
  });

  test("toRows() and toArrow() give each decimal the nearest float", async () => {
    // Number() parses decimal text to the nearest float.
    const nearest = { wide: Number("12345678901234567.8912"), mid: Number("123456789012345.678") };
    const dataset = await Dataset.create([member(data)], { layout: "long" });
    const rows = await dataset.toRows();
    assert.deepEqual(rows[1], {
      ...nearest,
      narrow: 1234567.89,
    });
    assert.deepEqual(rows[0], { wide: -0.0001, mid: -1, narrow: null });
    const table = await toArrow(dataset);
    assert.equal(table.getChild("wide")?.get(1), nearest.wide);
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
    const dataset = await Dataset.create(
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
    const written = readSaved(await dataset.toBytes());
    assert.deepEqual(
      Object.fromEntries((await written.stored()).map(({ name, values }) => [name, values])),
      expected,
    );
    assert.deepEqual(written.memberRows, [3, 1]);
    assert.deepEqual((await written.rows()).at(-1), {
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
  const dataset = await Dataset.create(
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

  test("toBytes() writes one Parquet file of the stacked table, with the provenance", async () => {
    const stacked = await dataset.toBytes();
    // The file holds the table's columns in reading order, `part` first, and reads back so.
    assert.deepEqual(
      parquetMetadata(stacked.slice().buffer)
        .schema.slice(1)
        .map((element) => element.name),
      dataset.columns,
    );
    const reread = readSaved(stacked);
    assert.deepEqual(await reread.rows(), await dataset.toRows());
    assert.deepEqual(reread.memberRows, [readParquet(health).rows, readParquet(gdp).rows]);

    const metadata = Object.fromEntries(
      (parquetMetadata(stacked.slice().buffer).key_value_metadata ?? []).map(({ key, value }) => [
        key,
        value,
      ]),
    );
    // A dataset fetched outside an answer saves no `dfo.question`.
    assert.deepEqual(Object.keys(metadata).toSorted(), [
      "dfo.citation",
      "dfo.dataset",
      "dfo.fetched_at",
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
      "member_rows",
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
  const dataset = await Dataset.create(
    [
      member(data, { parts: ["one"] }),
      member(data, { parts: ["two"], spec: { spec_id: "s2", definition: {} } }),
    ],
    { layout: "long" },
  );
  const stacked = await dataset.toBytes();
  const original = await decodeStored(datasetTable(dataset));
  const written = await readSaved(stacked).stored();
  assert.deepEqual(written, original);
  assert.equal(written.find((column) => column.name === "big")?.values[2], 2n ** 60n);
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
  const dataset = await Dataset.create(
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
  const alone = await Dataset.create([member(filled)], { layout: "long" });

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
      types(await decodeStored(datasetTable(dataset))).map(({ name, type }) => [name, type]),
      types(await decodeStored(datasetTable(alone))).map(({ name, type }) => [name, type]),
    );
  });

  test("an empty member alone keeps its own columns", async () => {
    assert.ok(
      (await Dataset.create([member(empty)], { layout: "long" })).columns.includes("value"),
    );
  });
});

describe("provenance", async () => {
  const data = await scenarioBytes("fetch-ref.parquet");
  const manifest = {
    citation: {
      text: "WDI; CRS.",
      sources: [
        {
          ref: "dc:WDI",
          label: "World Development Indicators",
          license: "CC BY 4.0",
          license_url: "https://creativecommons.org/licenses/by/4.0/",
          url: "https://data.worldbank.org",
          processing_level: "raw",
        },
        { ref: "dc:CRS", label: "Creditor Reporting System" },
        { ref: "dc:WDI2", label: "WDI again", license: "CC BY 4.0" },
      ],
    },
  };
  const fetchedAt = new Date("2026-11-13T09:15:42.678Z");
  const dataset = await Dataset.create([member(data, { manifest })], {
    layout: "long",
    question: "Aid to Nigeria",
    fetchedAt,
  });

  test("spells each source's licence as Python does, and joins the distinct licences", () => {
    assert.deepEqual(dataset.citation.sources[0], {
      ref: "dc:WDI",
      label: "World Development Indicators",
      licence: "CC BY 4.0",
      licenceUrl: "https://creativecommons.org/licenses/by/4.0/",
      url: "https://data.worldbank.org",
    });
    assert.deepEqual(dataset.citation.sources[1], {
      ref: "dc:CRS",
      label: "Creditor Reporting System",
      licence: null,
      licenceUrl: null,
      url: null,
    });
    assert.equal(dataset.licence, "CC BY 4.0");
  });

  test("keeps the question and the fetch time to the second, and saves both", async () => {
    assert.equal(dataset.question, "Aid to Nigeria");
    assert.equal(dataset.fetchedAt.toISOString(), "2026-11-13T09:15:42.000Z");
    const metadata = Object.fromEntries(
      (parquetMetadata((await dataset.toBytes()).slice().buffer).key_value_metadata ?? []).map(
        ({ key, value }) => [key, value],
      ),
    );
    assert.equal(JSON.parse(metadata["dfo.question"]!), "Aid to Nigeria");
    assert.equal(JSON.parse(metadata["dfo.fetched_at"]!), "2026-11-13T09:15:42Z");
    assert.equal(metadata["dfo.licence"], "CC BY 4.0");
    const citation = JSON.parse(metadata["dfo.citation"]!) as { sources: unknown[] };
    assert.deepEqual(citation.sources[0], {
      ref: "dc:WDI",
      label: "World Development Indicators",
      licence: "CC BY 4.0",
      licence_url: "https://creativecommons.org/licenses/by/4.0/",
      url: "https://data.worldbank.org",
    });
  });

  test("a pinned copy keeps the question and the fetch time", () => {
    const pinned = pinnedDataset(dataset);
    assert.equal(pinned.question, "Aid to Nigeria");
    assert.equal(pinned.fetchedAt.getTime(), dataset.fetchedAt.getTime());
  });

  test("a dataset with no question has none, and is stamped when it was made", async () => {
    const before = Math.floor(Date.now() / 1000) * 1000;
    const plain = await Dataset.create([member(data)], { layout: "long" });
    assert.equal(plain.question, null);
    assert.ok(plain.fetchedAt.getTime() >= before && plain.fetchedAt.getTime() <= Date.now());
    assert.equal(plain.fetchedAt.getMilliseconds(), 0);
  });

  test("save(path) writes the file toBytes() returns", async () => {
    installFileWriter(writeDatasetFile);
    const dir = await mkdtemp(join(tmpdir(), "dfo-save-"));
    try {
      const path = join(dir, "aid.parquet");
      await dataset.save(path);
      assert.deepEqual(new Uint8Array(await readFile(path)), await dataset.toBytes());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("save(path) refuses where no file writer is installed, naming toBytes()", async () => {
    installFileWriter(undefined);
    try {
      await assert.rejects(dataset.save("aid.parquet"), (error: unknown) => {
        assert.ok(error instanceof InvalidRequestError);
        assert.equal(error.code, "invalid_argument");
        assert.match(error.message, /toBytes\(\)/);
        return true;
      });
    } finally {
      installFileWriter(writeDatasetFile);
    }
  });
});

describe("retention", () => {
  const bytes = () => scenarioBytes("fetch-ref.parquet");
  const retained = async (...retentions: unknown[]) =>
    await Dataset.create(
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

  test("ends with the line that keeps the ref and fetches its newest version later", async () => {
    const dataset = await Dataset.create([member(data, { manifest })], { layout: "long" });
    const lines = String(dataset).split("\n");
    assert.deepEqual(lines, [
      "<Dataset A sentence.",
      "  Source: World Development Indicators",
      `  Version: cv_${"0".repeat(32)} (exact), held until 11 November 2026, not pinned`,
      // The long layout holds time_period as integers, which the Rows line names.
      `  Rows: ${dataset.rowCount.toLocaleString("en-GB")}, time_period as integer years`,
      "  Keep: JSON.stringify(data.ref) · newest later: client.fetch(data.ref, { latest: true })>",
    ]);
  });

  test("says when the data is pinned, and how many parts a partial fetch left out", async () => {
    const pinned = { ...manifest, retention: { pinned: true } };
    const gap = { partIndex: 1, part: "GDP", kind: "not_understood", message: "", options: [] };
    const dataset = await Dataset.create([member(data, { manifest: pinned })], {
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
  const dataset = await Dataset.create(
    [member(data, { answerFacts: [partFacts({ status: "definite", assumptions: [assumed] })] })],
    { layout: "long" },
  );

  test("memberBytes(0) returns a copy of the checked file, unchanged", () => {
    const copy = dataset.memberBytes(0);
    assert.deepEqual(copy, data);
    copy[0] = 0;
    assert.deepEqual(dataset.memberBytes(0), data);
  });

  test("copies input once at construction and keeps an exact input buffer while reading", async () => {
    const raw = data.slice();
    const dataset = await Dataset.create([member(raw)], { layout: "long" });
    raw[0] = 0;
    assert.deepEqual(dataset.memberBytes(0), data);

    const exact = readParquet(data);
    assert.equal(exact.buffer, data.buffer);
    const backed = new Uint8Array(data.length + 2);
    backed.set(data, 1);
    const view = backed.subarray(1, data.length + 1);
    assert.notEqual(readParquet(view).buffer, backed.buffer);

    const nodeBuffer = Buffer.from(data);
    const fromBuffer = await Dataset.create([member(nodeBuffer)], { layout: "long" });
    nodeBuffer.fill(0);
    assert.deepEqual(fromBuffer.memberBytes(0), data);
    const slicedBuffer = Buffer.from(backed).subarray(1, data.length + 1);
    const parsed = readParquet(slicedBuffer);
    assert.notEqual(parsed.buffer, slicedBuffer.buffer);
    assert.equal(parsed.buffer.byteLength, data.length);
  });

  test("toBytes() writes the member's table with the provenance and no part column", async () => {
    const written = await dataset.toBytes();
    const metadata = Object.fromEntries(
      (parquetMetadata(written.slice().buffer).key_value_metadata ?? []).map(({ key, value }) => [
        key,
        value,
      ]),
    );
    assert.equal(metadata["dfo.format_version"], "1");
    assert.equal(metadata["dfo.left_out"], undefined);
    const saved = JSON.parse(metadata["dfo.dataset"]!) as Record<string, unknown>;
    assert.deepEqual(saved["assumptions"], [assumed]);
    const reread = await Dataset.create([member(written)], { layout: "long" });
    assert.deepEqual(reread.columns, dataset.columns);
    assert.ok(!reread.columns.includes("part"));
    assert.deepEqual(await reread.toRows(), await dataset.toRows());
  });
});

/** A recorded analysis's derived dataset, from its ready answer's ref member, its manifest
 *  with `change` applied, and its frame: `chain` divides aid by population and takes its growth,
 *  dropping three series over the two steps; `rank` ranks with a latest year settled on 2022. */
async function derived(
  name: "chain" | "rank" = "chain",
  change: Record<string, unknown> = {},
  memberChange: Partial<DerivedRefMember> = {},
): Promise<Dataset> {
  const member = { ...(await derivedMember(name)), ...memberChange };
  const manifest = { ...(await recordedJson(`analysis-${name}-manifest.json`)), ...change };
  const data = await recordedBytes(`analysis-${name}-frame.parquet`);
  return (await derivedDataset(member, manifest, data)).dataset;
}

async function derivedMember(name: "chain" | "rank" = "chain"): Promise<DerivedRefMember> {
  const { ref } = await recordedJson<{ ref: unknown }>(`analysis-${name}-ready.json`);
  const [member] = DatasetRef.fromJSON(ref).members;
  assert.ok(member && isDerived(member));
  return member;
}

const savedMetadata = async (dataset: Dataset): Promise<Record<string, string | undefined>> =>
  Object.fromEntries(
    (parquetMetadata((await dataset.toBytes()).slice().buffer).key_value_metadata ?? []).map(
      ({ key, value }) => [key, value],
    ),
  );

describe("a derived dataset", () => {
  test("reads the series its manifest serves as left out", async () => {
    const dataset = await derived();
    const served = (await recordedJson("analysis-chain-manifest.json"))["left_out"];
    assert.deepEqual(
      dataset.leftOut.map(({ coordinates, step, side, reason, rows }) => ({
        coordinates: { ...coordinates },
        step: { ...step },
        side,
        reason,
        rows,
      })),
      served,
    );
    // A series prints a line that leads with its entity, the ops_ variable left out.
    assert.equal(
      String(dataset.leftOut[0]),
      "LeftOutSeries(financingRecipient=country/NGA: growth dropped 1 row from data, " +
        "endpoint_missing)",
    );
    assert.ok(dataset.ref.equals(new DatasetRef([await derivedMember()])));
    assert.deepEqual(
      [dataset.heldUntil?.toISOString(), dataset.pinned, dataset.layoutVersion],
      ["2026-11-27T15:10:16.473Z", false, "frame"],
    );
  });

  test("prints its steps, period and left-out series as Python's repr does", async () => {
    const lines = String(await derived()).split("\n");
    assert.deepEqual(lines.slice(1), [
      "  Derived: quotient_of by financingRecipient, then growth by financingRecipient, from 2 " +
        "readings",
      "  Missing data: 3 series left out · data.leftOut",
      "  Version: ocv_422e3d46d9e05f9ea8027c97c0c2f58b (exact), held until 27 November 2026, " +
        "not pinned",
      // A frame holds time_period as text, which a filter on 2022 would miss.
      '  Rows: 1, time_period as text, such as "2022" or "2021/2022"',
      "  Keep: JSON.stringify(data.ref) · newest later: client.fetch(data.ref, { latest: true })>",
    ]);
    assert.deepEqual(
      String(await derived("rank"))
        .split("\n")
        .slice(1, 3),
      [
        "  Derived: rank by financingRecipient, limit 2, from 1 reading",
        "  Period: 2022, the newest year at least half the series hold",
      ],
    );
  });

  for (const [name, periods, line] of [
    ["latest", [[0, "2024"]], "Period: 2024, the newest year at least half the series hold"],
    [
      "window",
      [
        [-4, "2020"],
        [0, "2024"],
      ],
      "Period: 2020 to 2024, counted back from 2024, the newest year at least half the series " +
        "hold",
    ],
    [
      "before-latest",
      [[-1, "2023"]],
      "Period: 2023, counted back from 2024, the newest year at least half the series hold",
    ],
  ] as const) {
    test(`counts its period back from the newest year (${name})`, async () => {
      const resolvedPeriods = periods.map(([offset, period]) => ({
        anchor: "latest" as const,
        offset,
        rule: "half1" as const,
        period,
      }));
      const lines = String(await derived("rank", {}, { resolvedPeriods })).split("\n");
      assert.ok(lines.includes(`  ${line}`), lines.join("\n"));
    });
  }

  test("prints at least when its manifest lists only some of what it left out", async () => {
    const lines = String(await derived("chain", { left_out_complete: false })).split("\n");
    assert.ok(lines.includes("  Missing data: at least 3 series left out · data.leftOut"));
  });

  for (const complete of [true, false]) {
    test(`toBytes() writes its format 2 ref, left-out series and steps (complete ${complete})`, async () => {
      const dataset = await derived("chain", { left_out_complete: complete });
      const metadata = await savedMetadata(dataset);
      // A client that reads format 1 alone refuses the file as a later format.
      assert.equal(metadata["dfo.format_version"], "2");
      const ref = JSON.parse(metadata["dfo.ref"]!) as { format_version: number };
      assert.equal(ref.format_version, 2);
      assert.ok(DatasetRef.fromJSON(ref).equals(dataset.ref));
      assert.deepEqual(JSON.parse(metadata["dfo.left_out"]!), {
        series: (await recordedJson("analysis-chain-manifest.json"))["left_out"],
        complete,
      });
      assert.deepEqual(JSON.parse(metadata["dfo.steps"]!), [
        { verb: "quotient_of", by: ["financingRecipient"], limit: null },
        { verb: "growth", by: ["financingRecipient"], limit: null },
      ]);
    });
  }

  test("ignores keys a manifest's left-out series add", async () => {
    const manifest = await recordedJson<{ left_out: Record<string, Record<string, unknown>>[] }>(
      "analysis-chain-manifest.json",
    );
    const added = manifest.left_out.map((series) => ({
      ...series,
      unit: "USDollar",
      step: { ...series["step"], op_id: "op_1" },
    }));
    const plain = await derived();
    const extended = await derived("chain", { left_out: added });
    assert.deepEqual(
      extended.leftOut.map((series) => String(series)),
      plain.leftOut.map((series) => String(series)),
    );
    assert.deepEqual(
      extended.leftOut.map(({ step }) => ({ ...step })),
      plain.leftOut.map(({ step }) => ({ ...step })),
    );
  });

  test("lists a compare's primary input's steps first", async () => {
    const step = (verb: string, parameters: Record<string, unknown>, inputs = {}) => ({
      op_spec: { verb, parameters },
      inputs,
    });
    // Compare reads `data`, its primary input, as the right frame.
    const tree = step(
      "compare",
      {},
      {
        frame_ref: step("rank", { rank_by: ["financingSource"], limit: 5 }),
        right_frame_ref: step("growth", { entity_by: ["financingSource"] }),
      },
    );
    const metadata = await savedMetadata(await derived("chain", { recipe: { tree } }));
    assert.deepEqual(
      (JSON.parse(metadata["dfo.steps"]!) as { verb: string }[]).map(({ verb }) => verb),
      ["growth", "rank", "compare"],
    );
  });

  test("reads a manifest without left_out as none left out", async () => {
    const dataset = await derived("chain", {
      left_out: null,
      left_out_complete: null,
      recipe: null,
    });
    assert.deepEqual(dataset.leftOut, []);
    assert.ok(String(dataset).split("\n").includes("  Derived: from 2 readings"));
    const metadata = await savedMetadata(dataset);
    assert.deepEqual(JSON.parse(metadata["dfo.left_out"]!), { series: [], complete: true });
  });

  for (const [name, change, pointer] of [
    ["another frame", { content_version: `ocv_${"0".repeat(32)}` }, null],
    ["left_out not a list", { left_out: {} }, "/left_out"],
    ["a series damaged", { left_out: [{ step: {} }] }, "/left_out/0/coordinates"],
    [
      "a node as text",
      {
        left_out: [
          { coordinates: {}, step: { verb: "s", node: "0" }, side: "data", reason: "r", rows: 1 },
        ],
      },
      "/left_out/0/step/node",
    ],
    [
      "a node below 0",
      {
        left_out: [
          { coordinates: {}, step: { verb: "s", node: -1 }, side: "data", reason: "r", rows: 1 },
        ],
      },
      "/left_out/0/step/node",
    ],
    ["left_out_complete null", { left_out_complete: null }, "/left_out_complete"],
  ] as const) {
    test(`refuses a manifest with ${name}`, async () => {
      await assert.rejects(derived("chain", change), {
        name: "ContractError",
        code: "contract_violation",
        pointer,
      });
    });
  }
});

describe("a dataset of dataset versions", () => {
  test("leaves nothing out and writes no derived key", async () => {
    const data = await scenarioBytes("fetch-ref.parquet");
    const dataset = await Dataset.create([member(data)], { layout: "long" });
    assert.deepEqual(dataset.leftOut, []);
    const metadata = await savedMetadata(dataset);
    assert.equal(metadata["dfo.format_version"], "1");
    assert.equal(metadata["dfo.left_out"], undefined);
    assert.equal(metadata["dfo.steps"], undefined);
    assert.ok(!String(dataset).includes("Derived:"));
  });
});

describe("party totals left out", () => {
  test("a fetch names the totals its cut left out and writes them under a key of their own", async () => {
    const record = await scenario("fetch-spec-party-totals-left-out");
    const { spec, window, entities } = stepOf(record, 0, "fetch");
    assert.ok(spec);
    const client = clientOver(replay(record).transport);
    const dataset = await client.fetch(spec, { window, entities });
    const trace = (record.exchanges[0]!.response.json as Record<string, unknown>)["trace"] as {
      party_totals_left_out: { role: string; entities: string[] }[];
    };
    const [served] = trace.party_totals_left_out;
    assert.ok(served !== undefined && !("provenance" in served));
    assert.deepEqual(dataset.partyTotalsLeftOut, [
      {
        specId: dataset.members[0]!.spec.spec_id,
        role: "financingProvider",
        entities: served.entities,
        provenance: null,
        everyProvenance: true,
      },
    ]);
    assert.ok(
      String(dataset)
        .split("\n")
        .includes(
          `  Party totals left out: ${served.entities.length} on financingProvider · ` +
            "data.partyTotalsLeftOut",
        ),
    );
    const metadata = await savedMetadata(dataset);
    assert.deepEqual(JSON.parse(metadata["dfo.party_totals_left_out"]!), [
      { spec_id: dataset.members[0]!.spec.spec_id, ...served },
    ]);
    // Python 0.1.0 refuses a `dfo.dataset` key it does not know.
    assert.deepEqual(Object.keys(JSON.parse(metadata["dfo.dataset"]!) as object).toSorted(), [
      "assumptions",
      "complete",
      "departures",
      "held_until",
      "layout_version",
      "member_citations",
      "member_rows",
      "missing",
      "pinned",
      "requested_operations",
      "stale",
      "warnings",
    ]);
  });

  for (const [name, served, provenance, everyProvenance] of [
    ["a named provenance", { provenance: "provenance/OECD_DAC2a" }, "provenance/OECD_DAC2a", false],
    ["rows without provenance", { provenance: null }, null, false],
    ["every provenance", {}, null, true],
  ] as const) {
    test(`keeps ${name} through toBytes()`, async () => {
      const entry = { role: "financingRecipient", entities: ["AfricaTotal"], ...served };
      const data = await scenarioBytes("fetch-ref.parquet");
      const manifest = { trace: { party_totals_left_out: [entry], other: 1 } };
      const dataset = await Dataset.create([member(data, { manifest })], { layout: "long" });
      const [read] = dataset.partyTotalsLeftOut;
      assert.deepEqual([read?.provenance, read?.everyProvenance], [provenance, everyProvenance]);
      const metadata = await savedMetadata(dataset);
      assert.deepEqual(JSON.parse(metadata["dfo.party_totals_left_out"]!), [
        { spec_id: dataset.members[0]!.spec.spec_id, ...entry },
      ]);
    });
  }

  test("a dataset with none left out writes no key and no line", async () => {
    const data = await scenarioBytes("fetch-ref.parquet");
    const dataset = await Dataset.create([member(data)], { layout: "long" });
    assert.deepEqual(dataset.partyTotalsLeftOut, []);
    assert.ok(!String(dataset).includes("Party totals"));
    assert.equal((await savedMetadata(dataset))["dfo.party_totals_left_out"], undefined);
  });

  for (const [trace, pointer] of [
    [[], "/trace"],
    [{ party_totals_left_out: {} }, "/trace/party_totals_left_out"],
    [{ party_totals_left_out: [[]] }, "/trace/party_totals_left_out/0"],
    [{ party_totals_left_out: [{ entities: [] }] }, "/trace/party_totals_left_out/0/role"],
    [
      { party_totals_left_out: [{ role: "financingProvider" }] },
      "/trace/party_totals_left_out/0/entities",
    ],
    [
      { party_totals_left_out: [{ role: "financingProvider", entities: [1] }] },
      "/trace/party_totals_left_out/0/entities/0",
    ],
    [
      { party_totals_left_out: [{ role: "financingProvider", entities: [], provenance: 2 }] },
      "/trace/party_totals_left_out/0/provenance",
    ],
  ] as const) {
    test(`a trace broken at ${pointer} raises ContractError`, async () => {
      const data = await scenarioBytes("fetch-ref.parquet");
      await assert.rejects(
        Dataset.create([member(data, { manifest: { trace } })], { layout: "long" }),
        { name: "ContractError", code: "contract_violation", pointer },
      );
    });
  }
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
    Dataset.create(
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
    const dataset = await stacked();
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
    const reread = await Dataset.create([member(await dataset.toBytes())], { layout: "long" });
    assert.deepEqual(await reread.toRows(), await dataset.toRows());
    const stored = await decodeStored(datasetTable(reread));
    const typed = (columns: readonly { name: string; type: unknown }[]) =>
      columns
        .map(({ name, type }) => ({ name, type }))
        .toSorted((a, b) => (a.name < b.name ? -1 : 1));
    assert.deepEqual(typed(stored), typed(await decodeStored(datasetTable(dataset))));
    assert.deepEqual(stored.find((column) => column.name === "at")?.values, [
      1_000_000n,
      2_000_000n,
    ]);
  });

  test("read, stack, convert and save list and struct columns, their items widened", async () => {
    const nested = (item: "INT32" | "INT64", tags: unknown[], meta: unknown[]) =>
      new Uint8Array(
        parquetWriteBuffer({
          columnData: [
            { name: "tags", data: tags },
            { name: "meta", data: meta },
          ],
          schema: [
            { name: "root", num_children: 2 },
            { name: "tags", repetition_type: "OPTIONAL", converted_type: "LIST", num_children: 1 },
            { name: "list", repetition_type: "REPEATED", num_children: 1 },
            { name: "element", repetition_type: "OPTIONAL", type: item },
            { name: "meta", repetition_type: "OPTIONAL", num_children: 2 },
            { name: "share", repetition_type: "OPTIONAL", type: "DOUBLE" },
            {
              name: "label",
              repetition_type: "OPTIONAL",
              type: "BYTE_ARRAY",
              converted_type: "UTF8",
            },
          ],
        }),
      );
    const dataset = await Dataset.create(
      [
        member(nested("INT32", [[1, null], null], [{ share: 0.5, label: "a" }, null]), {
          parts: ["one"],
        }),
        member(nested("INT64", [[3n]], [{ share: null, label: "b" }]), {
          parts: ["two"],
          spec: { spec_id: "s2", definition: {} },
        }),
      ],
      { layout: "long" },
    );
    const rows = [
      { part: "one", tags: [1, null], meta: { share: 0.5, label: "a" } },
      { part: "one", tags: null, meta: null },
      { part: "two", tags: [3], meta: { share: null, label: "b" } },
    ];
    assert.deepEqual(await dataset.toRows(), rows);
    const table = await toArrow(dataset);
    assert.equal(String(table.getChild("tags")?.type), "List<Int64>");
    assert.equal(String(table.getChild("meta")?.type), "Struct<{share:Float64, label:Utf8}>");
    assert.deepEqual(
      table
        .toArray()
        .map((row): unknown =>
          JSON.parse(
            JSON.stringify(row, (_, value: unknown) =>
              typeof value === "bigint" ? Number(value) : value,
            ),
          ),
        ),
      rows,
    );
    const reread = await Dataset.create([member(await dataset.toBytes())], { layout: "long" });
    assert.deepEqual(await reread.toRows(), rows);
  });

  test("stack struct columns by field name, a field one member lacks null", async () => {
    const struct = (
      fields: [string, "BYTE_ARRAY" | "DOUBLE" | "INT64" | "BOOLEAN"][],
      cell: unknown,
    ) =>
      new Uint8Array(
        parquetWriteBuffer({
          columnData: [{ name: "s", data: [cell] }],
          schema: [
            { name: "root", num_children: 1 },
            { name: "s", repetition_type: "OPTIONAL", num_children: fields.length },
            ...fields.map(([name, type]) => ({
              name,
              repetition_type: "OPTIONAL" as const,
              type,
              ...(type === "BYTE_ARRAY" ? { converted_type: "UTF8" as const } : {}),
            })),
          ],
        }),
      );
    // As Python's test_struct_columns_stack_by_field_name, through pyarrow's promotion.
    const dataset = await Dataset.create(
      [
        member(
          struct(
            [
              ["b", "BYTE_ARRAY"],
              ["a", "INT64"],
            ],
            { b: "x", a: 1n },
          ),
          {
            parts: ["one"],
          },
        ),
        member(
          struct(
            [
              ["a", "DOUBLE"],
              ["c", "BOOLEAN"],
            ],
            { a: 2.5, c: true },
          ),
          {
            parts: ["two"],
            spec: { spec_id: "s2", definition: {} },
          },
        ),
      ],
      { layout: "long" },
    );
    const table = await toArrow(dataset);
    assert.equal(String(table.getChild("s")?.type), "Struct<{b:Utf8, a:Float64, c:Bool}>");
    assert.deepEqual(
      (await dataset.toRows()).map(({ s }) => s),
      [
        { b: "x", a: 1, c: null },
        { b: null, a: 2.5, c: true },
      ],
    );
  });

  test("convert a nested timestamp to Arrow in its stored unit", async () => {
    const data = new Uint8Array(
      parquetWriteBuffer({
        columnData: [{ name: "at", data: [[1_000_001n]] }],
        schema: [
          { name: "root", num_children: 1 },
          { name: "at", repetition_type: "OPTIONAL", converted_type: "LIST", num_children: 1 },
          { name: "list", repetition_type: "REPEATED", num_children: 1 },
          {
            name: "element",
            repetition_type: "OPTIONAL",
            type: "INT64",
            logical_type: { type: "TIMESTAMP", isAdjustedToUTC: true, unit: "MICROS" },
          },
        ],
      }),
    );
    const table = await toArrow(await Dataset.create([member(data)], { layout: "long" }));
    const at = table.getChild("at");
    assert.equal(String(at?.type), "List<Timestamp<MICROSECOND, UTC>>");
    assert.deepEqual(at?.data[0]?.children[0]?.values, BigInt64Array.from([1_000_001n]));
  });

  test("raise ContractError when a column's types do not widen to one", async () => {
    const flag = file({ year: { type: "BOOLEAN", data: [true] } });
    const year = file({ year: { type: "INT32", data: [2020] } });
    await assert.rejects(
      () =>
        Dataset.create([member(flag), member(year, { spec: { spec_id: "s2", definition: {} } })], {
          layout: "long",
        }),
      { name: "ContractError", code: "contract_violation" },
    );
  });

  for (const [name, data, schema] of [
    [
      "a BSON column",
      [new Uint8Array([0])],
      [{ name: "x", repetition_type: "OPTIONAL", type: "BYTE_ARRAY", converted_type: "BSON" }],
    ],
    [
      "a MAP column",
      [{ k: 1n }],
      [
        { name: "x", repetition_type: "OPTIONAL", converted_type: "MAP", num_children: 1 },
        { name: "key_value", repetition_type: "REPEATED", num_children: 2 },
        { name: "key", repetition_type: "REQUIRED", type: "BYTE_ARRAY", converted_type: "UTF8" },
        { name: "value", repetition_type: "OPTIONAL", type: "INT64" },
      ],
    ],
    [
      "a list of maps",
      [[{ k: 1n }]],
      [
        { name: "x", repetition_type: "OPTIONAL", converted_type: "LIST", num_children: 1 },
        { name: "list", repetition_type: "REPEATED", num_children: 1 },
        { name: "element", repetition_type: "OPTIONAL", converted_type: "MAP", num_children: 1 },
        { name: "key_value", repetition_type: "REPEATED", num_children: 2 },
        { name: "key", repetition_type: "REQUIRED", type: "BYTE_ARRAY", converted_type: "UTF8" },
        { name: "value", repetition_type: "OPTIONAL", type: "INT64" },
      ],
    ],
    [
      "a struct that names a field twice",
      [{ a: 1 }],
      [
        { name: "x", repetition_type: "OPTIONAL", num_children: 2 },
        { name: "a", repetition_type: "OPTIONAL", type: "INT32" },
        { name: "a", repetition_type: "OPTIONAL", type: "INT32" },
      ],
    ],
    // Parquet's backward-compatibility rules make each repeated group below the element, a
    // struct, where hyparquet assembles its one field's values.
    ...(["array", "x_tuple"] as const).map(
      (repeated) =>
        [
          `a legacy list whose repeated group is named ${repeated}`,
          [[1]],
          [
            { name: "x", repetition_type: "OPTIONAL", converted_type: "LIST", num_children: 1 },
            { name: repeated, repetition_type: "REPEATED", num_children: 1 },
            { name: "a", repetition_type: "OPTIONAL", type: "INT32" },
          ],
        ] as const,
    ),
  ] as const) {
    test(`raise ContractError for ${name}, which the client cannot read`, async () => {
      const unreadable = new Uint8Array(
        parquetWriteBuffer({
          columnData: [{ name: "x", data: [...data] }],
          schema: [{ name: "root", num_children: 1 }, ...schema],
        }),
      );
      await assert.rejects(() => Dataset.create([member(unreadable)], { layout: "long" }), {
        name: "ContractError",
        code: "contract_violation",
      });
    });
  }

  test("raise ContractError when a member's file holds its own part column", async () => {
    const own = file({ part: { type: "BYTE_ARRAY", logical: { type: "STRING" }, data: ["x"] } });
    const year = file({ year: { type: "INT32", data: [2020] } });
    await assert.rejects(
      () =>
        Dataset.create([member(year), member(own, { spec: { spec_id: "s2", definition: {} } })], {
          layout: "long",
        }),
      { name: "ContractError", code: "contract_violation" },
    );
    // One member is not stacked, so its own part column is its data, ordered as any column.
    assert.deepEqual((await Dataset.create([member(own)], { layout: "long" })).columns, ["part"]);
    const labelled = file({
      year: { type: "INT32", data: [2022, 2020, 2021] },
      part: { type: "BYTE_ARRAY", logical: { type: "STRING" }, data: ["b", "a", "b"] },
    });
    const alone = await Dataset.create([member(labelled)], { layout: "long" });
    assert.deepEqual(alone.columns, ["year", "part"]);
    assert.deepEqual(await alone.toRows(), [
      { year: 2020, part: "a" },
      { year: 2021, part: "b" },
      { year: 2022, part: "b" },
    ]);
  });

  test("stacks UINT32 with INT64, converts it to INT64, and saves the widened table", async () => {
    const unsigned = file({ count: { type: "INT32", converted: "UINT_32", data: [2 ** 32 - 1] } });
    const signed = file({ count: { type: "INT64", data: [-1n] } });
    const dataset = await Dataset.create(
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
    const saved = readSaved(await dataset.toBytes());
    assert.deepEqual(await saved.rows(), await dataset.toRows());
  });

  test("members that share a label keep their own rows, also in the saved file", async () => {
    // Sorting across the two members, as reading them by label would, moves 2021 first.
    const first = file({ year: { type: "INT32", data: [2024, 2022] } });
    const second = file({ year: { type: "INT32", data: [2023, 2021] } });
    const dataset = await Dataset.create(
      [
        member(first, { parts: ["aid"] }),
        member(second, { parts: ["aid"], spec: { spec_id: "s2", definition: {} } }),
      ],
      { layout: "long" },
    );
    const rows = [2022, 2024, 2021, 2023].map((year) => ({ part: "aid", year }));
    assert.deepEqual(await dataset.toRows(), rows);
    const saved = readSaved(await dataset.toBytes());
    assert.deepEqual(await saved.rows(), rows);
    assert.deepEqual(saved.memberRows, [2, 2]);
  });

  test("refuses UINT64 with a signed member while accepting UINT64 alone", async () => {
    const unsigned = file({ count: { type: "INT64", converted: "UINT_64", data: [1n] } });
    const signed = file({ count: { type: "INT64", data: [-1n] } });
    assert.deepEqual((await Dataset.create([member(unsigned)], { layout: "long" })).columns, [
      "count",
    ]);
    await assert.rejects(
      () =>
        Dataset.create(
          [member(unsigned), member(signed, { spec: { spec_id: "s2", definition: {} } })],
          { layout: "long" },
        ),
      { name: "ContractError", code: "contract_violation" },
    );
  });

  test("preserves the UINT64 maximum through Arrow conversion and save", async () => {
    const maximum = (1n << 64n) - 1n;
    const unsigned = file({ count: { type: "INT64", converted: "UINT_64", data: [maximum] } });
    const dataset = await Dataset.create([member(unsigned)], { layout: "long" });
    assert.equal((await toArrow(dataset)).getChild("count")?.get(0), maximum);
    const saved = await Dataset.create([member(await dataset.toBytes())], { layout: "long" });
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
