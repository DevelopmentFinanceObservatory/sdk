import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, mock, test } from "node:test";

import { parquetMetadata } from "hyparquet";
import type { FileMetaData } from "hyparquet";
import { ByteWriter, parquetWriteBuffer } from "hyparquet-writer";
import { writeMetadata } from "hyparquet-writer/src/metadata.js";

import { clientOver } from "../src/client.ts";
import { InvalidRequestError } from "../src/core/errors.ts";
import { FormatError, isDerived } from "../src/core/ref.ts";
import { toArrow } from "../src/datasets/arrow.ts";
import { Dataset, datasetTable } from "../src/datasets/dataset.ts";
import type { FetchedMember } from "../src/datasets/dataset.ts";
import { derivedDataset } from "../src/datasets/derived.ts";
import { installFileReader, load } from "../src/datasets/load.ts";
import { decodeStored } from "../src/datasets/parquet.ts";
import { BundleError } from "../src/datasets/saved.ts";
import { readDatasetFile, writeDatasetFile } from "../src/datasets/save-node.ts";
import { installFileWriter } from "../src/datasets/save.ts";
import { DatasetRef } from "../src/core/ref.ts";
import { replay, scenario, scenarioBytes, stepOf } from "./replay.ts";
import { contractJson, recordedBytes, recordedJson } from "./support.ts";

type SavedExample = {
  name: string;
  metadata: Record<string, string>;
  expect?: "accept";
  error?: { by: "schema" } | { by: "rule"; reason: string };
};

/** The example's metadata as the key-value metadata of a Parquet file whose rows match its
 *  `member_rows`, as Python's contract test builds it. The Arrow schema key is the writer's. */
function exampleFile({ metadata }: SavedExample): Uint8Array {
  const rows = memberRowsIn(metadata["dfo.dataset"]).reduce((sum, count) => sum + count, 0);
  return new Uint8Array(
    parquetWriteBuffer({
      columnData: [{ name: "value", data: Array.from({ length: rows }, (_, at) => BigInt(at)) }],
      schema: [
        { name: "root", num_children: 1 },
        { name: "value", type: "INT64", repetition_type: "OPTIONAL" },
      ],
      kvMetadata: Object.entries(metadata)
        .filter(([key]) => key !== "ARROW:schema")
        .map(([key, value]) => ({ key, value })),
    }),
  );
}

/** The row counts a `dfo.dataset` value names, or none when it names none it can. */
function memberRowsIn(text: string | undefined): number[] {
  try {
    const counts = (JSON.parse(text ?? "") as { member_rows?: unknown }).member_rows;
    return Array.isArray(counts) ? counts.filter((count) => typeof count === "number") : [];
  } catch {
    return [];
  }
}

const examples = async (): Promise<SavedExample[]> => {
  const names = (await readdir(new URL("../../contract/saved-files/", import.meta.url))).filter(
    (name) => name.endsWith(".json"),
  );
  assert.ok(names.length > 0, "the contract holds no saved-file examples");
  return Promise.all(names.map((name) => contractJson<SavedExample>(`saved-files/${name}`)));
};

/** A Parquet file of `metadata` alone, its footer and no pages. */
function footerOnly(metadata: FileMetaData): Uint8Array {
  const writer = new ByteWriter();
  writer.appendUint32(0x31524150);
  writeMetadata(writer, metadata);
  writer.appendUint32(0x31524150);
  return new Uint8Array(writer.getBuffer());
}

/** `bytes` with its footer rewritten by `change`, its pages as they stand. */
function withFooter(
  bytes: Uint8Array,
  change: (metadata: FileMetaData) => FileMetaData,
): Uint8Array {
  const metadata = parquetMetadata(bytes.slice().buffer);
  const pages = bytes.subarray(0, bytes.length - 8 - metadata.metadata_length);
  const footer = footerOnly(change(metadata)).subarray(4);
  const rewritten = new Uint8Array(pages.length + footer.length);
  rewritten.set(pages);
  rewritten.set(footer, pages.length);
  return rewritten;
}

/** A saved file's `dfo.*` metadata. */
const metadataOf = (bytes: Uint8Array): Record<string, string | undefined> =>
  Object.fromEntries(
    (parquetMetadata(bytes.slice().buffer).key_value_metadata ?? []).map(({ key, value }) => [
      key,
      value,
    ]),
  );

