/**
 * An answer is what Search understood a question to ask, part by part.
 *
 * An answer holds readings. `fetch` builds the dataset when the answer is complete, and raises
 * `IncompleteAnswerError` before any build when it has a gap. `choose` settles a part
 * that awaits a choice and returns a new answer. `toJSON` and `Answer.fromJSON` carry an answer
 * across a request, as between a web page and its server.
 */
import { answerJson, readAnswerJson } from "./answer-json.ts";
import type { AnswerJson } from "./answer-json.ts";
import { answerText, declinedText, incompleteMessage, readingHints } from "./answer-text.ts";
import { choiceInput, gapNamed, onlyChoice, pick } from "./choices.ts";
import type { ChoiceKey } from "./choices.ts";
import type { Client } from "../client.ts";
import { clientError, problemAt200 } from "../core/errors.ts";
import type { Dataset } from "../datasets/dataset.ts";
import {
  fetchMembers as defaultFetchMembers,
  narrowingOf,
  resolvedOf,
  RESOLVE_PATH,
  RESOLVE_SCHEMA_VERSION,
} from "../datasets/fetch.ts";
import type {
  CallOptions,
  FetchMembersOptions,
  MemberRequest,
  Narrowing,
} from "../datasets/fetch.ts";
import { CODE_GAP_KINDS } from "../generated/actions.ts";
import type { GAP_KINDS } from "../generated/actions.ts";
import { candidatesOf, queryOptions } from "../core/candidates.ts";
import { partFacts, warningsOf } from "../core/parse.ts";
import type { PartFacts } from "../core/parse.ts";
import { definiteParts, isKnownPart, partSentence, partText } from "../core/parts.ts";
import type { DefinitePart, KnownPart, Part } from "../core/parts.ts";
import { checkOptions, declareOptions } from "../core/options.ts";
import { withEntityDcids } from "./lookup-results.ts";
import { requestedCodes, setRequestedCodes } from "./requested-codes.ts";
import { askedCode, checkReply, codeGap } from "./structured.ts";
import { checkStrict } from "../core/strict.ts";
import { describing } from "../core/trace.ts";
import type { Transport } from "../http/transport.ts";
import { DfoWarning, emitWarning } from "../core/warnings.ts";
import type { WarningHandler } from "../core/warnings.ts";
import type {
  Assumption,
  DatasetResubmitInput,
  DeclinedReason,
  Diagnostics,
  ParsedInput,
  Notice,
  RawTextInput,
} from "../wire.ts";
import type { Spec } from "../core/ref.ts";
import { isRecord, list, text } from "../core/json.ts";

/** Longer than Search's 45-second soft deadline, so a slow answer arrives whole. */
const SEARCH_TIMEOUT_MS = 60_000;

/** What a gap needs to settle it: the contract's gap kinds, or one the client derives. */
export type GapKind = (typeof GAP_KINDS)[number] | "unknown";

/** What Search answered with: readings, the catalogue, or a refusal of the question. */
export type AnswerKind = "resolution" | "catalogue" | "declined";

/** An answer's status: the parts' shared status, `mixed` when they differ, or the kind of a
 *  declined or catalogue answer. A status a newer server sends still typechecks. */
export type AnswerStatus = KnownPart["status"] | "mixed" | "catalogue" | "declined" | (string & {});

/** Search's account of how it answered, from the response's `diagnostics`: its build, timing,
 *  model token counts and whether it stopped at its time limit. The members are as the server
 *  sent them and are not checked. */
export type AnswerDiagnostics = Readonly<Partial<Diagnostics>>;

/**
 * One reading of a part that has several. The label, unit and source split its sentence, and
 * `assumptions` lists what Search assumed for it, which a choice posts back. Choose it with
 * `answer.choose(index)`, which returns Search's answer for the reading. A candidate in
 * `Dataset.missing` or in `IncompleteAnswerError.gaps` belongs to no answer; fetch its spec with
 * `client.fetch(candidate.spec)`.
 */
export type Candidate = {
  readonly kind: "candidate";
  readonly spec: Spec;
  /** Search's sentence for the reading. */
  readonly sentence: string | null;
  /** The sentence's heading, else the sentence, or null when the spec has neither. */
  readonly label: string | null;
  /** The provenance the reading reads from, such as "OECD DAC1". */
  readonly source: string | null;
  /** The byline's unit, such as "Current US dollars". */
  readonly unit: string | null;
  /** What Search assumed for this reading, from its part's `reading_assumptions`; empty when
   *  the part lists none. */
  readonly assumptions: readonly Assumption[];
};

