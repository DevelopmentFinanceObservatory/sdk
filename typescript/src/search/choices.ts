/**
 * Which part and option a `choose` call names, and what it posts to Search.
 *
 * A choice of place or source in a one-part answer posts the option's `data_query` unchanged.
 * Any other choice, a pick among one part's candidates included, posts a `dataset_resubmit` with
 * one entry per part, in part order, and Search answers the picked reading with its sentence and
 * assumptions:
 *
 * - the chosen option posts its one parsed part, and a chosen candidate its identity;
 * - a definite part posts its spec's identity and entity groups;
 * - a candidates part left alone posts its candidate set in the server's order, with `ordering`
 *   and `truncated` echoed, since Search cannot recompute that order from a restatement;
 * - any other part posts its `restatement`, which Search resolves again and so keeps its message
 *   and its choices, or a placeholder of its refusal when it has none.
 *
 * Each identity echoes its reading's assumptions: a picked or listed candidate its part's
 * `reading_assumptions` under its `spec_id`, a definite part its own `assumptions`. Each list,
 * and the part's `operations`, posts the items the client reads, each in its read form, so an
 * item whose required members are not strings, and an optional member of another type, are left
 * out. A reading with no list posts none, and Search reads it as a fresh request.
 */
import type { Answer, Candidate, Gap, QueryOption } from "./answer.ts";
import { capped, clientError } from "../core/errors.ts";
import type { InvalidRequestError } from "../core/errors.ts";
import { isRecord } from "../core/json.ts";
import { assumptionsReadOf, operationsOf, parsedPartOf } from "../core/parse.ts";
import { isKnownPart, partText } from "../core/parts.ts";
import type {
  Assumption,
  DatasetResubmitInput,
  ParsedInput,
  ParsedPart,
  Part,
  RequestedOperation,
  ResubmitIdentityEntry,
  Spec,
} from "../wire.ts";

/** A part or option named by its index or its words. */
export type ChoiceKey = number | string;
type Entry = DatasetResubmitInput["entries"][number];

const refuse = (detail: string): InvalidRequestError => clientError("choice_invalid", { detail });

/** The gap of the only part that awaits a choice. */
export function onlyChoice(answer: Answer): Gap {
  const waiting = answer.gaps.filter((gap) => gap.kind === "choice" || gap.options.length > 0);
  if (waiting.length === 1) return waiting[0]!;
  if (waiting.length === 0) throw refuse("No part of this answer awaits a choice.");
  throw refuse(
    `${waiting.length} parts of this answer await a choice; name the part: ` +
      "answer.choose(part, option).",
  );
}

/** The gap of the part a key names: its index, its variable text, or a word its options settle. */
export function gapNamed(answer: Answer, key: ChoiceKey): Gap {
  const index = partIndex(answer, key);
  const gap = answer.gaps.find((candidate) => candidate.partIndex === index);
  if (gap === undefined) throw refuse(`Part ${JSON.stringify(key)} already has a reading.`);
  return gap;
}

function partIndex(answer: Answer, key: ChoiceKey): number {
  const { parts, gaps } = answer;
  if (typeof key === "number") {
    if (Number.isInteger(key) && key >= 0 && key < parts.length) return key;
    throw refuse(`Part ${key} is out of range; the answer has ${parts.length} parts.`);
  }
  let named = parts.flatMap((part, index) => (partText(part) === key ? [index] : []));
  if (named.length === 0) {
    named = gaps
      .filter((gap) => gap.options.some((option) => mentionsOf(option).includes(key)))
      .map((gap) => gap.partIndex);
  }
  if (named.length === 1) return named[0]!;
  if (named.length === 0) {
    throw refuse(`No part is named ${JSON.stringify(key)}; name a part by its index or its words.`);
  }
  throw refuse(`${named.length} parts are named ${JSON.stringify(key)}; use an index.`);
}

/** The question's words an option settles; none for a candidate. */
export const mentionsOf = (option: Candidate | QueryOption): readonly string[] =>
  option.kind === "query" ? option.mentions : [];

/**
 * The candidate or option a key names in a gap. A part named by a word its options settle
 * offers only the options that settle that word.
 */
export function pick(gap: Gap, key: ChoiceKey, mention?: ChoiceKey): Candidate | QueryOption {
  const { options } = gap;
  if (options.length === 0) throw refuse(`Part ${gap.partIndex} offers no choice: ${gap.message}`);
  if (typeof key === "number") {
    const option = Number.isInteger(key) ? options[key] : undefined;
    if (option !== undefined) return option;
    throw refuse(`Option ${key} is out of range; part ${gap.partIndex} offers ${options.length}.`);
  }
  const scope =
    typeof mention === "string" && options.some((option) => mentionsOf(option).includes(mention))
      ? mention
      : undefined;
  const found = options.filter(
    (option) =>
      option.label === key &&
      (scope === undefined || option.kind !== "query" || option.mentions.includes(scope)),
  );
  if (found.length === 1) return found[0]!;
  if (found.length === 0) {
    throw refuse(
      `Part ${gap.partIndex} has no option labelled ${JSON.stringify(key)}; name it by index ` +
        "or label.",
    );
  }
  throw refuse(
    `${found.length} options of part ${gap.partIndex} are labelled ${JSON.stringify(key)}; ` +
      "use an index.",
  );
}