describe("the contract's saved-file examples", async () => {
  for (const example of await examples()) {
    test(example.name, async () => {
      const content = exampleFile(example);
      if (example.expect === "accept") {
        const loaded = await Dataset.fromBytes(content);
        assert.equal(loaded.sentence, example.metadata["dfo.sentence"]);
        // The loader gives an accepted file's entries as its report, entry for entry and in
        // order, so writing the dataset again writes them unchanged.
        const written = metadataOf(await loaded.toBytes());
        assert.deepEqual(
          JSON.parse(written["dfo.party_totals_left_out"] ?? "[]"),
          JSON.parse(example.metadata["dfo.party_totals_left_out"] ?? "[]"),
        );
        // The retention the file states, with or without `dfo.retention`.
        const stated = JSON.parse(example.metadata["dfo.dataset"]!) as {
          pinned: boolean;
          held_until: string | null;
        };
        assert.deepEqual(
          [loaded.pinned, loaded.heldUntil?.toISOString().slice(0, 10) ?? null],
          [stated.pinned, stated.held_until],
        );
        return;
      }
      await assert.rejects(Dataset.fromBytes(content), (error: unknown) => {
        assert.ok(error instanceof FormatError, String(error));
        if (example.error?.by === "rule") assert.equal(error.reason, example.error.reason);
        return true;
      });
    });
  }
});

const digestOf = (data: Uint8Array): string =>
  `sha256:${createHash("sha256").update(data).digest("hex")}`;

/** The recorded rank, its tree's step split per destination. */
async function partitionedRank(): Promise<Dataset> {
  const { ref } = await recordedJson<{ ref: unknown }>("analysis-rank-ready.json");
  const [member] = DatasetRef.fromJSON(ref).members;
  assert.ok(member && isDerived(member));
  const manifest = await recordedJson<{ recipe: { tree: { op_spec: { parameters: object } } } }>(
    "analysis-rank-manifest.json",
  );
  manifest.recipe.tree.op_spec.parameters = {
    ...manifest.recipe.tree.op_spec.parameters,
    partition_by: ["destination"],
  };
  const data = await recordedBytes("analysis-rank-frame.parquet");
  return (await derivedDataset(member, manifest, data)).dataset;
}

/** The datasets a round trip starts from: two members stacked from an answer, a partial answer
 *  with a part left out, a derived frame, and pyarrow's types in one member. */
const sources: Record<string, () => Promise<Dataset>> = {
  "two members of an answer": async () => {
    const record = await scenario("answer-several-readings-folded");
    const answer = await clientOver(replay(record).transport).search(
      stepOf(record, 0, "search").question,
    );
    return answer.fetch();
  },
  "a partial answer": async () => {
    const record = await scenario("answer-mixed-fetch-partial");
    const answer = await clientOver(replay(record).transport).search(
      stepOf(record, 0, "search").question,
    );
    return answer.fetch({ partial: true });
  },
  "a derived frame": async () => {
    const { ref } = await recordedJson<{ ref: unknown }>("analysis-chain-ready.json");
    const [member] = DatasetRef.fromJSON(ref).members;
    assert.ok(member && isDerived(member));
    const manifest = await recordedJson("analysis-chain-manifest.json");
    const data = await recordedBytes("analysis-chain-frame.parquet");
    return (await derivedDataset(member, manifest, data)).dataset;
  },
  "a rank split per destination": partitionedRank,
  "every Parquet type": async () => {
    // Written by pyarrow: int64, uint8, float64, bool, string, timestamp, date32, decimal,
    // binary and null columns, each with a null.
    const data = new Uint8Array(await readFile(new URL("data/types.parquet", import.meta.url)));
    const specId = `spec_${"0".repeat(32)}`;
    const member: FetchedMember = {
      parts: [],
      spec: { spec_id: specId, definition: { schema_version: 1, spec_id: specId, identity: {} } },
      sentence: "A sentence.",
      contentVersion: `cv_${"0".repeat(32)}`,
      manifest: {},
      digest: digestOf(data),
      rendering: { format: "parquet", bundle: false },
      data,
    };
    return Dataset.create([member], { layout: "long" });
  },
};

