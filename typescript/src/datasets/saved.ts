/**
 * Reading a saved dataset: the Parquet file `data.toBytes()` writes, and Python's `data.save`,
 * whose key-value metadata carries the provenance and the ref under `dfo.*` keys, as
 * `saved-file.schema.json` in the client contract gives them. It refuses what Python's
 * `saved_dataset` refuses, with the same codes. A file of several members holds them in one
 * table, `part` first, and `dfo.dataset.member_rows` splits its rows by member. The stored JSON
 * readers here serve `Provenance.fromJSON` too.
 */
import { readParquet, decodeStacked } from "./parquet.ts";
import { rowRange } from "./reading-order.ts";
import type { ParquetFile, Table } from "./parquet.ts";
import { partyTotalsEntry } from "./party-totals.ts";
import type { PartyTotalsLeftOut } from "./party-totals.ts";
import type {
  Citation,
  DatasetState,
  DerivedMember,
  DerivedStep,
  LeftOutFields,
  Member,
} from "./dataset.ts";
import { candidatesOf } from "../core/candidates.ts";
import { clientError, DfoError, isDfoError } from "../core/errors.ts";
import type { ClientErrorCode } from "../core/errors.ts";
import { parseJson } from "../core/json.ts";
import { parsedInputOf } from "../core/parse.ts";
import type { CandidatesPart, NoDataPart, Part } from "../core/parts.ts";
import { checkKeys, invalid, isDerived, layoutOf, loadRef, objectAt } from "../core/ref.ts";
import type { DerivedRefMember, RefMember } from "../core/ref.ts";
import { CLIENT_CODE_CLASSES } from "../generated/client-codes.ts";
import { GAP_KINDS } from "../generated/actions.ts";
import { queryOptions } from "../search/answer.ts";
import type { Gap, GapKind, Option } from "../search/answer.ts";
import type { Assumption, Departure, Notice, RequestedOperation } from "../wire.ts";

/** A member's retention: whether its version is pinned and when it stops being guaranteed. */
type Retention = Pick<Member, "pinned" | "heldUntil">;

/** The version of the provenance a file from `toBytes()` carries under `dfo.*` keys, the one
 *  Python's `Dataset.save` writes: 1 for a dataset of dataset versions, and 2 for a derived
 *  dataset, whose `dfo.ref` is a format 2 ref and which adds `dfo.left_out` and `dfo.steps`, so
 *  a client that reads format 1 alone refuses it as a later format. */
export const SAVED_FORMAT_VERSION = 1;
export const SAVED_DERIVED_FORMAT_VERSION = 2;

/** The keys a saved file's `dfo.dataset` object holds, each required and no other allowed. */
const SAVED_DATASET_KEYS = [
  "member_citations",
  "warnings",
  "departures",
  "requested_operations",
  "assumptions",
  "complete",
  "missing",
  "held_until",
  "pinned",
  "stale",
  "layout_version",
  "member_rows",
] as const;

/** The first four bytes of every Parquet file. */
const PARQUET_MAGIC = [0x50, 0x41, 0x52, 0x31];

/** Why bytes hold no dataset to read, as `contract/client-codes.json` names the codes of its
 *  `BundleError` rows. This client reads saved files alone, so it raises `not_a_bundle`. The
 *  other codes name faults in a website bundle, which Python's `dfo.load` reads. */
export type BundleErrorReason = {
  [C in ClientErrorCode]: (typeof CLIENT_CODE_CLASSES)[C] extends "BundleError" ? C : never;
}[ClientErrorCode];

/** Bytes hold no dataset the client can read: no Parquet file, a damaged one, or one without a
 *  saved dataset's `dfo.*` keys. Its `code` is its `reason`. */
export class BundleError extends DfoError {
  readonly reason: BundleErrorReason;

  constructor(reason: BundleErrorReason, detail: string, options: { cause?: unknown } = {}) {
    super({ code: reason, detail, ...options });
    this.reason = reason;
  }
}
Object.defineProperty(BundleError.prototype, "name", { value: "BundleError", configurable: true });

/** A saved file read: what the dataset holds beside its rows, the file's table whole, in the
 *  order the file holds its rows and columns, and each member's row count in member order. */
export type SavedDataset = {
  readonly state: DatasetState;
  readonly table: Table;
  readonly memberRows: readonly number[];
};

