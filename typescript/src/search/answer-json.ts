/**
 * The answer format: an answer as JSON, which `answer.toJSON()` writes and `Answer.fromJSON`
 * reads, the same in every DFO client.
 *
 * The format is `{"format_version": 1, "question": …, "answer": …}`. `question` is the question
 * asked, or null. `answer` is the Search response body cut to the members a client reads, which
 * `KEPT` lists, with the answer's trace id as its `trace_id` when it has one. The cut drops what no rule reads,
 * such as each spec's `resolved.trace` and slots, the sentence-plan tokens' references, and the
 * diagnostics beyond `timed_out` and `warnings`. A member the cut keeps holds the value the
 * response held, malformed or not, so the body reads back exactly as the response read.
 */
import { FormatError } from "../core/ref.ts";
import { isRecord, parseJson } from "../core/json.ts";
import { traceIdFrom } from "../core/trace.ts";

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

/** An answer as JSON, in the answer format. */
export type AnswerJson = {
  format_version: 1;
  question: string | null;
  answer: Readonly<Record<string, unknown>>;
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

/** A Search response body in the answer format, its trace id set to `traceId`. */
export function answerJson(
  question: string | null,
  body: Readonly<Record<string, unknown>>,
  traceId: string | null,
): AnswerJson {
  const answer = cut(body, KEPT) as Record<string, unknown>;
  return {
    format_version: ANSWER_FORMAT_VERSION,
    question,
    answer: traceId === null ? answer : { ...answer, trace_id: traceId },
  };
}

const invalid = (pointer: string, detail: string): FormatError =>
  new FormatError("format_invalid", pointer, detail);

/**
 * The question, the body and its trace id from JSON in the answer format, its text or the
 * parsed value. The body is checked as a Search response is, by the caller.
 *
 * @throws {FormatError} The value is not JSON, not an object, has a member the format does not
 *   name or lacks one, its `format_version` is not 1, its `question` is not a string or null, or
 *   its `answer` is not an object (`format_invalid`).
 */
export function readAnswerJson(value: unknown): {
  question: string | null;
  body: Record<string, unknown>;
  traceId: string | null;
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
    if (!members.includes(member)) throw invalid(`/${member}`, "not a member of the format");
  }
  if (parsed["format_version"] !== ANSWER_FORMAT_VERSION) {
    throw invalid("/format_version", `not ${ANSWER_FORMAT_VERSION}`);
  }
  const { question, answer } = parsed;
  if (typeof question !== "string" && question !== null) {
    throw invalid("/question", "not a string or null");
  }
  if (!isRecord(answer)) throw invalid("/answer", "not an object");
  return { question, body: answer, traceId: traceIdFrom(answer["trace_id"]) };
}
