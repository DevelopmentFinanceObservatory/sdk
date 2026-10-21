/**
 * Answers: what Search understood a question to ask, part by part.
 *
 * An answer holds readings, not data. `fetch` builds the dataset when every part has a reading,
 * and raises `IncompleteAnswerError` before any build when one does not. `choose` settles a part
 * that awaits a choice and returns a new answer.
 */
import { answerText, declinedText, incompleteMessage, readingHints } from "./answer-text.ts";
import { choiceInput, gapNamed, onlyChoice, pick, pickedEntry } from "./choices.ts";
import { clientError } from "./errors.ts";
import type { IncompleteAnswerError } from "./errors.ts";
import type { Dataset } from "./dataset.ts";
import { fetchMembers as defaultFetchMembers } from "./fetch.ts";
import type { FetchMembersOptions, MemberRequest } from "./fetch.ts";
import { CODE_GAP_KINDS } from "./generated/actions.ts";
import type { GAP_KINDS } from "./generated/actions.ts";
import { isKnownPart } from "./parts.ts";
import { checkStrict } from "./strict.ts";
import type { Transport } from "./transport.ts";
import { DfoWarning, emitWarning } from "./warnings.ts";
import type { WarningHandler } from "./warnings.ts";
import type {
  CandidatesPart,
  DatasetResubmitInput,
  DefinitePart,
  NoData,
  ParsedInput,
  Part,
  RawTextInput,
  Spec,
  Warning,
} from "./wire.ts";

export const RESOLVE_PATH = "/search/resolve";
const SCHEMA_VERSION = 1;
/** Longer than Search's 45-second soft deadline, so a slow answer arrives whole. */
export const SEARCH_TIMEOUT_MS = 60_000;

const TIMED_OUT =
  "Search reached its time limit before this part resolved; search again, or ask for less at once.";

/** What a gap needs to settle it: the contract's gap kinds, or one the client derives. */
export type GapKind = (typeof GAP_KINDS)[number] | "timed_out" | "unknown";

/** Builds a candidate's dataset through the answer it came from. */
type CandidateFetch = (candidate: Candidate, options: AnswerFetchOptions) => Promise<Dataset<Gap>>;

/**
 * One reading of a part that has several. The label, unit and source split its sentence.
 *
 * A candidate in an `Answer` fetches through that answer. One in `Dataset.missing` or in
 * `IncompleteAnswerError.gaps` belongs to no answer and holds no client; fetch its spec with
 * `client.fetch(candidate.spec)`.
 */
export class Candidate {
  readonly kind = "candidate";
  readonly spec: Spec;
  /** Search's sentence for the reading. */
  readonly sentence: string | null;
  /** The sentence's heading. */
  readonly label: string;
  /** The provenance the reading reads from, such as "OECD DAC1". */
  readonly source: string | null;
  /** The byline's unit, such as "Current US dollars". */
  readonly unit: string | null;
  readonly #fetch: CandidateFetch | null;

  /** Candidates come from an answer; this constructor is the client's. */
  constructor(
    reading: Pick<Candidate, "spec" | "sentence" | "label" | "source" | "unit">,
    fetch: CandidateFetch | null = null,
  ) {
    this.spec = reading.spec;
    this.sentence = reading.sentence;
    this.label = reading.label;
    this.source = reading.source;
    this.unit = reading.unit;
    this.#fetch = fetch;
  }

  /**
   * Builds this reading's dataset. It asks Search for this reading alone, one request with no
   * model call, and fetches that answer with `Answer.fetch`'s options; in a one-part answer that
   * is the answer `answer.choose(candidate)` gives.
   *
   * @throws {InvalidRequestError} The candidate came from no answer.
   */
  async fetch(options: AnswerFetchOptions = {}): Promise<Dataset<Gap>> {
    if (this.#fetch === null) {
      throw clientError("invalid_argument", {
        detail:
          "candidate.fetch() cannot build this reading: it came from no answer; fetch its spec " +
          "with client.fetch(candidate.spec).",
      });
    }
    return this.#fetch(this, options);
  }