/**
 * Reads the file `Dataset.toBytes()` or Python's `Dataset.save` wrote, from the file at `path`
 * when `load(path)` read it, which a refusal of bytes that are no Parquet file names.
 *
 * @throws {BundleError} The bytes are no Parquet file, such as a bundle downloaded from the
 *   website, a damaged one, or one without `dfo.format_version` (`not_a_bundle`).
 * @throws {FormatError} A `dfo.*` key is missing or breaks the saved format, or names a later
 *   format version, at a pointer that starts with the key, as `/dfo.dataset/missing`.
 * @throws {InvalidRequestError} `input` is neither a Uint8Array nor an ArrayBuffer
 *   (`invalid_argument`).
 */
export async function readSaved(input: unknown, path?: string): Promise<SavedDataset> {
  const bytes = bytesOf(input);
  if (!PARQUET_MAGIC.every((byte, index) => bytes[index] === byte)) {
    throw new BundleError(
      "not_a_bundle",
      `${path ?? "The bytes"} ${path === undefined ? "are" : "is"} not a Parquet file. The ` +
        "TypeScript client reads the file data.save(path) or data.toBytes() wrote; a bundle " +
        "downloaded from the website opens with the Python client's dfo.load(path).",
    );
  }
  const file = savedFile(bytes);
  // The `dfo.*` keys and the footer's row counts are checked before anything sized by them.
  const saved = savedState(file);
  checkRowCounts(file);
  const parts = Object.freeze([{ file, label: "" }]);
  let stacked;
  try {
    // A damaged page would otherwise surface on the first read of the rows. The table keeps
    // the decode, so its conversions decode nothing again.
    stacked = Object.freeze(await decodeStacked(parts));
  } catch (error) {
    throw damaged(error);
  }
  const table: Table = {
    parts,
    order: {
      columns: Object.freeze(file.columns.map(({ name }) => name)),
      rows: rowRange(file.rows),
    },
    stacked,
  };
  return { ...saved, table };
}

/** The most rows a byte of a saved file holds. A column of one repeated value packs about
 *  1,200 rows a byte as hyparquet-writer writes it and 500 as pyarrow does, so a file
 *  declaring more rows than this allows is damaged, and reading it would only allocate. */
const MAX_ROWS_PER_BYTE = 4096;

/**
 * Refuses a footer whose row count is not the sum of its row groups', holds a negative count,
 * or exceeds what the file's bytes can hold, before any row is decoded.
 *
 * @throws {BundleError} As a damaged Parquet file (`not_a_bundle`).
 */
function checkRowCounts(file: ParquetFile): void {
  const { num_rows: declared, row_groups: groups } = file.metadata;
  const counts = groups.map((group) => group.num_rows);
  const grouped = counts.reduce((sum, count) => sum + count, 0n);
  if (counts.some((count) => count < 0n) || declared !== grouped) {
    throw damaged(
      clientError("unexpected_response", {
        detail: `the footer declares ${declared} rows and its row groups hold ${grouped}`,
      }),
    );
  }
  const capacity = file.buffer.byteLength * MAX_ROWS_PER_BYTE;
  if (!Number.isSafeInteger(file.rows) || file.rows > capacity) {
    throw damaged(
      clientError("unexpected_response", {
        detail: `the footer declares ${declared} rows in ${file.buffer.byteLength} bytes`,
      }),
    );
  }
}

/** The input as bytes, refusing any other kind of value. */
function bytesOf(input: unknown): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  const kind = input === null ? "null" : Array.isArray(input) ? "an array" : typeof input;
  throw clientError("invalid_argument", {
    detail: `Dataset.fromBytes takes a Uint8Array or an ArrayBuffer, such as await data.toBytes(), not ${kind}.`,
  });
}

/** The Parquet file in `bytes`, when its key-value metadata carries a saved dataset. */
function savedFile(bytes: Uint8Array): ParquetFile {
  let file: ParquetFile;
  try {
    // A copy, so the dataset holds bytes no caller can change.
    file = readParquet(new Uint8Array(bytes));
  } catch (error) {
    throw damaged(error);
  }
  const keys = (file.metadata.key_value_metadata ?? []).map(({ key }) => key);
  if (!keys.includes("dfo.format_version")) {
    throw new BundleError(
      "not_a_bundle",
      "The bytes are a Parquet file without a saved dataset's provenance, such as a file DFO " +
        "serves. A Parquet reader such as hyparquet reads it as a table; client.fetch(ref) " +
        "gives the same version as a Dataset with its provenance; Dataset.fromBytes reads " +
        "the bytes data.toBytes() or data.save() wrote.",
    );
  }
  return file;
}