/** One way to settle a part that awaits a choice of place or source. */
export type Option = {
  readonly kind: "query";
  /** The choice as the user reads it, such as "Congo [DRC]". */
  readonly label: string;
  /** The question's words the choice settles. */
  readonly mentions: readonly string[];
  /** The parsed question with the choice pinned, which `answer.choose` posts back to Search. It
   *  goes as it stands in a one-part answer, and as its one part beside the other parts' entries
   *  otherwise. Null when the server sent none or sent one that is not a parsed input, and a choice of the
   *  option then refuses as a `ContractError`. */
  readonly dataQuery: ParsedInput | null;
  /** For a choice of place, the index of the ambiguous wording this option settles, shared by that
   *  wording's options and its sentence slot. Two wordings can share one text, as "Congo" does in
   *  "aid from Congo to Congo", so a menu groups options by this index. Null for any other option. */
  readonly entityChoice: number | null;
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
  readonly options: readonly (Candidate | Option)[];
};

/** What an answer's requests go through. The client builds it. */
export type AnswerContext = {
  readonly transport: Transport;
  readonly onWarning?: WarningHandler;
  /** Builds the answer's members; `fetchMembers` from the fetch module unless a test swaps it. */
  readonly fetchMembers?: (
    transport: Transport,
    members: readonly MemberRequest[],
    options: FetchMembersOptions,
  ) => Promise<Dataset>;
};

export type SearchOptions = {
  readonly signal?: AbortSignal;
  /** The longest the whole call takes, retries included, in milliseconds; each attempt reads
   *  until then. `Infinity` waits as long as Search takes. The client's `timeout` by default,
   *  else 60 seconds. */
  readonly timeout?: number;
};

/** A choice's options: the part it settles, and the Search request's signal and timeout. */
export type ChooseOptions = SearchOptions & {
  /** The part, by its index, its variable text, or a word of the question its options settle.
   *  Needed only when several parts await a choice. */
  readonly part?: ChoiceKey;
};

/** A fetch's options, less the gaps the answer supplies. `window`, `entities` and `facets`
 *  narrow every reading as `client.fetch` narrows one spec. `strict` also throws the
 *  `SearchWarning` instead of issuing it. */
export type AnswerFetchOptions = CallOptions &
  Narrowing & {
    /** Build the parts that have a reading when others do not; the dataset lists the gaps. */
    readonly partial?: boolean;
  };

/** The keys `client.search` takes. */
export const SEARCH_OPTIONS = declareOptions<SearchOptions>("client.search", {
  signal: true,
  timeout: true,
});

/** The keys `answer.choose` takes. */
const CHOOSE_OPTIONS = declareOptions<ChooseOptions>("answer.choose", {
  signal: true,
  timeout: true,
  part: true,
});

/** The keys `answer.fetch` takes. */
const ANSWER_FETCH_OPTIONS = declareOptions<AnswerFetchOptions>("answer.fetch", {
  signal: true,
  timeout: true,
  onProgress: true,
  strict: true,
  layout: true,
  partyTotals: true,
  window: true,
  entities: true,
  facets: true,
  partial: true,
});

/** How the readings an answer builds differ from the question: departures, computations Search
 *  did not run, and its `warn` and `degraded` warnings. */
export class SearchWarning extends DfoWarning {}
Object.defineProperty(SearchWarning.prototype, "name", {
  value: "SearchWarning",
  configurable: true,
});

type AnswerInit = {
  kind: AnswerKind;
  status: AnswerStatus;
  sentence: string | null;
  parts?: readonly Part[];
  question: string | null;
  reason?: string | null;
  warnings?: readonly Notice[];
  timedOut?: boolean;
  diagnostics?: AnswerDiagnostics;
  traceId?: string | null;
  raw: Readonly<Record<string, unknown>>;
  context: AnswerContext;
  /** The series code each part was asked by, for a search by codes. */
  codes?: readonly string[] | undefined;
};

/** The context each client's answers use, for `Answer.fromJSON`. */
const CONTEXTS = new WeakMap<Client, AnswerContext>();

/** Gives `Answer.fromJSON` the context a client's answers use. The client calls it. */
export function registerClient(client: Client, context: AnswerContext): void {
  CONTEXTS.set(client, context);
}

