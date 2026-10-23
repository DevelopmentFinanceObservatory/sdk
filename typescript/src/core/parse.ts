/**
 * The facts the client reads from a Search part beyond its strict members: what Search assumed,
 * how the reading departs from the question, the computations it left undone, and the part's
 * warnings. Answer, Candidate, hints, fetch and Dataset all read them here, so one rule
 * applies to each field. A holder of the wrong type reads as absent, and an item that lacks a
 * required member or holds one of the wrong type is dropped. The resubmit echo posts the part's
 * own lists as the server sent them. The strict check (`strict.ts`) owns the strict members and
 * raises `ContractError` at their pointer.
 */
import { isRecord, list, objects, text } from "./json.ts";
import type {
  Assumption,
  Departure,
  ParsedInput,
  ParsedPart,
  RequestedOperation,
  Warning,
  WarningModel,
} from "../wire.ts";

/** What one part states beside its reading. */
export type PartFacts = {
  /** The part's `assumptions`, or undefined when it holds no list; `[]` states none. */
  readonly assumptions: readonly Assumption[] | undefined;
  /** A candidates part's `reading_assumptions`, by `spec_id`; a reading with no list is absent. */
  readonly readingAssumptions: ReadonlyMap<string, readonly Assumption[]>;
  readonly departures: readonly Departure[];
  readonly operations: readonly RequestedOperation[];
  readonly warnings: readonly Warning[];
};

/** A part's facts, read afresh on each call. */
export function partFacts(part: Readonly<Record<string, unknown>>): PartFacts {
  const byReading = part["reading_assumptions"];
  const readings = new Map<string, readonly Assumption[]>();
  if (isRecord(byReading)) {
    for (const [specId, listed] of Object.entries(byReading)) {
      const assumptions = assumptionsOf(listed);
      if (assumptions !== undefined) readings.set(specId, assumptions);
    }
  }
  return Object.freeze({
    assumptions: assumptionsOf(part["assumptions"]),
    readingAssumptions: readings,
    departures: itemsOf(part["departures"], departureOf),
    operations: itemsOf(part["operations"], operationOf),
    warnings: warningsOf(part["warnings"]),
  });
}

/** The items of a JSON array that `readItem` reads, frozen; empty when the value is no array. */
function itemsOf<T>(
  value: unknown,
  readItem: (item: Record<string, unknown>) => T | null,
): readonly T[] {
  return Object.freeze(
    objects(value).flatMap((item) => {
      const found = readItem(item);
      return found === null ? [] : [found];
    }),
  );
}

const strings = (value: unknown): string[] =>
  list(value).filter((item): item is string => typeof item === "string");

const optionalString = (value: unknown): string | null | undefined =>
  typeof value === "string" || value === null ? value : undefined;

/** A list of assumptions, or undefined when the value is not a list. */
function assumptionsOf(value: unknown): readonly Assumption[] | undefined {
  return Array.isArray(value) ? itemsOf(value, assumptionOf) : undefined;
}

function assumptionOf(item: Record<string, unknown>): Assumption | null {
  const { kind, binding_ref: bindingRef, text: said } = item;
  if (typeof kind !== "string" || typeof bindingRef !== "string" || typeof said !== "string") {
    return null;
  }
  return { kind, binding_ref: bindingRef, text: said, refs: strings(item["refs"]) };
}

function departureOf(item: Record<string, unknown>): Departure | null {
  const { code, text: said } = item;
  if (typeof code !== "string" || typeof said !== "string") return null;
  const bindingRef = optionalString(item["binding_ref"]);
  const asked = optionalString(item["asked"]);
  const shown = optionalString(item["shown"]);
  return {
    code,
    text: said,
    ...(bindingRef === undefined ? {} : { binding_ref: bindingRef }),
    ...(asked === undefined ? {} : { asked }),
    ...(shown === undefined ? {} : { shown }),
  };
}