/** The error for a Parquet file the client cannot read, keeping what the reader raised as the
 *  cause; anything other than a client error passes unchanged. */
function damaged(error: unknown): unknown {
  if (!isDfoError(error)) return error;
  return new BundleError(
    "not_a_bundle",
    `The bytes are a damaged Parquet file (${error.detail}): save the dataset again.`,
    { cause: error },
  );
}

/** What a saved file's `dfo.*` keys state, and each member's row count. */
function savedState(file: ParquetFile): Omit<SavedDataset, "table"> {
  const values = savedValues(file);
  const version = values.get("dfo.format_version");
  if (
    version !== String(SAVED_FORMAT_VERSION) &&
    version !== String(SAVED_DERIVED_FORMAT_VERSION)
  ) {
    throw invalid(
      "/dfo.format_version",
      "the file carries no dataset saved by this client's format versions " +
        `${SAVED_FORMAT_VERSION} and ${SAVED_DERIVED_FORMAT_VERSION}; a later client reads it`,
    );
  }
  const rest = decodeObject(required(values, "dfo.dataset"), "/dfo.dataset");
  checkKeys(rest, "/dfo.dataset", SAVED_DATASET_KEYS);
  const refText = values.get("dfo.ref");
  const stored =
    refText === undefined ? [] : loadRef(decodeValue(refText, "/dfo.ref"), "/dfo.ref").members;
  const citations = arrayAt(rest["member_citations"], "/dfo.dataset/member_citations");
  if (citations.length !== stored.length) {
    throw invalid(
      "/dfo.dataset/member_citations",
      `holds ${citations.length} citations for the ${stored.length} members dfo.ref names`,
    );
  }
  const pinned = flag(rest, "pinned");
  const heldUntilText = rest["held_until"];
  const heldUntil =
    heldUntilText === null ? null : loadDay(heldUntilText, "/dfo.dataset/held_until");
  const retentions = loadSavedRetention(values.get("dfo.retention"), stored.length, {
    pinned,
    heldUntil,
  });
  const members = stored.map((member, index): Member | DerivedMember => ({
    ...member,
    citation: loadCitation(citations[index], `/dfo.dataset/member_citations/${index}`),
    ...retentions[index]!,
  }));
  checkRetention({ pinned, heldUntil }, members, "/dfo.dataset");
  const memberRows = loadMemberRows(rest["member_rows"], members.length, file.rows);
  // Only a derived dataset carries left-out series and steps.
  const derived = stored.some(isDerived);
  const expected = derived ? SAVED_DERIVED_FORMAT_VERSION : SAVED_FORMAT_VERSION;
  if (version !== String(expected)) {
    throw invalid(
      "/dfo.format_version",
      `is ${version} for a file whose dfo.ref ${derived ? "holds" : "holds no"} derived ` +
        `member; it is ${expected}`,
    );
  }
  const partyTotals = values.get("dfo.party_totals_left_out");
  const fetchedAt = values.get("dfo.fetched_at");
  const question = values.get("dfo.question");
  const complete = flag(rest, "complete");
  const missing = items(rest, "missing", loadGap);
  checkComplete(complete, missing, "/dfo.dataset");
  const state: DatasetState = {
    sentence: required(values, "dfo.sentence"),
    members,
    citation: loadCitation(
      decodeObject(required(values, "dfo.citation"), "/dfo.citation"),
      "/dfo.citation",
    ),
    warnings: items(rest, "warnings", (item, pointer) =>
      loadWarning(item, pointer, { provenance: false }),
    ),
    departures: items(rest, "departures", loadDeparture),
    requestedOperations: items(rest, "requested_operations", loadOperation),
    assumptions: items(rest, "assumptions", loadAssumption),
    complete,
    missing,
    layout: members[0] === undefined ? "long" : layoutOf(members[0].rendering),
    layoutVersion: stringAt(rest["layout_version"], "/dfo.dataset/layout_version"),
    question:
      question === undefined
        ? null
        : stringAt(decodeValue(question, "/dfo.question"), "/dfo.question"),
    fetchedAt:
      fetchedAt === undefined
        ? null
        : loadTime(decodeValue(fetchedAt, "/dfo.fetched_at"), "/dfo.fetched_at"),
    partyTotalsLeftOut: partyTotals === undefined ? [] : loadPartyTotals(partyTotals, stored),
    roles: {},
    ...(derived ? loadDerived(values) : { leftOut: [], leftOutComplete: true, steps: [] }),
  };
  // Python reads `stale` too. This client keeps no cache, so a saved dataset is never stale.
  flag(rest, "stale");
  return { state, memberRows };
}