/** What Search understood a question to ask, as one reading per part. */
export class Answer {
  readonly kind: AnswerKind;
  /** The parts' shared status, `mixed` when they differ, or the kind of a declined or catalogue
   *  answer. It is Search's status, so a definite answer can still have a gap from a series
   *  code. `complete` says whether it has none. */
  readonly status: AnswerStatus;
  /** Search's sentence for the whole answer; null for a declined or catalogue answer. */
  readonly sentence: string | null;
  /** One part per variable asked, in query order. A part types the members the client checks,
   *  its `status` and the reading or refusal it names, and every other member as `unknown`; read
   *  its assumptions, departures, operations and warnings from `facts`. */
  readonly parts: readonly Part[];
  /** The readings, one per distinct `spec_id`, in query order. */
  readonly specs: readonly Spec[];
  /** Whether every part has a reading `fetch` builds: each part is definite, and a part asked by
   *  a series code reads that code's series alone. */
  readonly complete: boolean;
  /** The parts that stop a complete dataset, in query order. A definite part asked by a series
   *  code whose reading is not that code's series alone is one, of kind `no_data`. */
  readonly gaps: readonly Gap[];
  /** The question asked, when the answer came from one. */
  readonly question: string | null;
  /** Why Search declined, for a declined answer. A reason a newer server sends still
   *  typechecks. */
  readonly reason: DeclinedReason | (string & {}) | null;
  /** Search's warnings for the whole answer. */
  readonly warnings: readonly Notice[];
  /** Whether Search stopped at its time limit: its diagnostics say so, or a part's own no-data
   *  reason is `timed_out`. */
  readonly timedOut: boolean;
  /** Search's timing, token counts and build for the response; empty when it sent none. An
   *  answer read by `Answer.fromJSON` holds only `timed_out` and `warnings`. */
  readonly diagnostics: AnswerDiagnostics;
  /** The Search response's trace id, to quote when reporting it. */
  readonly traceId: string | null;
  /** The decoded response body, untouched; for an answer read by `Answer.fromJSON`, the cut
   *  body it held. */
  readonly raw: Readonly<Record<string, unknown>>;
  readonly #context: AnswerContext;
  #facts: readonly PartFacts[] | undefined;
  /** The members `fetch` builds, one per distinct spec. */
  readonly #members: readonly MemberRequest[];

  /** @internal Answers come from `client.search`. This constructor is the client's. */
  constructor(init: AnswerInit) {
    this.kind = init.kind;
    this.status = init.status;
    this.sentence = init.sentence;
    this.parts = init.parts ?? [];
    this.question = init.question;
    this.reason = init.reason ?? null;
    this.warnings = init.warnings ?? [];
    this.timedOut = init.timedOut ?? false;
    this.diagnostics = init.diagnostics ?? {};
    this.traceId = init.traceId ?? null;
    this.raw = init.raw;
    this.#context = init.context;
    const codes = init.codes ?? null;
    // The gaps check each reading against these, and `toJSON` and `choose` carry them on.
    if (codes !== null) setRequestedCodes(this, codes);
    this.gaps = this.parts.flatMap((part, index) => {
      const gap =
        gapFor(index, part) ?? codeGap(index, part, codes ? codes[index]! : askedCode(part));
      return gap === null ? [] : [gap];
    });
    this.complete = this.kind === "resolution" && this.gaps.length === 0;
    const gapped = new Set(this.gaps.map((gap) => gap.partIndex));
    const answered = new Set(this.parts.flatMap((_, index) => (gapped.has(index) ? [] : [index])));
    const members = membersOf(this.parts, answered);
    this.#members = members;
    this.specs = members.map((member) => member.spec);
  }

  /**
   * What each part states beside its reading, one entry per part in the order of `parts`: its
   * `assumptions`, `departures`, requested `operations` and `warnings`, and a candidates part's
   * `readingAssumptions` by `spec_id`. A part whose member has the wrong type reads as absent
   * (`[]`, or undefined for `assumptions` when the part holds no list), and an item that lacks a
   * required member is dropped, as in the Python client's `Part` attributes.
   */
  get facts(): readonly PartFacts[] {
    this.#facts ??= Object.freeze(this.parts.map(partFacts));
    return this.#facts;
  }

