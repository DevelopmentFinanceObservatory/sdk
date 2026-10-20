/**
 * Choices: which part and option a `choose` call names, and what it posts to Search.
 *
 * A choice of place or source in a one-part answer posts the option's `data_query` unchanged. A
 * choice in an answer of several parts posts a `dataset_resubmit` with one entry per part, in
 * part order, so Search composes the joined sentence and folds the parts again:
 *
 * - the chosen option posts its one parsed part, and a chosen candidate its identity;
 * - a definite part posts its spec's identity and entity groups;
 * - a candidates part left alone posts its candidate set in the server's order, with `ordering`
 *   and `truncated` echoed, since Search cannot recompute that order from a restatement;
 * - any other part posts its `restatement`, which Search resolves again and so keeps its message
 *   and its choices, or a placeholder of its refusal when it has none.
 */
import type { Answer, Candidate, Gap, QueryOption } from "./answer.ts";
import { ContractError, InvalidRequestError } from "./errors.ts";
import { isKnownPart } from "./parts.ts";
import type {
  DatasetResubmitInput,
  ParsedInput,
  ParsedPart,
  Part,
  RequestedOperation,
  ResubmitIdentityEntry,
  Spec,
} from "./wire.ts";

type ChoiceKey = number | string;
type Entry = DatasetResubmitInput["entries"][number];

const refuse = (detail: string): InvalidRequestError =>
  new InvalidRequestError({ code: "choice_invalid", detail });

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
  let named = parts.flatMap((part, index) => (part.variable_text === key ? [index] : []));
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

const mentionsOf = (option: Candidate | QueryOption): readonly string[] =>
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

/** The Search input a choice posts. A one-part answer posts the option's query unchanged. */
export function choiceInput(
  answer: Answer,
  gap: Gap,
  chosen: Candidate | QueryOption,
): ParsedInput | DatasetResubmitInput {
  if (answer.parts.length === 1 && chosen.kind === "query") return chosen.dataQuery;
  return {
    kind: "dataset_resubmit",
    entries: answer.parts.map((part, index) =>
      index === gap.partIndex ? chosenEntry(part, chosen) : entry(part),
    ),
  };
}

function chosenEntry(part: Part, chosen: Candidate | QueryOption): Entry {
  if (chosen.kind === "candidate") return identityEntry(part, chosen.spec);
  const parts = chosen.dataQuery.parts as ParsedInput["parts"] | undefined;
  if (!Array.isArray(parts) || parts.length !== 1) {
    throw new ContractError({
      code: "contract_violation",
      detail: `The option ${JSON.stringify(chosen.label)} does not carry a one-part parsed input.`,
    });
  }
  return { entry_kind: "parsed", part: parts[0]! };
}

function entry(part: Part): Entry {
  if (isKnownPart(part) && part.status === "definite") return identityEntry(part, part.spec);
  if (isKnownPart(part) && part.status === "candidates") {
    return {
      ...echoed(part),
      entry_kind: "candidates",
      ordering: part.candidates.ordering,
      truncated: part.candidates.truncated,
      candidates: part.candidates.specs.map(identityOf),
    };
  }
  // Any other part status may carry a restatement, an unknown one included.
  const restatement = part.restatement as ParsedPart | null | undefined;
  if (restatement != null) return { entry_kind: "parsed", part: restatement };
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
    `Part ${JSON.stringify(part.variable_text)} has status ${JSON.stringify(part.status)}, ` +
      "which this client cannot post back; upgrade @developmentfinance/client.",
  );
}

function identityOf(spec: Spec): Pick<ResubmitIdentityEntry, "identity" | "entity_groups"> {
  const groups = spec.resolved.entity_groups;
  return {
    identity: spec.definition.identity,
    ...(groups != null && Object.keys(groups).length > 0 ? { entity_groups: groups } : {}),
  };
}

function identityEntry(part: Part, spec: Spec): ResubmitIdentityEntry {
  return { ...echoed(part), entry_kind: "identity", ...identityOf(spec) };
}

/** The members every entry other than a parsed one echoes from its part. */
function echoed(part: Part): {
  variable_text: string;
  separate?: boolean;
  operations?: RequestedOperation[];
} {
  const variableText = part.variable_text;
  if (typeof variableText !== "string" || variableText === "") {
    throw refuse("A part without variable text cannot be posted back; search again.");
  }
  const operations = part.operations as RequestedOperation[] | undefined;
  return {
    variable_text: variableText,
    ...(part.separate === true ? { separate: true } : {}),
    ...(Array.isArray(operations) && operations.length > 0 ? { operations } : {}),
  };
}