/** A saved file's `dfo.*` metadata. */
function savedValues(file: ParquetFile): Map<string, string> {
  const values = new Map<string, string>();
  for (const { key, value } of file.metadata.key_value_metadata ?? []) {
    if (key.startsWith("dfo.")) values.set(key, value ?? "");
  }
  return values;
}

function required(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined) throw invalid(`/${key}`, "missing");
  return value;
}

/** A stored JSON value of any kind. */
function decodeValue(text: string, pointer: string): unknown {
  try {
    return parseJson(text);
  } catch (error) {
    const reason = error instanceof Error ? `: ${error.message}` : "";
    throw Object.assign(invalid(pointer, `not JSON${reason}`), { cause: error });
  }
}

/** A stored JSON object. */
const decodeObject = (text: string, pointer: string): Record<string, unknown> =>
  objectAt(decodeValue(text, pointer), pointer);

/** Each item of the saved array `rest[key]`, read by `load` at its pointer. */
function items<T>(
  rest: Record<string, unknown>,
  key: string,
  load: (item: unknown, pointer: string) => T,
): T[] {
  const pointer = `/dfo.dataset/${key}`;
  return arrayAt(rest[key], pointer).map((item, index) => load(item, `${pointer}/${index}`));
}

function flag(rest: Record<string, unknown>, key: string): boolean {
  const value = rest[key];
  if (typeof value !== "boolean") throw invalid(`/dfo.dataset/${key}`, "not a boolean");
  return value;
}