describe("Dataset.fromBytes reads back the file toBytes() writes", () => {
  for (const [name, source] of Object.entries(sources)) {
    test(name, async () => {
      const data = await source();
      const bytes = await data.toBytes();
      const loaded = await Dataset.fromBytes(bytes);
      assert.deepEqual(loaded.provenance.toJSON(), data.provenance.toJSON());
      assert.ok(loaded.provenance.equals(data.provenance));
      assert.deepEqual(loaded.ref.toJSON(), data.ref.toJSON());
      assert.deepEqual(loaded.columns, data.columns);
      assert.equal(loaded.rowCount, data.rowCount);
      // The file holds its rows in reading order, so the loaded table keeps no row index.
      assert.deepEqual(datasetTable(loaded).order.rows, { kind: "range", length: data.rowCount });
      assert.deepEqual(
        await decodeStored(datasetTable(loaded)),
        await decodeStored(datasetTable(data)),
      );
      assert.equal(String(loaded), String(data));
      assert.deepEqual(
        [loaded.layout, loaded.complete, loaded.missing.length, loaded.partyTotalsLeftOut],
        [data.layout, data.complete, data.missing.length, data.partyTotalsLeftOut],
      );
      // Every fact the file holds survives, so the loaded dataset writes the same file again.
      assert.deepEqual(await loaded.toBytes(), bytes);
    });
  }

  test("the rows and the Arrow table of a loaded dataset match the fetched one's", async () => {
    const data = await sources["two members of an answer"]!();
    const loaded = await Dataset.fromBytes((await data.toBytes()).buffer as ArrayBuffer);
    assert.deepEqual(await loaded.toRows(), await data.toRows());
    const [table, fetched] = [await toArrow(loaded), await toArrow(data)];
    assert.deepEqual(
      table.schema.fields.map((field) => `${field.name}: ${String(field.type)}`),
      fetched.schema.fields.map((field) => `${field.name}: ${String(field.type)}`),
    );
    assert.equal(table.numRows, fetched.numRows);
    assert.deepEqual(loaded.missing, data.missing);
  });

  test("a loaded dataset has no member's own file", async () => {
    const loaded = await Dataset.fromBytes(await (await sources["a derived frame"]!()).toBytes());
    assert.throws(
      () => loaded.memberBytes(0),
      (error: unknown) => error instanceof InvalidRequestError && error.code === "invalid_argument",
    );
  });

  test("a file that names no version loads with no ref", async () => {
    const minimal = (await examples()).find(({ name }) => name === "saved-minimal");
    assert.ok(minimal);
    const loaded = await Dataset.fromBytes(exampleFile(minimal));
    assert.deepEqual([loaded.members, loaded.fetchedAt, loaded.provenance.ref], [[], null, null]);
    assert.throws(
      () => loaded.ref,
      (error: unknown) => error instanceof InvalidRequestError && error.code === "ref_unavailable",
    );
    assert.equal(String(loaded), "<Dataset Bundle.\n  Rows: 0\n  Keep: await data.toBytes()>");
  });
});

describe("the format a step's per needs", () => {
  /** `bytes` with its `dfo.steps` and format version set. */
  const rewritten = (bytes: Uint8Array, version: string, steps: unknown): Uint8Array =>
    withFooter(bytes, (metadata) => ({
      ...metadata,
      key_value_metadata: (metadata.key_value_metadata ?? []).map((entry) =>
        entry.key === "dfo.steps"
          ? { key: entry.key, value: JSON.stringify(steps) }
          : entry.key === "dfo.format_version"
            ? { key: entry.key, value: version }
            : entry,
      ),
    }));
  const step = { verb: "rank", by: ["financingRecipient"], limit: 2 };

  test("a partitioned rank writes format 3 and a rank without per writes format 2", async () => {
    const written = metadataOf(await (await partitionedRank()).toBytes());
    assert.equal(written["dfo.format_version"], "3");
    assert.deepEqual(JSON.parse(written["dfo.steps"]!), [{ ...step, per: ["destination"] }]);
    const plain = metadataOf(await (await sources["a derived frame"]!()).toBytes());
    assert.equal(plain["dfo.format_version"], "2");
  });

  test("a loaded partitioned rank prints its per", async () => {
    const loaded = await Dataset.fromBytes(await (await partitionedRank()).toBytes());
    assert.match(
      String(loaded),
      /Derived: rank by financingRecipient per destination, limit 2, from 1 reading/,
    );
  });

  const cases: [string, string, unknown, RegExp][] = [
    ["a format 2 file with per", "2", [{ ...step, per: ["destination"] }], /dfo\.steps\/0\/per/],
    ["an empty per", "3", [{ ...step, per: [] }], /dfo\.steps\/0\/per/],
    ["a repeated column", "3", [{ ...step, per: ["a", "a"] }], /dfo\.steps\/0\/per/],
    ["a column by names", "3", [{ ...step, per: ["financingRecipient"] }], /dfo\.steps\/0\/per/],
    [
      "per on another verb",
      "3",
      [{ ...step, verb: "growth", per: ["destination"] }],
      /dfo\.steps\/0\/per/,
    ],
  ];
  for (const [name, version, steps, pointer] of cases) {
    test(`refuses ${name}`, async () => {
      const bytes = await (await partitionedRank()).toBytes();
      await assert.rejects(
        Dataset.fromBytes(rewritten(bytes, version, steps)),
        (error: unknown) => {
          assert.ok(error instanceof FormatError, String(error));
          assert.match(error.message, pointer);
          return true;
        },
      );
    });
  }
});