/**
 * The Search input a choice posts. A one-part answer posts a chosen option's query unchanged.
 *
 * @throws {ContractError} The chosen option carries no `data_query`, or one that does not hold
 *   one part, in a one-part answer as in a several-part one.
 */
export function choiceInput(
  answer: Answer,
  gap: Gap,
  chosen: Candidate | QueryOption,
): ParsedInput | DatasetResubmitInput {
  if (answer.parts.length === 1 && chosen.kind === "query") return onePart(chosen).query;
  return {
    kind: "dataset_resubmit",
    entries: answer.parts.map((part, index) =>
      index === gap.partIndex ? chosenEntry(part, chosen) : entry(part),
    ),
  };
}

/** A chosen option's `data_query` and the one part it holds. */
function onePart(option: QueryOption): { query: ParsedInput; part: ParsedPart } {
  const query = option.dataQuery;
  if (query === null) {
    throw clientError("contract_violation", {
      detail: `The option ${capped(JSON.stringify(option.label))} carries no data_query to post back.`,
    });
  }
  const { parts } = query;
  if (parts.length !== 1) {
    throw clientError("contract_violation", {
      detail: `The option ${capped(JSON.stringify(option.label))} does not carry a one-part parsed input.`,
    });
  }
  return { query, part: parts[0]! };
}

function chosenEntry(part: Part, chosen: Candidate | QueryOption): Entry {
  if (chosen.kind === "candidate") return identityEntry(part, chosen.spec);
  return { entry_kind: "parsed", part: onePart(chosen).part };
}

function entry(part: Part): Entry {
  if (isKnownPart(part) && part.status === "definite") return identityEntry(part, part.spec);
  if (isKnownPart(part) && part.status === "candidates") {
    return {
      ...echoed(part),
      entry_kind: "candidates",
      ordering: part.candidates.ordering,
      truncated: part.candidates.truncated,
      candidates: part.candidates.specs.map((spec) => identityOf(spec, readingEcho(part, spec))),
    };
  }
  // Any other part status may carry a restatement, an unknown one included.
  const restatement = parsedPartOf(part.restatement);
  if (restatement !== null) return { entry_kind: "parsed", part: restatement };
  if (isKnownPart(part)) {
    switch (part.status) {
      case "no_data":
        return {
          ...echoed(part),
          entry_kind: "placeholder",
          status: "no_data",
          reason: part.no_data.reason,
        };
      case "unsupported":
        return {
          ...echoed(part),
          entry_kind: "placeholder",
          status: "unsupported",
          code: part.unsupported.code,
        };
    }
  }
  throw refuse(
    `Part ${JSON.stringify(partText(part) ?? "")} has status ${JSON.stringify(part.status)}, ` +
      "which this client cannot post back; upgrade @developmentfinance/client.",
  );
}

/** A reading's identity, its entity groups when it has any, and its assumptions echo unless it
 *  has none to echo. */
function identityOf(
  spec: Spec,
  assumptions: readonly Assumption[] | undefined,
): Pick<ResubmitIdentityEntry, "identity" | "entity_groups" | "assumptions"> {
  const groups = spec.resolved.entity_groups;
  return {
    identity: spec.definition.identity,
    ...(isRecord(groups) && Object.keys(groups).length > 0 ? { entity_groups: groups } : {}),
    ...(assumptions === undefined ? {} : { assumptions: [...assumptions] }),
  };
}

/** The identity entry that posts `spec` as the reading of `part`, the one entry a candidate's
 *  fetch posts on its own. */
export function identityEntry(part: Part, spec: Spec): ResubmitIdentityEntry {
  return { ...echoed(part), entry_kind: "identity", ...identityOf(spec, readingEcho(part, spec)) };
}

/** The assumptions a resubmitted reading of `part` echoes, each in its read form and an item that
 *  does not read left out: a candidates part's `reading_assumptions` under the reading's
 *  `spec_id`, else the part's own `assumptions`. Undefined when the part holds no list for the
 *  reading. `[]` states none. */
function readingEcho(part: Part, spec: Spec): readonly Assumption[] | undefined {
  if (isKnownPart(part) && part.status === "candidates") {
    const byReading: unknown = part.reading_assumptions;
    return isRecord(byReading) ? assumptionsReadOf(byReading[spec.spec_id]) : undefined;
  }
  return assumptionsReadOf(part.assumptions);
}

/** The members every entry other than a parsed one echoes from its part: `variable_text`,
 *  `separate` when true, and `operations` in their read forms when any item reads. */
function echoed(part: Part): {
  variable_text: string;
  separate?: boolean;
  operations?: RequestedOperation[];
} {
  const variableText = partText(part);
  if (variableText === null || variableText === "") {
    throw refuse("A part without variable text cannot be posted back; search again.");
  }
  const operations = operationsOf(part.operations);
  return {
    variable_text: variableText,
    ...(part.separate === true ? { separate: true } : {}),
    ...(operations.length > 0 ? { operations: [...operations] } : {}),
  };
}
