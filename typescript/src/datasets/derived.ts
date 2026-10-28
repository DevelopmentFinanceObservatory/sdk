/**
 * Reading a derived frame's manifest: the series its recipe left out and the steps it ran.
 *
 * DFO serves a derived manifest at `GET /datasets/derived/{ops_id}/{ocv}`. It names the frame,
 * its retention and citation, the recipe's tree, and `left_out`, every series a step dropped for
 * missing data, each `{coordinates, step: {verb, node}, side, reason, rows}`, with
 * `left_out_complete` saying whether the list holds them all. Both are null for a recipe stored
 * without them, which reads as none left out. The steps come from the tree in the order they
 * ran, each after its inputs, the primary input first.
 */

import { Dataset } from "./dataset.ts";
import type { DerivedFacts, DerivedStep, LeftOutFields } from "./dataset.ts";
import { checkTable } from "./fetch.ts";
import { clientError } from "../core/errors.ts";
import type { ContractError } from "../core/errors.ts";
import { isRecord } from "../core/json.ts";
import type { DerivedRefMember } from "../core/ref.ts";
import { describing } from "../core/trace.ts";

/** The parameters each operation names the columns it keeps apart in. */
const BY_PARAMETERS = ["group_by", "entity_by", "rank_by", "numerator_by", "join_keys"] as const;

/** The keys a served series holds. */
const SERIES_KEYS = ["coordinates", "step", "side", "reason", "rows"] as const;

/**
 * The dataset of a derived frame: its ref member, the derived manifest DFO serves for it, whose
 * response's trace id is `traceId`, and its rows as a bare Parquet file in the frame layout. The
 * member keeps every field of the ref; the manifest gives the citation, the retention, the
 * series the recipe left out and the steps the text form names. `roles` maps a column to the
 * role word the call named it by, which the text form prints in its place.
 *
 * @throws {ContractError} As `derivedFacts` raises.
 */
export async function derivedDataset(
  member: DerivedRefMember,
  manifest: Readonly<Record<string, unknown>>,
  data: Uint8Array,
  traceId: string | null = null,
  roles: Readonly<Record<string, string>> = {},
): Promise<{ dataset: Dataset; facts: DerivedFacts }> {
  const facts = { ...describing(traceId, () => derivedFacts(member, manifest, data)), roles };
  const dataset = await Dataset.create([{ ...member, manifest, data }], {
    layout: "frame",
    derived: facts,
  });
  return { dataset, facts };
}

/**
 * What a derived manifest adds to its frame, once the manifest names `member`'s frame and the
 * file is a table the client reads.
 *
 * @throws {ContractError} The manifest names another frame, or its `left_out` or
 *   `left_out_complete` breaks the served shape (`contract_violation`); the file is not Parquet
 *   (`unexpected_response`) or holds no `time_period` or numeric `value` column
 *   (`contract_violation`).
 */
export function derivedFacts(
  member: DerivedRefMember,
  manifest: Readonly<Record<string, unknown>>,
  data: Uint8Array,
): DerivedFacts {
  const frame = `${member.spec.spec_id} at ${member.contentVersion}`;
  const named = `${String(manifest["spec_id"])} at ${String(manifest["content_version"])}`;
  if (named !== frame) {
    throw clientError("contract_violation", {
      detail: `The derived manifest names ${named}, not ${frame}.`,
    });
  }
  const { leftOut, leftOutComplete } = servedLeftOut(manifest);
  checkTable(data, `The file of ${frame}`, 0);
  const recipe = manifest["recipe"];
  const tree = isRecord(recipe) ? recipe["tree"] : undefined;
  return { leftOut, leftOutComplete, steps: isRecord(tree) ? [...treeSteps(tree)] : [] };
}

function servedLeftOut(manifest: Readonly<Record<string, unknown>>): {
  leftOut: readonly LeftOutFields[];
  leftOutComplete: boolean;
} {
  const served = manifest["left_out"];
  const complete = manifest["left_out_complete"];
  if (served === null || served === undefined) return { leftOut: [], leftOutComplete: true };
  if (!Array.isArray(served)) throw violation("/left_out");
  const leftOut = served.map((item: unknown, index) => series(item, `/left_out/${index}`));
  if (typeof complete !== "boolean") throw violation("/left_out_complete");
  return { leftOut, leftOutComplete: complete };
}

/** One dropped series as the derived manifest serves it. */
function series(value: unknown, pointer: string): LeftOutFields {
  const item = objectAt(value, pointer);
  checkKeys(item, pointer, SERIES_KEYS);
  const coordinates = objectAt(item["coordinates"], `${pointer}/coordinates`);
  for (const [key, text] of Object.entries(coordinates)) {
    if (typeof text !== "string") throw violation(`${pointer}/coordinates/${key}`);
  }
  const step = objectAt(item["step"], `${pointer}/step`);
  checkKeys(step, `${pointer}/step`, ["verb", "node"]);
  const node = step["node"];
  if (!isCount(node)) throw violation(`${pointer}/step/node`);
  const rows = item["rows"];
  if (!isCount(rows)) throw violation(`${pointer}/rows`);
  return {
    coordinates: coordinates as Record<string, string>,
    step: { verb: textAt(step["verb"], `${pointer}/step/verb`), node },
    side: textAt(item["side"], `${pointer}/side`),
    reason: textAt(item["reason"], `${pointer}/reason`),
    rows,
  };
}

/** The steps of a stored recipe's tree in the order they ran. A part of the tree this client
 *  cannot read names no step, since only the text form reads them. */
function* treeSteps(node: Readonly<Record<string, unknown>>): Generator<DerivedStep> {
  const inputs = node["inputs"];
  if (isRecord(inputs)) {
    const slots = Object.keys(inputs).sort((a, b) =>
      a === b ? 0 : a === "frame_ref" ? -1 : b === "frame_ref" ? 1 : a < b ? -1 : 1,
    );
    for (const slot of slots) {
      const child = inputs[slot];
      if (isRecord(child)) yield* treeSteps(child);
    }
  }
  const opSpec = node["op_spec"];
  if (!isRecord(opSpec) || typeof opSpec["verb"] !== "string") return;
  const parameters = isRecord(opSpec["parameters"]) ? opSpec["parameters"] : {};
  const by = BY_PARAMETERS.map((name) => parameters[name]).find(Array.isArray) ?? [];
  const limit = parameters["limit"];
  yield {
    verb: opSpec["verb"],
    by: (by as unknown[]).filter((column): column is string => typeof column === "string"),
    limit: Number.isSafeInteger(limit) ? (limit as number) : null,
  };
}

const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

function objectAt(value: unknown, pointer: string): Record<string, unknown> {
  if (!isRecord(value)) throw violation(pointer);
  return value;
}

function textAt(value: unknown, pointer: string): string {
  if (typeof value !== "string") throw violation(pointer);
  return value;
}

/** Refuses a missing key, or a key outside `keys`, at its pointer. */
function checkKeys(value: Record<string, unknown>, pointer: string, keys: readonly string[]): void {
  const missing = keys.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) throw violation(`${pointer}/${missing}`);
  const extra = Object.keys(value).find((key) => !keys.includes(key));
  if (extra !== undefined) throw violation(`${pointer}/${extra}`);
}

const violation = (pointer: string): ContractError =>
  clientError("contract_violation", {
    detail: `The derived manifest's ${pointer} breaks the shape this client reads.`,
    pointer,
  });