  /**
   * Settles a part that awaits a choice and returns Search's answer to it, in one Search request.
   * Picking a reading needs no model call. A place choice, and any part restated beside it, asks
   * Search to bind it again. The option is named by its index or its label. `part` names the
   * part by its index, its variable text, or a word of the question its options settle, and is
   * needed only when several parts await a choice: `answer.choose(0, { part: "GDP" })`. The
   * chosen answer's sentence and assumptions are Search's. A choice in an answer to a search by
   * codes keeps the codes, part for part, so the new answer checks each reading against the code
   * asked for.
   *
   * @throws {InvalidRequestError} No part, or more than one, awaits a choice and `part` is not
   *   given; the part or option is unknown; the part offers no options; or a part cannot be
   *   posted back (`choice_invalid`); or `options` is not an object or holds a key outside
   *   `ChooseOptions` (`invalid_argument`). A part or label that names nothing is refused with the nearest
   *   match and the valid choices.
   * @throws {ContractError} The chosen option carries no one-part `data_query`, and the error
   *   carries the answer's trace id; or, in an answer to a search by codes, Search answers with
   *   another number of parts than codes (`contract_violation`).
   */
  async choose(option: ChoiceKey, options: ChooseOptions = {}): Promise<Answer> {
    const { part, ...request } = checkOptions(CHOOSE_OPTIONS, options);
    const codes = requestedCodes(this);
    const input = describing(this.traceId, () => {
      const gap = part === undefined ? onlyChoice(this) : gapNamed(this, part);
      return choiceInput(this, gap, pick(gap, option, part));
    });
    return resolveAnswer(this.#context, input, {
      ...request,
      question: this.question,
      ...(codes === null ? {} : { codes }),
    });
  }

  /**
   * Builds the dataset for the answer's readings. Each distinct spec builds once; readings
   * that narrow to one spec share a member, and several members stack into one long table with a
   * `part` column. `window`, `entities` and `facets` narrow every reading as `client.fetch`
   * narrows one spec.
   *
   * @throws {InvalidRequestError} `options` holds a key outside `AnswerFetchOptions`, or a
   *   narrowing breaks its rule, names a role a reading does not take, which names each
   *   reading's roles, or holds a `Match` that did not resolve, before any request
   *   (`invalid_argument`).
   * @throws {DeclinedError} Search declined the question or answered with the catalogue.
   * @throws {IncompleteAnswerError} A part has no reading and `partial` is false, or no part has
   *   one.
   * @throws {SearchWarning} `strict` is true and the reading differs from the question.
   * @throws {DataWarning} `strict` is true and a manifest carries a warning above `info`.
   */
  async fetch(options: AnswerFetchOptions = {}): Promise<Dataset> {
    const { partial, window, entities, facets, ...fetchOptions } = withEntityDcids(
      checkOptions(ANSWER_FETCH_OPTIONS, options),
    );
    if (this.kind !== "resolution") {
      throw clientError("answer_declined", {
        detail: declinedText(this.kind, this.reason),
        traceId: this.traceId,
      });
    }
    const members = this.#members;
    if (this.gaps.length > 0 && (partial !== true || members.length === 0)) {
      throw clientError("answer_incomplete", {
        detail: incompleteMessage(this),
        traceId: this.traceId,
        answer: this,
        gaps: this.gaps,
      });
    }
    const hints = readingHints(this, { departures: true });
    if (hints.length > 0) {
      const warning = new SearchWarning(
        hints.length === 1 ? hints[0]!.code : null,
        `Search's reading differs from your question:\n  ${hints.map((h) => h.line).join("\n  ")}`,
        this.traceId,
      );
      if (fetchOptions.strict === true) throw warning;
      (this.#context.onWarning ?? emitWarning)(warning);
    }
    const build = this.#context.fetchMembers ?? defaultFetchMembers;
    return build(this.#context.transport, members, {
      ...fetchOptions,
      narrowing: narrowingOf({ window, entities, facets }),
      missing: this.gaps,
      question: this.question,
    });
  }

  /** The answer as a reader sees it: the sentence and the call that fetches it, or what is
   *  missing and the calls that settle it. */
  toString(): string {
    return answerText(this);
  }

  /** Node's `console.log` and `util.inspect` show the answer as `String(answer)` does. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }

  /**
   * The answer in the answer format, `{format_version: 1, question, answer}`, which every DFO
   * client reads. `answer` is the Search response cut to the members a client reads, with the
   * answer's trace id. An answer to a search by codes also holds `codes`, one per part, so the
   * answer read back checks each reading against the code asked for, as the live answer does.
   * `JSON.stringify(answer)` and `Response.json({ answer })` write it.
   */
  toJSON(): AnswerJson {
    return answerJson(this.question, this.raw, this.traceId, requestedCodes(this));
  }

  /**
   * Reads an answer that `toJSON` wrote, in this or another DFO client, from its JSON text or
   * the parsed value. Its `choose` and `fetch` go through `client`, and post the request the
   * original answer would. The body is checked as a fresh Search response is, with the same
   * parser and strict checks.
   *
   * The check proves the body is well formed, not that it came from Search. `choose` and `fetch`
   * post what the answer holds: each part's spec and identity, and a place option's
   * `data_query`. So a forged body can send any spec definition or parsed input to Search and
   * the build route, under the client's key. With a public-tier key that costs quota, which a
   * question route already exposes, so rate-limit both routes per visitor. With a key scoped
   * beyond the public tier, keep the answer on the server, stored under a random id that the
   * page sends back, or sign it before it leaves.
   *
   * @throws {FormatError} The value is not JSON in the answer format, or its `codes` is not one
   *   non-blank string per part (`format_invalid`).
   * @throws {InvalidRequestError} `client` is not a `Client` (`invalid_argument`).
   * @throws {DfoError} The body is a problem document, as a Search response would raise it.
   * @throws {ContractError} The body lacks a member the client acts on, as a Search response
   *   would raise it.
   */
  static fromJSON(value: unknown, client: Client): Answer {
    const context = CONTEXTS.get(client);
    if (context === undefined) {
      throw clientError("invalid_argument", {
        detail:
          "Answer.fromJSON needs the client its requests go through: Answer.fromJSON(value, client).",
      });
    }
    const { question, body, traceId, codes } = readAnswerJson(value);
    return describing(traceId, () =>
      answerFromBody(body, context, question, traceId, codes ?? undefined),
    );
  }
}