describe("Dataset.fromBytes refuses what holds no saved dataset", () => {
  const refused = async (bytes: unknown, code: string) => {
    await assert.rejects(Dataset.fromBytes(bytes as Uint8Array), (error: unknown) => {
      assert.ok(
        code === "not_a_bundle"
          ? error instanceof BundleError
          : error instanceof InvalidRequestError,
        String(error),
      );
      assert.equal((error as BundleError).code, code);
      return true;
    });
  };

  test("bytes that are no Parquet file", async () => {
    await refused(new TextEncoder().encode("year,value\n2024,1\n"), "not_a_bundle");
  });

  test("a Parquet file without a saved dataset's keys, as a member's file from the server", async () => {
    await refused(await scenarioBytes("fetch-ref.parquet"), "not_a_bundle");
  });

  test("a damaged Parquet file", async () => {
    const bytes = await (await sources["two members of an answer"]!()).toBytes();
    await refused(bytes.slice(0, bytes.length / 2), "not_a_bundle");
    // The footer reads, and the pages it points at do not.
    const pages = bytes.slice();
    pages.fill(0xff, 4, 2000);
    await refused(pages, "not_a_bundle");
  });

  test("a footer that declares more rows than the file holds, before allocating for them", async () => {
    const minimal = (await examples()).find(({ name }) => name === "saved-minimal");
    assert.ok(minimal);
    // Three rows of the minimal example, which names no member, so any row count is its own.
    const file = new Uint8Array(
      parquetWriteBuffer({
        columnData: [{ name: "value", data: [1n, 2n, 3n], type: "INT64" }],
        kvMetadata: Object.entries(minimal.metadata).map(([key, value]) => ({ key, value })),
      }),
    );
    assert.equal((await Dataset.fromBytes(file)).rowCount, 3);
    const billion = 1_000_000_000n;
    const declaring = (rows: bigint) =>
      withFooter(file, (metadata) => ({
        ...metadata,
        num_rows: rows,
        row_groups: metadata.row_groups.map((group) => ({ ...group, num_rows: rows })),
      }));
    const declared: [Uint8Array, RegExp][] = [
      // 61 bytes of a later format version and no row group, declaring a billion rows.
      [
        footerOnly({
          version: 2,
          schema: [{ name: "root", num_children: 0 }],
          num_rows: billion,
          row_groups: [],
          key_value_metadata: [{ key: "dfo.format_version", value: "99" }],
          metadata_length: 0,
        }),
        /later client/,
      ],
      [
        withFooter(file, (metadata) => ({ ...metadata, num_rows: billion })),
        /declares 1000000000 rows and its row groups hold 3/,
      ],
      // Footer and row groups agree on a count past the rows this client loads.
      [declaring(billion), /more than the 16,777,216 the TypeScript client loads.*dfo\.load/],
      // Under that limit, and past what the file's few hundred bytes can hold.
      [declaring(16_000_000n), /declares 16000000 rows in \d+ bytes/],
    ];
    // The reader once built an index of one entry per declared row before checking anything.
    const from = Uint32Array.from.bind(Uint32Array);
    const spy = mock.method(Uint32Array, "from", (...args: [ArrayLike<number>, ...unknown[]]) => {
      const { length } = args[0];
      if (length > 1_000_000) assert.fail(`allocated an index of ${length} rows`);
      return Reflect.apply(from, undefined, args) as Uint32Array;
    });
    try {
      for (const [bytes, reason] of declared) {
        await assert.rejects(Dataset.fromBytes(bytes), (error: unknown) => {
          assert.ok(error instanceof BundleError || error instanceof FormatError, String(error));
          assert.match(error.message, reason);
          return true;
        });
      }
    } finally {
      spy.mock.restore();
    }
  });

  test("a value that is no bytes", async () => {
    await refused("PAR1", "invalid_argument");
    await refused(null, "invalid_argument");
  });
});

