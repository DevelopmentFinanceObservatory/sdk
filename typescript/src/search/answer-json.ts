/**
 * The answer format: an answer as JSON, which `answer.toJSON()` writes and `Answer.fromJSON`
 * reads, the same in every DFO client.
 *
 * The format is `{"format_version": 1, "question": …, "answer": …}`. An answer to a search by
 * codes is `format_version` 2 with `"codes": […]` beside the same members. `question` is the
 * question asked, or null. `answer` is the Search response body cut to the members a client
 * reads, which `KEPT` lists, with the answer's trace id as its `trace_id` when it has one.
 * `codes` holds the series code each part was asked by, one per part in part order, so an
 * answer read back checks each reading against the code the caller asked for. An answer to a
 * question in words holds no `codes`. The cut drops what no rule reads, such as each spec's
 * `resolved.trace` and slots, the sentence-plan tokens' references, and the diagnostics beyond
 * `timed_out` and `warnings`. A member the cut keeps holds the value the response held,
 * malformed or not, so the body reads back exactly as the response read.
 */
import { InvalidRequestError } from "../core/errors.ts";
import { FormatError } from "../core/ref.ts";
import { isRecord, parseJson } from "../core/json.ts";
import { traceIdFrom } from "../core/trace.ts";
import { checkedCodes } from "./structured.ts";

/** The members a cut keeps under one object: `true` keeps the member's value whole, and a nested
 *  table keeps only its members, of the object the member holds or of each object item of the
 *  array it holds. */
type Kept = { readonly [member: string]: true | Kept };

const SPEC: Kept = {
  spec_id: true,
  definition: true,
  resolved: {
    rendered_sentence: true,
    entity_groups: true,
    stat_vars: { source_codes: true },
    sentence_plan: { segment: true, kind: true, axis: true, text: true },
    facets: { provenance: { label: true } },
  },
};

const PART: Kept = {
  status: true,
  variable_text: true,
  rendered_sentence: true,
  separate: true,
  restatement: true,
  operations: true,
  assumptions: true,
  reading_assumptions: true,
  departures: true,
  warnings: true,
  spec: SPEC,
  candidates: { specs: SPEC, ordering: true, truncated: true },
  no_data: {
    reason: true,
    message: true,
    options: { label: true, mentions: true, data_query: true },
  },
  unsupported: { code: true, detail: true },
};

/** The members of a Search response body that a client reads. */
export const KEPT: Kept = {
  kind: true,
  status: true,
  rendered_sentence: true,
  reason: true,
  parts: PART,
  diagnostics: { timed_out: true, warnings: true },
};

export const ANSWER_FORMAT_VERSION = 1;
/** The format of an answer to a search by codes, which holds `codes`. */
export const CODES_FORMAT_VERSION = 2;

/** An answer as JSON, in the answer format: format 1 for an answer to a question in words, and
 *  format 2, with the series code each part was asked by, for an answer to a search by codes. */
export type AnswerJson =
  | {
      format_version: 1;
      question: string | null;
      answer: Readonly<Record<string, unknown>>;
    }
  | {
      format_version: 2;
      question: string | null;
      answer: Readonly<Record<string, unknown>>;
      codes: string[];
    };

/** The value with only the members `kept` names: an object's, or each object item's of an
 *  array. Any other value stays as it is. */
function cut(value: unknown, kept: Kept): unknown {
  if (Array.isArray(value)) return value.map((item) => cut(item, kept));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [member, child] of Object.entries(value)) {
    const rule = Object.hasOwn(kept, member) ? kept[member] : undefined;
    if (rule === undefined || child === undefined) continue;
    out[member] = rule === true ? child : cut(child, rule);
  }
  return out;
}

/** A Search response body in the answer format, its trace id set to `traceId`, and `codes` the
 *  series code each part was asked by, or null for a question in words. */
export function answerJson(
  question: string | null,
  body: Readonly<Record<string, unknown>>,
  traceId: string | null,
  codes: readonly string[] | null,
): AnswerJson {
  const cutBody = cut(body, KEPT) as Record<string, unknown>;
  const answer = traceId === null ? cutBody : { ...cutBody, trace_id: traceId };
  if (codes === null) return { format_version: ANSWER_FORMAT_VERSION, question, answer };
  return { format_version: CODES_FORMAT_VERSION, question, answer, codes: [...codes] };
}

const invalid = (pointer: string, detail: string): FormatError =>
  new FormatError("format_invalid", pointer, detail);

/**
 * The question, the body, its trace id and the codes its parts were asked by, from JSON in the
 * answer format, its text or the parsed value. The codes are null when the JSON holds none. The
 * body is checked as a Search response is, by the caller.
 *
 * @throws {FormatError} The value is not JSON, not an object, has a member the format does not
 *   name or lacks one, its `format_version` is not 1 or 2, it holds `codes` at format 1 or lacks
 *   them at format 2, its `question` is not a string or null, its `answer` is not an object, or
 *   its `codes` break the rule `client.search({ codes })` holds them to or do not hold one code
 *   per part of the answer (`format_invalid`).
 */
export function readAnswerJson(value: unknown): {
  question: string | null;
  body: Record<string, unknown>;
  traceId: string | null;
  codes: readonly string[] | null;
} {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = parseJson(value);
    } catch (error) {
      throw Object.assign(invalid("", "not JSON"), { cause: error });
    }
  }
  if (!isRecord(parsed)) throw invalid("", "not an object");
  const members = ["format_version", "question", "answer"];
  for (const member of members) {
    if (!Object.hasOwn(parsed, member)) throw invalid(`/${member}`, "missing");
  }
  for (const member of Object.keys(parsed)) {
    if (!members.includes(member) && member !== CODES) {
      throw invalid(`/${member}`, "not a member of the format");
    }
  }
  const version = parsed["format_version"];
  if (version !== ANSWER_FORMAT_VERSION && version !== CODES_FORMAT_VERSION) {
    throw invalid("/format_version", `not ${ANSWER_FORMAT_VERSION} or ${CODES_FORMAT_VERSION}`);
  }
  const hasCodes = Object.hasOwn(parsed, CODES);
  if (version === CODES_FORMAT_VERSION && !hasCodes) throw invalid(`/${CODES}`, "missing");
  if (version === ANSWER_FORMAT_VERSION && hasCodes) {
    throw invalid(`/${CODES}`, `not in format ${ANSWER_FORMAT_VERSION}`);
  }
  const { question, answer } = parsed;
  if (typeof question !== "string" && question !== null) {
    throw invalid("/question", "not a string or null");
  }
  if (!isRecord(answer)) throw invalid("/answer", "not an object");
  const codes = hasCodes ? readCodes(parsed[CODES], answer) : null;
  return { question, body: answer, traceId: traceIdFrom(answer["trace_id"]), codes };
}

const CODES = "codes";

/** The `codes` member, read as `client.search({ codes })` reads codes, one per part of `body`. */
function readCodes(value: unknown, body: Readonly<Record<string, unknown>>): readonly string[] {
  const pointer = `/${CODES}`;
  let codes: string[];
  try {
    codes = checkedCodes(value);
  } catch (error) {
    if (!(error instanceof InvalidRequestError)) throw error;
    throw Object.assign(invalid(pointer, error.detail), { cause: error });
  }
  const parts = body["parts"];
  const count = Array.isArray(parts) ? parts.length : 0;
  if (count !== codes.length) {
    throw invalid(pointer, `holds ${codes.length} codes for ${count} parts; it holds one per part`);
  }
  return codes;
}
