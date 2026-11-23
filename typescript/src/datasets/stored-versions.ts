/**
 * Stored versions: the version a `latest: "stored"` read of each spec serves now.
 *
 * `storedVersions` asks `GET /datasets/heads` once for every spec its targets name: a spec's
 * own; for a ref, or a Dataset by its ref, each dataset member's and each derived member's
 * roots'; for a recipe, each
 * root's. It sends each id once, sorted by code point, so two checks of the same specs send the
 * same URL and share an edge cache entry. `StoredVersions.toJSON()` writes the saved form
 * `stored-versions.schema.json` gives, which `StoredVersions.fromJSON` reads back.
 */
import { clientError } from "../core/errors.ts";
import type { DfoError, InvalidRequestError } from "../core/errors.ts";
import { compareCodePoints, isRecord, parseJson } from "../core/json.ts";
import {
  CONTENT_VERSION,
  DatasetRef,
  invalid,
  isDerived,
  loadRef,
  objectAt,
  OPS_ID,
  SPEC_ID,
} from "../core/ref.ts";
import type { Spec } from "../core/ref.ts";
import type { Transport } from "../http/transport.ts";
import { Dataset } from "./dataset.ts";
import type { Wait } from "./operation.ts";
import { Recipe, recipeRoots } from "./recipe.ts";

/** The route that answers each spec's stored head. */
export const HEADS_PATH = "/datasets/heads";

/** The most specs one check names, as `GET /datasets/heads` takes them. */
export const MAX_SPECS = 64;

/** The format of the record `StoredVersions.toJSON()` returns. */
const FORMAT_VERSION = 1;

const ROUTE = `GET ${HEADS_PATH}`;

/** What a stored-versions check reads spec ids from. */
export type StoredTarget = Spec | DatasetRef | Dataset | Recipe;

/** The record `StoredVersions.toJSON()` returns, in the format `stored-versions.schema.json`
 *  gives, which Python's `StoredVersions.to_json` writes too. */
export type StoredVersionsJson = {
  format_version: 1;
  /** One head per spec, sorted by `spec_id`. */
  heads: { spec_id: string; content_version: string | null }[];
};

/** The options of `client.storedVersions`. */
export type StoredVersionsOptions = {
  readonly signal?: AbortSignal;
  /** The longest the whole call takes, retries included, in milliseconds; `Infinity` for no
   *  bound. The client's `timeout` by default, else none; each attempt also stops at the
   *  client's `attemptTimeout`. */
  readonly timeout?: number;
};

let storedVersionsOf: (heads: Record<string, string | null>) => StoredVersions;

/**
 * The version a `latest: "stored"` read of each spec would serve from its stored head when the
 * check ran, or null when that read would not serve from the head: no head, a head whose import
 * was replaced, a head too old to serve, a revoked version, or a spec DFO has not registered.
 *
 * `client.storedVersions(targets)` returns one. Save `JSON.stringify(check)` beside what you
 * built from the data, check again later, and read again the specs `changedSince` names.
 */
export class StoredVersions {
  /** Each spec id the check named, sorted, with its stored version (`cv_…`) or null. */
  readonly heads: Readonly<Record<string, string | null>>;

  static {
    storedVersionsOf = (heads) => new StoredVersions(heads);
  }

  private constructor(heads: Record<string, string | null>) {
    const sorted = Object.keys(heads).sort(compareCodePoints);
    this.heads = Object.freeze(Object.fromEntries(sorted.map((id) => [id, heads[id] ?? null])));
    Object.freeze(this);
  }

  /**
   * The spec ids, sorted, whose stored version differs from the one `built` records: another
   * version, a version where `built` holds null or the reverse, or a spec `built` does not list.
   * A spec null in both has not changed.
   *
   * @throws {InvalidRequestError} `built` is not a `StoredVersions` (`invalid_argument`).
   */
  changedSince(built: StoredVersions): string[] {
    if (!(built instanceof StoredVersions)) {
      const saved = typeof built === "string" || isRecord(built);
      throw clientError("invalid_argument", {
        detail:
          "changedSince takes a StoredVersions" +
          (saved ? "; read saved JSON with StoredVersions.fromJSON first." : "."),
      });
    }
    const before = built.heads;
    return Object.entries(this.heads)
      .filter(([specId, version]) => !Object.hasOwn(before, specId) || before[specId] !== version)
      .map(([specId]) => specId);
  }

  /** The check as JSON values, which `JSON.stringify(check)` writes and
   *  `StoredVersions.fromJSON` reads back in any DFO client. */
  toJSON(): StoredVersionsJson {
    return {
      format_version: FORMAT_VERSION,
      heads: Object.entries(this.heads).map(([spec_id, content_version]) => ({
        spec_id,
        content_version,
      })),
    };
  }