describe("load(path)", () => {
  test("reads the file data.save(path) writes, on Node", async () => {
    installFileWriter(writeDatasetFile);
    installFileReader(readDatasetFile);
    const folder = await mkdtemp(join(tmpdir(), "dfo-load-"));
    try {
      const data = await sources["two members of an answer"]!();
      const path = join(folder, "data.parquet");
      await data.save(path);
      const loaded = await load(path);
      assert.deepEqual(loaded.provenance.toJSON(), data.provenance.toJSON());
      assert.ok(loaded.provenance.equals(data.provenance));
      assert.deepEqual(await loaded.toBytes(), await data.toBytes());
    } finally {
      await rm(folder, { recursive: true, force: true });
      installFileWriter(undefined);
      installFileReader(undefined);
    }
  });

  test("refuses a file that is no Parquet file, such as a website bundle, naming its path", async () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    installFileReader(() => Promise.resolve(zip));
    const refusal = async (read: Promise<unknown>) => {
      try {
        await read;
      } catch (error) {
        assert.ok(error instanceof BundleError);
        assert.equal(error.code, "not_a_bundle");
        return error.message;
      }
      assert.fail("read a file that is no Parquet file");
    };
    try {
      const named = await refusal(load("bundle.zip"));
      const unnamed = await refusal(Dataset.fromBytes(zip));
      assert.match(named, /^bundle\.zip is not a Parquet file\./);
      assert.match(unnamed, /^The bytes are not a Parquet file\./);
      // Both name the Python client's dfo.load for a website bundle, in one wording.
      assert.match(named, /dfo\.load\(path\)/);
      assert.equal(
        named.replace(/^.*? not a Parquet file/, ""),
        unnamed.replace(/^.*? not a Parquet file/, ""),
      );
    } finally {
      installFileReader(undefined);
    }
  });

  test("names Dataset.fromBytes where the runtime has no file system", async () => {
    await assert.rejects(load("data.parquet"), (error: unknown) => {
      assert.ok(error instanceof InvalidRequestError);
      assert.equal(error.code, "invalid_argument");
      assert.match(error.message, /Dataset\.fromBytes/);
      return true;
    });
  });
});

describe("a file Python wrote", () => {
  const folder = new URL("../../python/tests/data/", import.meta.url);

  test("reads with Python's provenance, rows split by member", async () => {
    const bytes = new Uint8Array(await readFile(new URL("saved-python.parquet", folder)));
    const stored: unknown = JSON.parse(
      await readFile(new URL("saved-python.provenance.json", folder), "utf8"),
    );
    const loaded = await Dataset.fromBytes(bytes);
    assert.deepEqual(loaded.provenance.toJSON(), stored);
    assert.ok(loaded.members.length > 1);
    // The `part` column runs member by member, as `member_rows` counts them.
    const memberRows = (JSON.parse(metadataOf(bytes)["dfo.dataset"]!) as { member_rows: number[] })
      .member_rows;
    const runs: number[] = [];
    let previous: unknown;
    for (const row of await loaded.toRows()) {
      if (runs.length === 0 || row["part"] !== previous) runs.push(0);
      runs[runs.length - 1]! += 1;
      previous = row["part"];
    }
    assert.deepEqual(runs, memberRows);
    assert.equal(loaded.columns[0], "part");
    assert.ok(String(loaded).startsWith(`<Dataset ${loaded.sentence}`));
  });
});