/** Posts one Search input and reads the answer. */
export async function resolveAnswer(
  context: AnswerContext,
  input: RawTextInput | ParsedInput | DatasetResubmitInput,
  options: SearchOptions & { question: string | null; codes?: readonly string[] },
): Promise<Answer> {
  const { transport } = context;
  const response = await transport.request({
    path: RESOLVE_PATH,
    json: { schema_version: RESOLVE_SCHEMA_VERSION, input },
    attemptTimeout: Infinity,
    deadline: transport.callDeadline(options.timeout, SEARCH_TIMEOUT_MS),
    signal: options.signal,
  });
  const { body, traceId } = response;
  return describing(traceId, () =>
    answerFromBody(body, context, options.question, traceId, options.codes),
  );
}

/**
 * Reads a decoded Search response into an answer. `traceId` is the trace id of the response
 * the body came from. `codes` are the series codes a search by codes asked, one per part in
 * order, and the code a part asked is the authority whatever its restatement names. Without
 * them, as for a question in words, a part's code is the `source_code` of its restatement. A
 * definite part
 * asked by a code whose reading is not that code's series alone is a gap of kind `no_data`, so
 * `fetch` builds it only beside `partial: true`, and then leaves it out. A code part whose spec
 * has no `resolved.stat_vars`, as in an answer `@developmentfinance/client` 0.2.0 wrote, is such
 * a gap too.
 *
 * @throws {DfoError} The body is a problem document (a `code` and no `kind`): the class the
 *   contract's actions give its code, or `ContractError` (`contract_violation`) for a code they
 *   lack.
 * @throws {ContractError} The body is not an object, its kind is unknown, a member the client
 *   acts on is missing, `parts` is not an array of objects, a part has no string `status`, a
 *   candidates part's `specs` is not an array, or a spec's `definition.spec_id` is not its
 *   `spec_id`. Any other member of the wrong type reads as absent.
 */
