import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { describe, test } from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";
import { parquetMetadata } from "hyparquet";

import { DatasetRef, FormatError, isDerived } from "../src/core/ref.ts";
import { Dataset, Provenance } from "../src/datasets/dataset.ts";
import type { FetchedMember, ProvenanceJson } from "../src/datasets/dataset.ts";
import { derivedDataset } from "../src/datasets/derived.ts";
import { scenarioBytes } from "./replay.ts";
import { contractJson, recordedBytes, recordedJson } from "./support.ts";

type ProvenanceRecord = {
  name: string;
  provenance: unknown;
  expect?: "accept";
  error?: { by: "schema" } | { by: "rule"; reason: string };
};

const records = async (): Promise<ProvenanceRecord[]> => {
  const names = (await readdir(new URL("../../contract/provenance/", import.meta.url))).filter(
    (name) => name.endsWith(".json"),
  );
  assert.ok(names.length > 0, "the contract holds no provenance records");
  return Promise.all(names.map((name) => contractJson<ProvenanceRecord>(`provenance/${name}`)));
};

/** The provenance schema, with the schemas it refers to by `$id`. */
async function validator(): Promise<(value: unknown) => boolean> {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  for (const name of ["dataset-ref.schema.json", "saved-file.schema.json"]) {
    ajv.addSchema(await contractJson<object>(name));
  }
  const validate = ajv.compile(await contractJson<object>("provenance.schema.json"));
  return (value) => {
    const valid = validate(value);
    assert.ok(valid, JSON.stringify(validate.errors));
    return valid;
  };
}

describe("the contract's provenance examples", async () => {
  for (const record of await records()) {
    test(record.name, () => {
      if (record.expect === "accept") {
        assert.deepEqual(Provenance.fromObject(record.provenance).toObject(), record.provenance);
        return;
      }
      assert.throws(
        () => Provenance.fromObject(record.provenance),
        (error: unknown) => {
          assert.ok(error instanceof FormatError);
          if (record.error?.by === "rule") assert.equal(error.reason, record.error.reason);
          return true;
        },
      );
    });
  }
});

const digestOf = (data: Uint8Array): string =>
  `sha256:${createHash("sha256").update(data).digest("hex")}`;

/** A dataset of two members, one answering a part, with retention and a question. */
async function twoMembers(): Promise<Dataset> {
  const data = await scenarioBytes("fetch-ref.parquet");
  const member = (index: number, manifest: Record<string, unknown>): FetchedMember => {
    const specId = `spec_${String(index).repeat(32)}`;
    return {
      parts: index === 1 ? ["aid"] : [],
      spec: { spec_id: specId, definition: { schema_version: 1, spec_id: specId, identity: {} } },
      sentence: `Sentence ${index}.`,
      contentVersion: `cv_${String(index).repeat(32)}`,
      manifest,
      digest: digestOf(data),
      rendering: { format: "parquet", bundle: false, without_party_totals: true },
      data,
    };
  };
  const citation = (label: string) => ({
    text: `${label} (2026)`,
    sources: [{ ref: `dc:${label}`, label, licence: "CC BY 4.0" }],
  });
  return Dataset.create(
    [
      member(1, {
        citation: citation("WDI"),
        retention: { pinned: false, held_until: "2026-11-27T00:00:00Z" },
        warnings: [{ code: "slot_defaulted", severity: "warn", message: "Every aid type." }],
      }),
      member(2, { citation: citation("CRS"), retention: { pinned: true } }),
    ],
    { layout: "long", question: "Aid to Nigeria", fetchedAt: new Date("2026-11-13T09:15:42Z") },
  );
}

async function derived(): Promise<Dataset> {
  const { ref } = await recordedJson<{ ref: unknown }>("analysis-chain-ready.json");
  const [member] = DatasetRef.fromJSON(ref).members;
  assert.ok(member && isDerived(member));
  const manifest = await recordedJson("analysis-chain-manifest.json");
  const data = await recordedBytes("analysis-chain-frame.parquet");
  return (await derivedDataset(member, manifest, data)).dataset;
}