  /** The same reading, belonging to no answer. */
  unbound(): Candidate {
    return this.#fetch === null ? this : new Candidate(this);
  }
}

/** One way to settle a part that awaits a choice of place or source. */
export type QueryOption = {
  readonly kind: "query";
  /** The choice as the user reads it, such as "Congo [DRC]". */
  readonly label: string;
  /** The question's words the choice settles. */
  readonly mentions: readonly string[];
  /** The parsed question with the choice pinned, posted back to Search unchanged. */
  readonly dataQuery: ParsedInput;
};

/** A part that stops an answer from building a complete dataset. */
export type Gap = {
  /** The part's position in the answer. */
  readonly partIndex: number;
  readonly part: Part;
  readonly kind: GapKind;
  /** What the user reads about it. */
  readonly message: string;
  /** The choices that settle it: a candidates part's readings, or a refusal's options. */
  readonly options: readonly (Candidate | QueryOption)[];
};

/** What an answer's requests go through. The client builds it. */
export type AnswerContext = {
  readonly transport: Transport;
  readonly onWarning?: WarningHandler;
  /** Builds the answer's members; `fetchMembers` from the fetch module unless a test swaps it. */
  readonly fetchMembers?: (
    transport: Transport,
    members: readonly MemberRequest[],
    options: FetchMembersOptions<Gap>,
  ) => Promise<Dataset<Gap>>;
};

export type SearchOptions = {
  readonly signal?: AbortSignal;
  /** The deadline for the call, retries included, in milliseconds. */
  readonly timeout?: number;
};

/** A fetch's options, less the gaps the answer supplies. `strict` also throws the
 *  `SearchWarning` instead of issuing it. */
export type AnswerFetchOptions = Omit<FetchMembersOptions<Gap>, "missing" | "narrowing"> & {
  /** Build the parts that have a reading when others do not; the dataset lists the gaps. */
  readonly partial?: boolean;
};

type ChoiceKey = number | string;

/** How the readings an answer builds differ from the question: departures, computations Search
 *  did not run, and its `warn` and `degraded` warnings. */
export class SearchWarning extends DfoWarning {}
Object.defineProperty(SearchWarning.prototype, "name", {
  value: "SearchWarning",
  configurable: true,
});

type AnswerInit = {
  kind: string;
  status: string;
  sentence: string | null;
  parts?: readonly Part[];
  question: string | null;
  reason?: string | null;
  warnings?: readonly Warning[];
  timedOut?: boolean;
  raw: unknown;
  context: AnswerContext;
};

/** What Search understood a question to ask, as one reading per part. */
export class Answer {
  /** `resolution`, `catalogue` or `declined`. */
  readonly kind: string;
  /** The parts' shared status, `mixed` when they differ, or the kind for a declined or
   *  catalogue answer. */
  readonly status: string;
  /** Search's sentence for the whole answer; null for a declined or catalogue answer. */
  readonly sentence: string | null;
  /** One part per variable asked, in query order. */
  readonly parts: readonly Part[];
  /** The readings, one per distinct `spec_id`, in query order. */
  readonly specs: readonly Spec[];
  /** Whether every part has a reading. */
  readonly complete: boolean;
  /** The parts that stop a complete dataset, in query order. */
  readonly gaps: readonly Gap[];
  /** The question asked, when the answer came from one. */
  readonly question: string | null;
  /** Why Search declined, for a declined answer. */
  readonly reason: string | null;
  /** Search's warnings for the whole answer. */
  readonly warnings: readonly Warning[];
  /** Whether Search stopped at its time limit. */
  readonly timedOut: boolean;
  /** The decoded response body, untouched. */
  readonly raw: unknown;
  readonly #context: AnswerContext;