  /** Whether `other` is a `StoredVersions` holding the same heads, as Python's `==` compares
   *  two. */
  equals(other: unknown): boolean {
    return (
      other instanceof StoredVersions &&
      JSON.stringify(this.toJSON()) === JSON.stringify(other.toJSON())
    );
  }

  /**
   * Loads a check any DFO client saved, from its JSON text or the value `JSON.parse` gives for
   * it. Python's `StoredVersions.from_json` takes the text, as str or bytes, or the parsed
   * object.
   *
   * @throws {FormatError} The value is neither JSON text nor a JSON object, comes from a later
   *   format version, holds a key the format does not name, lists no head or more than 64, names
   *   a spec twice, or holds a spec id or version that is neither `spec_…` nor `cv_…`
   *   (`format_invalid`), with the pointer of the fault.
   */
  static fromJSON(value: unknown): StoredVersions {
    let parsed: unknown = value;
    if (typeof value === "string") {
      try {
        parsed = parseJson(value);
      } catch (error) {
        throw Object.assign(invalid("", "not JSON"), { cause: error });
      }
    }
    const record = objectAt(parsed, "");
    closedKeys(record, "", ["format_version", "heads"]);
    if (record["format_version"] !== FORMAT_VERSION) {
      throw invalid("/format_version", `not ${FORMAT_VERSION}; a later client reads it`);
    }
    const entries = record["heads"];
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_SPECS) {
      throw invalid("/heads", `not a list of 1 to ${MAX_SPECS} heads`);
    }
    const heads: Record<string, string | null> = {};
    for (const [index, entry] of (entries as unknown[]).entries()) {
      const pointer = `/heads/${index}`;
      const head = objectAt(entry, pointer);
      closedKeys(head, pointer, ["spec_id", "content_version"]);
      const specId = head["spec_id"];
      const version = head["content_version"];
      if (typeof specId !== "string" || !SPEC_ID.test(specId)) {
        throw invalid(`${pointer}/spec_id`, "not a spec id");
      }
      if (Object.hasOwn(heads, specId)) {
        throw invalid(`${pointer}/spec_id`, `${specId} is listed twice`);
      }
      if (version !== null && (typeof version !== "string" || !CONTENT_VERSION.test(version))) {
        throw invalid(`${pointer}/content_version`, "neither a dataset version nor null");
      }
      heads[specId] = version;
    }
    return storedVersionsOf(heads);
  }

  /** The number of specs and of those with a stored version, as
   *  `StoredVersions(3 specs, 2 with a stored version)`. */
  toString(): string {
    const versions = Object.values(this.heads);
    const stored = versions.filter((version) => version !== null).length;
    const noun = versions.length === 1 ? "spec" : "specs";
    return `StoredVersions(${versions.length} ${noun}, ${stored} with a stored version)`;
  }

  /** Node's `console.log` and `util.inspect` show the check as `String(check)` does. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}

/** Refuses an object without each key of `keys`, or with any other key. */
function closedKeys(value: Record<string, unknown>, pointer: string, keys: readonly string[]) {
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw invalid(`${pointer}/${key}`, "missing");
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw invalid(`${pointer}/${key}`, "not a member of the format");
  }
}

/**
 * Asks DFO, in one request, for the version a `latest: "stored"` read of each spec `targets`
 * names would serve now.
 *
 * @throws {InvalidRequestError} As `specIds` throws; no request is sent.
 * @throws {ContractError} As `readHeads` throws.
 */
export async function storedVersions(
  transport: Transport,
  targets: unknown,
  { deadline, signal }: Wait,
): Promise<StoredVersions> {
  const asked = specIds(targets);
  const query = new URLSearchParams(asked.map((specId) => ["spec_id", specId]));
  const { body, traceId } = await transport.request({
    path: `${HEADS_PATH}?${query}`,
    deadline,
    signal,
  });
  return readHeads(body, asked, traceId);
}

/**
 * The spec ids a check of `targets` names, each once, sorted by code point.
 *
 * @throws {InvalidRequestError} `targets` is not an array of specs, DatasetRefs, Datasets and
 *   Recipes, names no spec or more than `MAX_SPECS`, or a recipe root reads a frame DFO
 *   computed, which holds no stored head (`invalid_argument`); a Dataset names no version, as a
 *   website bundle opened from a folder does not (`ref_unavailable`).
 */