const savedMetadata = async (dataset: Dataset): Promise<Record<string, string>> =>
  Object.fromEntries(
    (parquetMetadata((await dataset.toBytes()).slice().buffer).key_value_metadata ?? []).map(
      ({ key, value }) => [key, value ?? ""],
    ),
  );

/** The facts a saved file holds of a dataset, in the provenance record's shape. */
function provenanceOfFile(metadata: Record<string, string>): ProvenanceJson {
  const saved = JSON.parse(metadata["dfo.dataset"]!) as Record<string, unknown>;
  const ref = JSON.parse(metadata["dfo.ref"]!) as ProvenanceJson["ref"] & {};
  const citations = saved["member_citations"] as ProvenanceJson["members"][number]["citation"][];
  return {
    format_version: 1,
    sentence: metadata["dfo.sentence"]!,
    citation: JSON.parse(metadata["dfo.citation"]!) as ProvenanceJson["citation"],
    fetched_at: JSON.parse(metadata["dfo.fetched_at"]!) as string,
    question:
      metadata["dfo.question"] === undefined
        ? null
        : (JSON.parse(metadata["dfo.question"]) as string),
    ref,
    pinned: saved["pinned"] as boolean,
    held_until: saved["held_until"] as string | null,
    warnings: saved["warnings"] as ProvenanceJson["warnings"],
    members: ref.members.map((member, index) => ({
      spec_id: member.spec.spec_id,
      content_version: member.content_version,
      digest: member.artifact.digest,
      parts: member.parts,
      sentence: member.sentence,
      citation: citations[index]!,
    })),
  };
}

describe("a dataset's provenance", async () => {
  const valid = await validator();
  for (const [name, make] of [
    ["two members", twoMembers],
    ["a derived member", derived],
  ] as const) {
    test(`of ${name} meets the schema, reads back, and agrees with the saved file`, async () => {
      const dataset = await make();
      const record = dataset.provenance.toObject();
      valid(record);
      // A pipeline stores the record as JSON text and reads it back.
      const text = JSON.stringify(dataset.provenance);
      assert.equal(text, JSON.stringify(record));
      assert.deepEqual(Provenance.fromObject(JSON.parse(text)).toObject(), record);
      assert.deepEqual(provenanceOfFile(await savedMetadata(dataset)), record);
      assert.ok(dataset.provenance.ref?.equals(dataset.ref));
    });
  }

  test("names the earliest retention, the question and the fetch time", async () => {
    const record = (await twoMembers()).provenance.toObject();
    assert.equal(record.fetched_at, "2026-11-13T09:15:42Z");
    assert.equal(record.held_until, "2026-11-27");
    assert.equal(record.pinned, false);
    assert.equal(record.question, "Aid to Nigeria");
    assert.deepEqual(
      record.members.map((member) => member.parts),
      [["aid"], []],
    );
  });

  test("prints its sentence, members and fetch time", async () => {
    assert.equal(
      String((await twoMembers()).provenance),
      "Provenance(Sentence 1. Sentence 2., 2 members, fetched 13 November 2026 09:15 UTC)",
    );
  });
});

describe("Provenance.fromObject refuses", async () => {
  const record = (await twoMembers()).provenance.toObject();
  const [first, second] = record.members;
  for (const [name, value, pointer] of [
    ["JSON text", JSON.stringify(record), ""],
    ["a pinned flag that is not a boolean", { ...record, pinned: "no" }, "/pinned"],
    ["a fetch time in another form", { ...record, fetched_at: "13 November 2026" }, "/fetched_at"],
    ["a day that does not exist", { ...record, held_until: "2026-02-30" }, "/held_until"],
    ["a ref with no members", { ...record, ref: { ...record.ref, members: [] } }, "/ref/members"],
    [
      "a member that differs from its ref member",
      { ...record, members: [{ ...first!, parts: [] }, second] },
      "/members/0/parts",
    ],
  ] as const) {
    test(name, () => {
      assert.throws(
        () => Provenance.fromObject(value),
        (error: unknown) => {
          assert.ok(error instanceof FormatError);
          assert.equal(error.reason, "format_invalid");
          assert.equal(error.pointer, pointer);
          return true;
        },
      );
    });
  }
});