function operationOf(item: Record<string, unknown>): RequestedOperation | null {
  const { verb, phrase } = item;
  if (typeof verb !== "string" || typeof phrase !== "string") return null;
  const over = optionalString(item["over"]);
  const targetYear = item["target_year"];
  return {
    verb,
    phrase,
    ...(over === undefined ? {} : { over }),
    ...(typeof targetYear === "number" || targetYear === null ? { target_year: targetYear } : {}),
  };
}

type Notice = { code: string; severity: string; message: string };

/** A warning's notice, or null when it lacks a member in `required`. The members a rule reads are
 *  required. Any other reads as `""` when it is absent or not a string, as the Python client
 *  reads it. */
function noticeOf(
  item: Record<string, unknown>,
  required: readonly (keyof Notice)[],
): Notice | null {
  if (required.some((name) => typeof item[name] !== "string")) return null;
  const read = (name: keyof Notice): string => {
    const value = item[name];
    return typeof value === "string" ? value : "";
  };
  return { code: read("code"), severity: read("severity"), message: read("message") };
}

type Param = NonNullable<Warning["params"]>[string];

const isParam = (value: unknown): value is Param =>
  typeof value === "number" ||
  typeof value === "string" ||
  (Array.isArray(value) && value.every((item) => typeof item === "string"));

function paramsOf(value: Record<string, unknown>): Record<string, Param> {
  const params: Record<string, Param> = {};
  for (const [name, param] of Object.entries(value)) if (isParam(param)) params[name] = param;
  return params;
}

/** Search's warnings in a JSON array: an answer's `diagnostics.warnings` or a part's. A warning
 *  needs the `severity` and `message` the `SearchWarning` condition reads. */
export function warningsOf(value: unknown): readonly Warning[] {
  return itemsOf(value, (item) => {
    const notice = noticeOf(item, ["severity", "message"]);
    if (notice === null) return null;
    const specId = optionalString(item["spec_id"]);
    const params = item["params"];
    return {
      ...notice,
      ...(specId === undefined ? {} : { spec_id: specId }),
      ...(params === null ? { params } : {}),
      ...(isRecord(params) ? { params: paramsOf(params) } : {}),
    };
  });
}

/** The datasets surface's warnings in a manifest's JSON array. A warning needs the `severity`
 *  the `DataWarning` condition reads. */
export function manifestWarningsOf(value: unknown): readonly WarningModel[] {
  return itemsOf(value, (item) => {
    const notice = noticeOf(item, ["severity"]);
    if (notice === null) return null;
    const count = item["contributing_member_count"];
    const ref = optionalString(item["stat_var_ref"]);
    const label = optionalString(item["stat_var_label"]);
    return {
      ...notice,
      ...(typeof count === "number" || count === null ? { contributing_member_count: count } : {}),
      ...(ref === undefined ? {} : { stat_var_ref: ref }),
      ...(label === undefined ? {} : { stat_var_label: label }),
    };
  });
}

/** A parsed part Search sent to post back, such as a part's `restatement`, or null when the value
 *  is not an object with string `variable_text`. Its other members pass to Search unchanged. */
export function parsedPartOf(value: unknown): ParsedPart | null {
  if (!isRecord(value)) return null;
  const variableText = text(value["variable_text"]);
  return variableText === null ? null : { ...value, variable_text: variableText };
}

/** A parsed input Search sent to post back, such as an option's `data_query`, or null when the
 *  value is not an object whose `kind` is `parsed` and whose `parts` are an array of parsed parts. */
export function parsedInputOf(value: unknown): ParsedInput | null {
  if (!isRecord(value) || value["kind"] !== "parsed" || !Array.isArray(value["parts"])) return null;
  const parts: ParsedPart[] = [];
  for (const item of value["parts"]) {
    const part = parsedPartOf(item);
    if (part === null) return null;
    parts.push(part);
  }
  return { ...value, kind: "parsed", parts };
}