export function specIds(targets: unknown): string[] {
  if (!Array.isArray(targets)) {
    throw refusal(
      targets instanceof DatasetRef ||
        targets instanceof Dataset ||
        targets instanceof Recipe ||
        isSpec(targets)
        ? "storedVersions takes an array of targets, as [target]."
        : "storedVersions takes an array of specs, DatasetRefs, Datasets and Recipes, not " +
            `${shown(targets)}.`,
    );
  }
  const found = new Set<string>();
  for (const target of targets as unknown[]) {
    for (const specId of idsOf(target)) found.add(specId);
  }
  if (found.size === 0) {
    throw refusal("storedVersions names no spec; pass the specs, refs or recipes to check.");
  }
  if (found.size > MAX_SPECS) {
    throw refusal(
      `storedVersions names ${found.size} specs, past the ${MAX_SPECS} one check takes; split ` +
        "the targets over several checks.",
    );
  }
  return [...found].sort(compareCodePoints);
}

/** Whether `value` stands for a spec: a plain object with a `spec_id`, which `storedId`
 *  checks. */
const isSpec = (value: unknown): value is Spec =>
  isRecord(value) && !(value instanceof Recipe) && Object.hasOwn(value, "spec_id");

const shown = (value: unknown): string =>
  value === null ? "null" : typeof value === "object" ? value.constructor.name : typeof value;

/** The spec ids one target reads. */
function idsOf(target: unknown): string[] {
  if (target instanceof DatasetRef) return refIds(target);
  if (target instanceof Dataset) return refIds(target.ref);
  if (target instanceof Recipe) {
    return recipeRoots(target).flatMap((node) =>
      Object.hasOwn(node, "ref")
        ? refIds(loadRef(node["ref"], "/ref"))
        : [storedId(node["spec_id"], `The recipe ${String(target)}`)],
    );
  }
  if (isSpec(target)) return [storedId(target.spec_id, "A spec")];
  throw refusal(
    `storedVersions takes specs, DatasetRefs, Datasets and Recipes, not ${shown(target)}.`,
  );
}

/**
 * `specId` when it names a spec, which holds a stored head.
 *
 * @throws {InvalidRequestError} `specId` names a frame DFO computed, or is not a spec id
 *   (`invalid_argument`).
 */
function storedId(specId: unknown, reader: string): string {
  if (typeof specId === "string" && SPEC_ID.test(specId)) return specId;
  if (typeof specId === "string" && OPS_ID.test(specId)) {
    throw refusal(
      `${reader} reads ${specId}, a frame DFO computed, which holds no stored head; check the ` +
        "DatasetRef it came from, whose derived member names the datasets it read.",
    );
  }
  const shownId = specId === undefined ? "no spec id" : JSON.stringify(specId);
  throw refusal(`${reader} reads ${shownId}, which is not a spec id (spec_…).`);
}

function refIds(ref: DatasetRef): string[] {
  return ref.members.flatMap((member) =>
    isDerived(member) ? member.roots.map((root) => root.specId) : [member.spec.spec_id],
  );
}

const refusal = (detail: string): InvalidRequestError =>
  clientError("invalid_argument", { detail });

/**
 * The check `GET /datasets/heads` answered for the specs `asked`, each entry read by its
 * `spec_id` whatever the order.
 *
 * @throws {ContractError} The body is not an object with a `heads` list, an entry names a spec
 *   the request did not or names one twice, an asked spec has no entry, or an entry lacks
 *   `content_version` or holds one that is neither null nor a `cv_` version
 *   (`contract_violation`).
 */
export function readHeads(
  body: unknown,
  asked: readonly string[],
  traceId: string | null,
): StoredVersions {
  const entries = isRecord(body) ? body["heads"] : undefined;
  if (!Array.isArray(entries)) throw violation("/heads", "is not a list", traceId);
  const wanted = new Set(asked);
  const heads: Record<string, string | null> = {};
  for (const [index, entry] of (entries as unknown[]).entries()) {
    const head = isRecord(entry) ? entry : {};
    const specId = head["spec_id"];
    if (typeof specId !== "string" || !wanted.has(specId)) {
      throw violation(`/heads/${index}/spec_id`, "names no spec the request named", traceId);
    }
    if (Object.hasOwn(heads, specId)) {
      throw violation(`/heads/${index}/spec_id`, "repeats a spec", traceId);
    }
    const version = head["content_version"];
    if (
      !Object.hasOwn(head, "content_version") ||
      (version !== null && (typeof version !== "string" || !CONTENT_VERSION.test(version)))
    ) {
      throw violation(
        `/heads/${index}/content_version`,
        "is neither null nor a dataset version",
        traceId,
      );
    }
    heads[specId] = version;
  }
  const missing = asked.filter((specId) => !Object.hasOwn(heads, specId));
  if (missing.length > 0) throw violation("/heads", `leaves out ${missing.join(", ")}`, traceId);
  return storedVersionsOf(heads);
}

function violation(pointer: string, fault: string, traceId: string | null): DfoError {
  return clientError("contract_violation", {
    detail: `${ROUTE} answered heads whose ${pointer} ${fault}.`,
    pointer,
    traceId,
  });
}