/** A non-negative safe integer. */
const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/** An object of string members, the optional ones absent or null, and no other member. */
function strings(
  value: unknown,
  pointer: string,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Record<string, string | null> {
  const record = objectAt(value, pointer);
  checkKeys(record, pointer, requiredKeys, optionalKeys);
  for (const [key, item] of Object.entries(record)) {
    if (!(item === null && optionalKeys.includes(key))) stringAt(item, `${pointer}/${key}`);
  }
  return record as Record<string, string | null>;
}

/** One non-negative row count per member, summing to the file's rows when there are members. */
function loadMemberRows(value: unknown, members: number, rows: number): number[] {
  const pointer = "/dfo.dataset/member_rows";
  const counts = arrayAt(value, pointer);
  if (!counts.every(isCount)) throw invalid(pointer, "not non-negative integers");
  if (counts.length !== members) {
    throw invalid(
      pointer,
      `holds ${counts.length} counts for the ${members} members dfo.ref names`,
    );
  }
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (counts.length > 0 && total !== rows) {
    throw invalid(pointer, `counts ${total} rows in a file of ${rows}`);
  }
  return counts;
}

function loadDeparture(value: unknown, pointer: string): Departure {
  const { code, text, ...rest } = strings(
    value,
    pointer,
    ["code", "text"],
    ["asked", "shown", "binding_ref"],
  );
  return { code: code!, text: text!, ...rest };
}

function loadOperation(value: unknown, pointer: string): RequestedOperation {
  const { target_year: year, ...rest } = objectAt(value, pointer);
  if (year !== undefined && year !== null && !Number.isSafeInteger(year)) {
    throw invalid(`${pointer}/target_year`, "not an integer");
  }
  const { verb, phrase, ...over } = strings(rest, pointer, ["verb", "phrase"], ["over"]);
  return {
    verb: verb!,
    phrase: phrase!,
    ...over,
    ...(year === undefined ? {} : { target_year: year as number | null }),
  };
}

function loadAssumption(value: unknown, pointer: string): Assumption {
  const { refs, ...rest } = objectAt(value, pointer);
  const listed = arrayAt(refs ?? null, `${pointer}/refs`).map((ref, index) =>
    stringAt(ref, `${pointer}/refs/${index}`),
  );
  const {
    kind,
    binding_ref: bindingRef,
    text,
  } = strings(rest, pointer, ["kind", "binding_ref", "text"]);
  return { kind: kind!, binding_ref: bindingRef!, text: text!, refs: listed };
}

const isGapKind = (value: unknown): value is GapKind =>
  value === "unknown" || (GAP_KINDS as readonly unknown[]).includes(value);

const GAP_KEYS = ["part_index", "part", "kind", "message", "options"];

/** A stored gap. A candidates part's options are its candidates, as in an answer. A saved file's
 *  gap and its options are closed; a provenance record's are open, so a key they do not name is
 *  ignored. */
export function loadGap(value: unknown, pointer: string, { closed = true } = {}): Gap {
  const gap = objectAt(value, pointer);
  (closed ? checkKeys : requireKeys)(gap, pointer, GAP_KEYS);
  const partIndex = gap["part_index"];
  if (!Number.isSafeInteger(partIndex)) throw invalid(`${pointer}/part_index`, "not an integer");
  const kind = gap["kind"];
  if (!isGapKind(kind)) throw invalid(`${pointer}/kind`, "not a gap kind");
  const part = loadPart(gap["part"], `${pointer}/part`);
  // A part that carries its own options gives them as a live answer reads them, so a loaded
  // gap equals the live one; the saved list is read and checked all the same.
  const stored = arrayAt(gap["options"], `${pointer}/options`).map((option, index) =>
    loadOption(option, `${pointer}/options/${index}`, closed),
  );
  const options =
    part.status === "candidates"
      ? candidatesOf(part as CandidatesPart)
      : part.status === "no_data"
        ? queryOptions((part as NoDataPart).no_data)
        : stored;
  return {
    partIndex: partIndex as number,
    part,
    kind,
    message: stringAt(gap["message"], `${pointer}/message`),
    options,
  };
}

/** A saved answer part, checked for the members a gap reads by its status. A status this client
 *  does not know passes as it stands. */
function loadPart(value: unknown, pointer: string): Part {
  const part = objectAt(value, pointer);
  const status = stringAt(part["status"], `${pointer}/status`);
  switch (status) {
    case "definite":
      loadSpec(part["spec"], `${pointer}/spec`);
      break;
    case "candidates": {
      const candidates = objectAt(part["candidates"], `${pointer}/candidates`);
      arrayAt(candidates["specs"], `${pointer}/candidates/specs`).forEach((spec, index) => {
        loadSpec(spec, `${pointer}/candidates/specs/${index}`);
      });
      break;
    }
    case "no_data": {
      const noData = objectAt(part["no_data"], `${pointer}/no_data`);
      stringAt(noData["reason"], `${pointer}/no_data/reason`);
      break;
    }
    case "unsupported": {
      const unsupported = objectAt(part["unsupported"], `${pointer}/unsupported`);
      stringAt(unsupported["code"], `${pointer}/unsupported/code`);
      break;
    }
    default:
      break;
  }
  return { ...part, status };
}

/** A spec as an answer part holds it: its id, a definition that names it, and its resolution. */
function loadSpec(value: unknown, pointer: string): void {
  const spec = objectAt(value, pointer);
  const specId = stringAt(spec["spec_id"], `${pointer}/spec_id`);
  const definition = objectAt(spec["definition"], `${pointer}/definition`);
  objectAt(definition["identity"], `${pointer}/definition/identity`);
  if (definition["spec_id"] !== specId) {
    throw invalid(`${pointer}/definition/spec_id`, `not the spec's ${specId}`);
  }
  objectAt(spec["resolved"], `${pointer}/resolved`);
}

function loadOption(value: unknown, pointer: string, closed: boolean): Option {
  const option = objectAt(value, pointer);
  (closed ? checkKeys : requireKeys)(option, pointer, ["label", "mentions", "data_query"]);
  const mentions = arrayAt(option["mentions"], `${pointer}/mentions`).map((mention, index) =>
    stringAt(mention, `${pointer}/mentions/${index}`),
  );
  return {
    kind: "query",
    label: stringAt(option["label"], `${pointer}/label`),
    mentions,
    dataQuery: parsedInputOf(objectAt(option["data_query"], `${pointer}/data_query`)),
    entityChoice: null,
  };
}

/**
 * A saved file's `dfo.party_totals_left_out`, whose entries name a dataset member of the ref or
 * a root of a derived member (a derived member's own id is refused), in member order and then in
 * the member's root order. A spec id can name several of these, so each entry takes the first
 * one at or after the one the entry before it took, which finds an order whenever one exists.
 */
function loadPartyTotals(
  text: string,
  members: readonly (RefMember | DerivedRefMember)[],
): PartyTotalsLeftOut[] {
  const pointer = "/dfo.party_totals_left_out";
  const named = members.flatMap((member) =>
    isDerived(member) ? member.roots.map((root) => root.specId) : [member.spec.spec_id],
  );
  let position = 0;
  return arrayAt(decodeValue(text, pointer), pointer).map((item, index) => {
    const at = `${pointer}/${index}`;
    const entry = objectAt(item, at);
    checkKeys(entry, at, ["spec_id", "role", "entities"], ["provenance", "kept_in"]);
    const specId = stringAt(entry["spec_id"], `${at}/spec_id`);
    const found = named.indexOf(specId, position);
    if (found === -1) {
      throw invalid(
        `${at}/spec_id`,
        "names a spec that is no member of dfo.ref or root of a derived member, or lists them " +
          "out of order",
      );
    }
    position = found;
    const read = partyTotalsEntry(entry, specId);
    if (read === null) {
      throw invalid(
        at,
        "not an entry of a non-empty role, non-empty entities, a string or null provenance, " +
          "and kept_in in the contract's order",
      );
    }
    return read;
  });
}

/** A saved file's `dfo.left_out` and `dfo.steps`, either absent for none. */
function loadDerived(
  values: ReadonlyMap<string, string>,
): Pick<DatasetState, "leftOut" | "leftOutComplete" | "steps"> {
  let leftOut: LeftOutFields[] = [];
  let leftOutComplete = true;
  const leftOutText = values.get("dfo.left_out");
  if (leftOutText !== undefined) {
    const pointer = "/dfo.left_out";
    const record = decodeObject(leftOutText, pointer);
    checkKeys(record, pointer, ["series", "complete"]);
    const complete = record["complete"];
    if (typeof complete !== "boolean") throw invalid(`${pointer}/complete`, "not a boolean");
    leftOutComplete = complete;
    leftOut = arrayAt(record["series"], `${pointer}/series`).map((item, index) =>
      loadLeftOutSeries(item, `${pointer}/series/${index}`),
    );
  }
  const stepsText = values.get("dfo.steps");
  const steps =
    stepsText === undefined
      ? []
      : arrayAt(decodeValue(stepsText, "/dfo.steps"), "/dfo.steps").map((item, index) =>
          loadStep(item, `/dfo.steps/${index}`),
        );
  return { leftOut, leftOutComplete, steps };
}

/** Refuses a missing key of `keys`; any other key passes. */
export function requireKeys(
  value: Record<string, unknown>,
  pointer: string,
  keys: readonly string[],
) {
  const missing = keys.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) throw invalid(`${pointer}/${missing}`, "missing");
}