  /** Answers come from `client.search`; this constructor is the client's. */
  constructor(init: AnswerInit) {
    this.kind = init.kind;
    this.status = init.status;
    this.sentence = init.sentence;
    this.parts = init.parts ?? [];
    this.question = init.question;
    this.reason = init.reason ?? null;
    this.warnings = init.warnings ?? [];
    this.timedOut = init.timedOut ?? false;
    this.raw = init.raw;
    this.#context = init.context;
    const bind =
      (part: CandidatesPart): CandidateFetch =>
      async (candidate, options) => {
        const input: DatasetResubmitInput = {
          kind: "dataset_resubmit",
          entries: [pickedEntry(part, candidate)],
        };
        const signal = options.signal === undefined ? {} : { signal: options.signal };
        const picked = await resolveAnswer(this.#context, input, {
          ...signal,
          question: this.question,
        });
        return picked.fetch(options);
      };
    this.gaps = this.parts.flatMap((part, index) => {
      const gap = gapFor(index, part, this.timedOut, bind);
      return gap === null ? [] : [gap];
    });
    this.complete = this.kind === "resolution" && this.gaps.length === 0;
    this.specs = [
      ...new Map(definiteParts(this.parts).map((p) => [p.spec.spec_id, p.spec])).values(),
    ];
  }

  /**
   * Settles a part that awaits a choice and returns Search's answer to it, one request with no
   * model call. `choose(option)` picks in the only part that awaits one; `choose(part, option)`
   * names the part by its index, its variable text, or a word of the question its options settle.
   * An option is named by its index or label. The picked answer's sentence and assumptions are
   * Search's.
   *
   * @throws {InvalidRequestError} No part, or more than one, awaits a choice; the part or option
   *   is unknown; or the part offers no options.
   */
  choose(option: ChoiceKey, options?: SearchOptions): Promise<Answer>;
  choose(part: ChoiceKey, option: ChoiceKey, options?: SearchOptions): Promise<Answer>;
  async choose(
    first: ChoiceKey,
    second?: ChoiceKey | SearchOptions,
    third?: SearchOptions,
  ): Promise<Answer> {
    const named = typeof second === "number" || typeof second === "string";
    const gap = named ? gapNamed(this, first) : onlyChoice(this);
    const chosen = pick(gap, named ? second : first, named ? first : undefined);
    const options = (named ? third : second) ?? {};
    return resolveAnswer(this.#context, choiceInput(this, gap, chosen), {
      ...options,
      question: this.question,
    });
  }

  /**
   * Builds the dataset for the answer's readings. Each distinct spec builds once; several
   * readings stack into one long table with a `part` column.
   *
   * @throws {DeclinedError} Search declined the question or answered with the catalogue.
   * @throws {IncompleteAnswerError} A part has no reading and `partial` is false, or no part has
   *   one.
   * @throws {SearchWarning} `strict` is true and the reading differs from the question.
   * @throws {DataWarning} `strict` is true and a manifest carries a warning above `info`.
   */
  async fetch(options: AnswerFetchOptions = {}): Promise<Dataset<Gap>> {
    if (this.kind !== "resolution") {
      throw clientError("answer_declined", {
        detail: declinedText(this.kind, this.reason),
      });
    }
    const { partial, ...fetchOptions } = options;
    const members = membersOf(this.parts);
    if (this.gaps.length > 0 && (partial !== true || members.length === 0)) {
      throw this.incompleteError();
    }
    const hints = readingHints(this, { departures: true });
    if (hints.length > 0) {
      const warning = new SearchWarning(
        hints.length === 1 ? hints[0]!.code : null,
        `Search's reading differs from your question:\n  ${hints.map((h) => h.line).join("\n  ")}`,
      );
      if (options.strict === true) throw warning;
      (this.#context.onWarning ?? emitWarning)(warning);
    }
    const build = this.#context.fetchMembers ?? defaultFetchMembers;
    return build(this.#context.transport, members, {
      ...fetchOptions,
      missing: this.gaps.map(unboundGap),
    });
  }

  /** The error `fetch` raises for this answer's gaps. */
  incompleteError(): IncompleteAnswerError {
    return clientError("answer_incomplete", {
      detail: incompleteMessage(this),
      answer: this,
      gaps: this.gaps.map(unboundGap),
    });
  }

  /** The answer as a reader sees it: the sentence, or what is missing. */
  toString(): string {
    return answerText(this);
  }
}