export function answerFromBody(
  body: unknown,
  context: AnswerContext,
  question: string | null,
  traceId: string | null = null,
  codes?: readonly string[],
): Answer {
  if (!isRecord(body)) {
    throw clientError("contract_violation", {
      detail: "The Search response is not an object.",
    });
  }
  const refused = problemAt200(body, traceId);
  if (refused !== undefined) throw refused;
  // A JSON object from the server, which the type describes and the client does not check.
  const diagnostics: AnswerDiagnostics = isRecord(body["diagnostics"]) ? body["diagnostics"] : {};
  const warnings = warningsOf(diagnostics["warnings"]);
  const kind = body["kind"];
  if (kind === "declined" || kind === "catalogue") {
    return new Answer({
      kind,
      status: kind,
      sentence: null,
      question,
      reason: kind === "declined" ? text(body["reason"]) : null,
      warnings,
      diagnostics,
      traceId,
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
  const parts = list(body["parts"]);
  if (parts.length === 0) {
    throw clientError("contract_violation", {
      detail: "The Search resolution has no parts, which this client acts on.",
      pointer: "/parts",
    });
  }
  const typed = parts.map(readPart);
  if (codes !== undefined) checkReply(typed, warnings, codes);
  const sentence = text(body["rendered_sentence"]);
  const status = text(body["status"]);
  return new Answer({
    kind,
    status: status ?? sharedStatus(typed),
    sentence: sentence || typed.map(partSentence).filter(Boolean).join(" "),
    parts: typed,
    question,
    warnings,
    // Search can stop at its time limit on one part without setting the flag.
    timedOut: diagnostics["timed_out"] === true || typed.some(partTimedOut),
    diagnostics,
    traceId,
    raw: body,
    context,
    codes,
  });
}

/** Whether a part's own no-data reason says Search stopped at its time limit. */
function partTimedOut(part: Part): boolean {
  return isKnownPart(part) && part.status === "no_data" && part.no_data.reason === "timed_out";
}

/** A part, once it passes the checks the client makes beyond the strict fields: that it is an
 *  object, that it has a `status`, which the strict check lets through when absent, and that each
 *  spec's definition names it. */
function readPart(part: unknown, index: number): Part {
  const pointer = `/parts/${index}`;
  if (!isRecord(part)) {
    throw clientError("contract_violation", {
      detail: `Part ${index} of the Search response is not an object.`,
      pointer,
    });
  }
  const { status } = part;
  if (typeof status !== "string") {
    throw clientError("contract_violation", {
      detail: `Part ${index} of the Search response has no status, which this client acts on.`,
      pointer: `${pointer}/status`,
    });
  }
  if (status === "definite") checkSpec(part["spec"], `${pointer}/spec`);
  if (status === "candidates") {
    const candidates = part["candidates"];
    const specs = list(isRecord(candidates) ? candidates["specs"] : undefined);
    for (const [at, spec] of specs.entries()) {
      checkSpec(spec, `${pointer}/candidates/specs/${at}`);
    }
  }
  return { ...part, status };
}

/** Raises when a Search spec's definition names another spec than its `spec_id`. */
function checkSpec(spec: unknown, pointer: string): void {
  if (!isRecord(spec) || !isRecord(spec["definition"])) return;
  const named = spec["definition"]["spec_id"];
  if (named !== spec["spec_id"]) {
    throw clientError("contract_violation", {
      detail:
        `The spec ${String(spec["spec_id"])} at ${pointer} has a definition for ` +
        `${String(named)}.`,
      pointer: `${pointer}/definition/spec_id`,
    });
  }
}

function sharedStatus(parts: readonly Part[]): string {
  const statuses = new Set(parts.map((part) => part.status));
  return statuses.size === 1 ? [...statuses][0]! : "mixed";
}

/** One member per distinct `spec_id` of the answered parts, in query order, with the first
 *  part's spec; folded parts share their spec's member, which names each of them that has
 *  variable text. A part without any names nothing. */
function membersOf(
  parts: readonly Part[],
  answered: ReadonlySet<number>,
): (MemberRequest & { readonly spec: DefinitePart["spec"] })[] {
  const grouped = new Map<
    string,
    { spec: DefinitePart["spec"]; parts: string[]; answerParts: Part[] }
  >();
  for (const part of definiteParts(parts.filter((_, index) => answered.has(index)))) {
    const { spec } = part;
    const entry = grouped.get(spec.spec_id) ?? { spec, parts: [], answerParts: [] };
    const name = partText(part);
    if (name) entry.parts.push(name);
    entry.answerParts.push(part);
    grouped.set(spec.spec_id, entry);
  }
  return [...grouped.values()].map(({ spec, parts: names, answerParts }) => {
    return { parts: names, spec, ...resolvedOf(spec), answerParts };
  });
}

/** The gap a part leaves, or null when it has a reading. */
function gapFor(partIndex: number, part: Part): Gap | null {
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
      const candidates = candidatesOf(part);
      return gap("choice", `${candidates.length} readings`, candidates);
    }
    case "no_data": {
      const { reason } = part.no_data;
      const kind: GapKind = Object.hasOwn(CODE_GAP_KINDS, reason)
        ? CODE_GAP_KINDS[reason as keyof typeof CODE_GAP_KINDS]
        : "no_data";
      return gap(kind, text(part.no_data.message) || reason, queryOptions(part.no_data));
    }
    case "unsupported":
      return gap("unsupported", text(part.unsupported.detail) || part.unsupported.code);
  }
}