/** One dropped series as a saved file keeps it. A key outside its shape is ignored. */
function loadLeftOutSeries(value: unknown, pointer: string): LeftOutFields {
  const item = objectAt(value, pointer);
  requireKeys(item, pointer, ["coordinates", "step", "side", "reason", "rows"]);
  const coordinates = objectAt(item["coordinates"], `${pointer}/coordinates`);
  for (const [key, text] of Object.entries(coordinates)) {
    stringAt(text, `${pointer}/coordinates/${key}`);
  }
  const step = objectAt(item["step"], `${pointer}/step`);
  requireKeys(step, `${pointer}/step`, ["verb", "node"]);
  const node = step["node"];
  if (!isCount(node)) throw invalid(`${pointer}/step/node`, "not a node index");
  const rows = item["rows"];
  if (!isCount(rows)) throw invalid(`${pointer}/rows`, "not a row count");
  return {
    coordinates: coordinates as Record<string, string>,
    step: { verb: stringAt(step["verb"], `${pointer}/step/verb`), node },
    side: stringAt(item["side"], `${pointer}/side`),
    reason: stringAt(item["reason"], `${pointer}/reason`),
    rows,
  };
}

function loadStep(value: unknown, pointer: string): DerivedStep {
  const step = objectAt(value, pointer);
  checkKeys(step, pointer, ["verb", "by", "limit"]);
  const limit = step["limit"];
  if (limit !== null && !Number.isSafeInteger(limit)) {
    throw invalid(`${pointer}/limit`, "not an integer");
  }
  return {
    verb: stringAt(step["verb"], `${pointer}/verb`),
    by: arrayAt(step["by"], `${pointer}/by`).map((column, index) =>
      stringAt(column, `${pointer}/by/${index}`),
    ),
    limit: limit as number | null,
  };
}