/** Posts one Search input and reads the answer. */
export async function resolveAnswer(
  context: AnswerContext,
  input: RawTextInput | ParsedInput | DatasetResubmitInput,
  options: SearchOptions & { question: string | null },
): Promise<Answer> {
  const response = await context.transport.request({
    path: RESOLVE_PATH,
    json: { schema_version: SCHEMA_VERSION, input },
    timeout: options.timeout ?? SEARCH_TIMEOUT_MS,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return answerFromBody(response.body, context, options.question);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * Reads a decoded Search response into an answer.
 *
 * @throws {ContractError} The body is not an object, its kind is unknown, or a member the client
 *   acts on is missing.
 */
export function answerFromBody(
  body: unknown,
  context: AnswerContext,
  question: string | null,
): Answer {
  if (!isRecord(body)) {
    throw clientError("contract_violation", {
      detail: "The Search response is not an object.",
    });
  }
  const diagnostics = isRecord(body["diagnostics"]) ? body["diagnostics"] : {};
  const warnings = Array.isArray(diagnostics["warnings"])
    ? (diagnostics["warnings"] as unknown[]).filter(isRecord).map((w) => w as Warning)
    : [];
  const kind = body["kind"];
  if (kind === "declined" || kind === "catalogue") {
    return new Answer({
      kind,
      status: kind,
      sentence: null,
      question,
      reason: kind === "declined" ? text(body["reason"]) : null,
      warnings,
      raw: body,
      context,
    });
  }
  if (kind !== "resolution") {
    throw clientError("contract_violation", {
      detail:
        `Search answered with kind ${JSON.stringify(kind)}, which this client does not know; ` +
        "upgrade @developmentfinance/client.",
    });
  }
  checkStrict("Resolution", body);
  const parts = body["parts"];
  if (!Array.isArray(parts) || !parts.every(isRecord)) {
    throw clientError("contract_violation", {
      detail: "Resolution.parts is not an array of objects in the response.",
    });
  }
  const typed = parts as Part[];
  const sentence = text(body["rendered_sentence"]);
  const status = text(body["status"]);
  return new Answer({
    kind,
    status: status ?? sharedStatus(typed),
    sentence:
      sentence ||
      typed
        .map((part) => partSentence(part))
        .filter(Boolean)
        .join(" "),
    parts: typed,
    question,
    warnings,
    timedOut: diagnostics["timed_out"] === true,
    raw: body,
    context,
  });
}

function sharedStatus(parts: readonly Part[]): string {
  const statuses = new Set(parts.map((part) => part.status));
  return statuses.size === 1 ? [...statuses][0]! : "mixed";
}

/** The sentence a part reads as: its spec's for a definite part, else its own. */
export function partSentence(part: Part): string | null {
  if (isKnownPart(part) && part.status === "definite") {
    return part.spec.resolved.rendered_sentence ?? null;
  }
  return text(part.rendered_sentence);
}

export function definiteParts(parts: readonly Part[]): DefinitePart[] {
  return parts.filter(
    (part): part is DefinitePart => isKnownPart(part) && part.status === "definite",
  );
}

/** One member per distinct `spec_id`, in query order; folded parts share their spec's member. */
function membersOf(parts: readonly Part[]): MemberRequest[] {
  const grouped = new Map<string, { spec: Spec; parts: string[]; answerParts: Part[] }>();
  for (const part of definiteParts(parts)) {
    const { spec } = part;
    const entry = grouped.get(spec.spec_id) ?? { spec, parts: [], answerParts: [] };
    entry.parts.push(part.variable_text ?? spec.resolved.rendered_sentence ?? spec.spec_id);
    entry.answerParts.push(part);
    grouped.set(spec.spec_id, entry);
  }
  return [...grouped.values()].map(({ spec, parts: names, answerParts }) => ({
    parts: names,
    spec,
    sentence: spec.resolved.rendered_sentence,
    entityGroups: spec.resolved.entity_groups,
    answerParts,
  }));
}

/** A gap whose candidates belong to no answer, for a dataset or an error, which hold no client. */
export function unboundGap(gap: Gap): Gap {
  if (!gap.options.some((option) => option.kind === "candidate")) return gap;
  return {
    ...gap,
    options: gap.options.map((option) => (option.kind === "candidate" ? option.unbound() : option)),
  };
}

/** The gap a part leaves, or null when it has a reading. `bind` gives a candidates part's
 *  readings their fetch through the answer. */
function gapFor(
  partIndex: number,
  part: Part,
  timedOut: boolean,
  bind: (part: CandidatesPart) => CandidateFetch,
): Gap | null {
  const gap = (kind: GapKind, message: string, options: Gap["options"] = []): Gap => ({
    partIndex,
    part,
    kind,
    message,
    options,
  });
  if (!isKnownPart(part)) {
    return gap(
      "unknown",
      `Search answered this part with status ${JSON.stringify(part.status)}, which this client ` +
        "does not know; upgrade @developmentfinance/client.",
    );
  }
  switch (part.status) {
    case "definite":
      return null;
    case "candidates": {
      const fetch = bind(part);
      const candidates = part.candidates.specs.map((spec) => candidateFrom(spec, fetch));
      return gap("choice", `${candidates.length} readings`, candidates);
    }
    case "no_data": {
      if (timedOut) return gap("timed_out", TIMED_OUT);
      const { reason } = part.no_data;
      const kind: GapKind = Object.hasOwn(CODE_GAP_KINDS, reason)
        ? CODE_GAP_KINDS[reason as keyof typeof CODE_GAP_KINDS]
        : "no_data";
      return gap(kind, part.no_data.message ?? reason, queryOptions(part.no_data));
    }
    case "unsupported":
      return gap("unsupported", part.unsupported.detail || part.unsupported.code);
  }
}

/** A refusal's choices, from `no_data.options`, read tolerantly: each option's `data_query` is
 *  the input that settles it. */
function queryOptions(noData: NoData): QueryOption[] {
  const options: unknown = noData.options;
  if (!Array.isArray(options)) return [];
  return options.filter(isRecord).map((option) => ({
    kind: "query",
    label: text(option["label"]) ?? "",
    mentions: Array.isArray(option["mentions"])
      ? option["mentions"].filter((m): m is string => typeof m === "string")
      : [],
    dataQuery: (isRecord(option["data_query"]) ? option["data_query"] : {}) as ParsedInput,
  }));
}

/** A candidate from its full spec: the label is the sentence's heading and the unit the
 *  byline's unit slot, so label, unit and source together say what the sentence says. */
function candidateFrom(spec: Spec, fetch: CandidateFetch): Candidate {
  const { resolved } = spec;
  const tokens = resolved.sentence_plan ?? [];
  const heading = tokens
    .filter((token) => (token.segment ?? "heading") === "heading")
    .map((token) => token.text)
    .join("")
    .trim();
  const unit = tokens.find(
    (token) =>
      token.segment === "byline" && token.kind === "slot" && token.axis === "unit" && token.text,
  )?.text;
  const sentence = resolved.rendered_sentence ?? null;
  return new Candidate(
    {
      spec,
      sentence,
      label: heading || (sentence ?? ""),
      source: resolved.facets?.["provenance"]?.label ?? null,
      unit: unit ?? null,
    },
    fetch,
  );
}