/** The forms a stored record writes a time and a day in, as the contract's schemas give them. */
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether the year, month and day a pattern matched name a day on the calendar. */
function dayExists(match: RegExpExecArray): boolean {
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** A stored ISO 8601 time with a zone, on a day that exists. */
export function loadTime(value: unknown, pointer: string): Date {
  const match = ISO_TIME.exec(stringAt(value, pointer));
  const date = match === null ? null : new Date(match[0]);
  if (match === null || !dayExists(match) || Number.isNaN(date!.getTime())) {
    throw invalid(pointer, "not an ISO 8601 time with a zone on a day that exists");
  }
  return date!;
}

/** A stored ISO date, `YYYY-MM-DD`, on a day that exists, as midnight UTC. */
export function loadDay(value: unknown, pointer: string): Date {
  const match = ISO_DAY.exec(stringAt(value, pointer));
  if (match === null || !dayExists(match)) {
    throw invalid(pointer, "not an ISO date on a day that exists");
  }
  return new Date(`${match[0]}T00:00:00Z`);
}

export function stringAt(value: unknown, pointer: string): string {
  if (typeof value !== "string") throw invalid(pointer, "not a string");
  return value;
}

export function nullableStringAt(value: unknown, pointer: string): string | null {
  return value === null ? null : stringAt(value, pointer);
}

export function arrayAt(value: unknown, pointer: string): unknown[] {
  if (!Array.isArray(value)) throw invalid(pointer, "not an array");
  return value;
}

/** A stored citation, its sources' licence spelled `licence`. A saved file's is closed. A
 *  provenance record's is open, so a key it or a source does not name is ignored. */
export function loadCitation(
  value: unknown,
  pointer: string,
  { closed = true }: { readonly closed?: boolean } = {},
): Citation {
  const keysOf = (
    record: Record<string, unknown>,
    at: string,
    keys: string[],
    optional: string[],
  ): void => {
    if (closed) checkKeys(record, at, keys, optional);
    else requireKeys(record, at, keys);
  };
  const citation = objectAt(value, pointer);
  keysOf(citation, pointer, ["text", "sources"], []);
  return {
    text: stringAt(citation["text"], `${pointer}/text`),
    sources: arrayAt(citation["sources"], `${pointer}/sources`).map((item, index) => {
      const at = `${pointer}/sources/${index}`;
      const source = objectAt(item, at);
      keysOf(source, at, ["ref", "label"], ["licence", "licence_url", "url"]);
      return Object.freeze({
        ref: stringAt(source["ref"], `${at}/ref`),
        label: stringAt(source["label"], `${at}/label`),
        licence: nullableStringAt(source["licence"] ?? null, `${at}/licence`),
        licenceUrl: nullableStringAt(source["licence_url"] ?? null, `${at}/licence_url`),
        url: nullableStringAt(source["url"] ?? null, `${at}/url`),
      });
    }),
  };
}

/**
 * A stored warning, its `spec_id` a string or null. A provenance record's warning is open and
 * holds `spec_id`, so it refuses one without it and ignores a key it does not name. A saved
 * file's is closed and may leave `spec_id` out, and the notice then has none.
 */
export function loadWarning(
  value: unknown,
  pointer: string,
  { provenance }: { readonly provenance: boolean },
): Notice {
  const warning = objectAt(value, pointer);
  const keys = ["code", "severity", "message"];
  if (provenance) requireKeys(warning, pointer, [...keys, "spec_id"]);
  else checkKeys(warning, pointer, keys, ["spec_id"]);
  const notice = {
    code: stringAt(warning["code"], `${pointer}/code`),
    severity: stringAt(warning["severity"], `${pointer}/severity`),
    message: stringAt(warning["message"], `${pointer}/message`),
  };
  if (!Object.hasOwn(warning, "spec_id")) return notice;
  return { ...notice, spec_id: nullableStringAt(warning["spec_id"], `${pointer}/spec_id`) };
}

/** A member's stored `pinned`, a boolean or null, and `held_until`, an ISO day or null. */
export function loadRetention(entry: Record<string, unknown>, pointer: string): Retention {
  const pinned = entry["pinned"];
  if (pinned !== null && typeof pinned !== "boolean") {
    throw invalid(`${pointer}/pinned`, "not a boolean or null");
  }
  const heldUntil = entry["held_until"];
  return {
    pinned,
    heldUntil: heldUntil === null ? null : loadDay(heldUntil, `${pointer}/held_until`),
  };
}

/**
 * A saved file's `dfo.retention`, one retention per member. A file without it, as one a client
 * before 0.3.0 saved, reads every member as pinned when the dataset is. Otherwise each member's
 * `pinned` is unknown and its `heldUntil` is the dataset's, the earliest of its members', a day
 * each member is held until at least, so the dataset reads the day it saved.
 */
function loadSavedRetention(
  text: string | undefined,
  members: number,
  dataset: { readonly pinned: boolean; readonly heldUntil: Date | null },
): Retention[] {
  if (text === undefined) {
    const retention: Retention = dataset.pinned
      ? { pinned: true, heldUntil: null }
      : { pinned: null, heldUntil: dataset.heldUntil };
    return Array.from({ length: members }, () => retention);
  }
  const pointer = "/dfo.retention";
  const entries = arrayAt(decodeValue(text, pointer), pointer);
  if (entries.length !== members) {
    throw invalid(
      pointer,
      `holds ${entries.length} entries for the ${members} members dfo.ref names`,
    );
  }
  return entries.map((value, index) => {
    const at = `${pointer}/${index}`;
    const entry = objectAt(value, at);
    requireKeys(entry, at, ["pinned", "held_until"]);
    return loadRetention(entry, at);
  });
}

/** The earliest `heldUntil` of the members not pinned, and whether every member is pinned; a
 *  member whose `pinned` is unknown counts as not pinned, and no members are not pinned, as a
 *  website bundle opened from a folder names no version to keep. */
export function datasetRetention(members: readonly Retention[]): {
  heldUntil: Date | null;
  pinned: boolean;
} {
  if (members.length > 0 && members.every((member) => member.pinned === true)) {
    return { heldUntil: null, pinned: true };
  }
  let heldUntil: Date | null = null;
  for (const member of members) {
    if (member.pinned === true || member.heldUntil === null) continue;
    if (heldUntil === null || member.heldUntil < heldUntil) heldUntil = member.heldUntil;
  }
  return { heldUntil, pinned: false };
}

/**
 * Refuses a stored record whose `complete` is not whether `missing` is empty: a saved file's
 * `dfo.dataset` or a provenance record. Every client writes `complete` as true exactly when no
 * part was left out.
 *
 * @throws {FormatError} At `${pointer}/complete` (`format_invalid`).
 */
export function checkComplete(complete: boolean, missing: readonly Gap[], pointer: string): void {
  if (complete === missing.length > 0) {
    throw invalid(
      `${pointer}/complete`,
      "is not whether missing is empty: true exactly when no part was left out",
    );
  }
}

/**
 * Refuses a stored record's `pinned` or `heldUntil` that differs from what its members' retention
 * gives, as `datasetRetention` derives it: a saved file's `dfo.dataset` against its members, or a
 * provenance record against its members. A record with no member is not pinned and has no
 * `held_until`, so what a reader takes is what the record states.
 *
 * @throws {FormatError} At `${pointer}/pinned` or `${pointer}/held_until` (`format_invalid`).
 */
export function checkRetention(
  dataset: { readonly pinned: boolean; readonly heldUntil: Date | null },
  members: readonly Retention[],
  pointer: string,
): void {
  const derived = datasetRetention(members);
  if (dataset.pinned !== derived.pinned) {
    throw invalid(
      `${pointer}/pinned`,
      "is not what the members' pinned gives: true exactly when there are members and every one is pinned",
    );
  }
  if (dataset.heldUntil?.getTime() !== derived.heldUntil?.getTime()) {
    throw invalid(
      `${pointer}/held_until`,
      "is not the earliest held_until of the members not pinned",
    );
  }
}
