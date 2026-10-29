/**
 * Recipes: a chain of DFO's operations, described without running it.
 *
 * `recipe(start)` starts from a spec, a `DatasetRef` or a `Dataset`, and each step method
 * returns a new `Recipe` one step longer, so a recipe is a value that does no I/O and needs no
 * client. `client.fetch(recipe)` sends the whole tree to `POST /datasets/analysis` in one
 * request. Every argument is checked when the step is added, so a malformed chain is refused
 * before any dataset exists.
 *
 * A recipe sends a tree of nodes. A step is `{verb, arguments, inputs: {data, other?}}`, whose
 * arguments carry the engine's names: `filter`'s `keep` becomes `predicates` of
 * `category_match`, `by` becomes `group_by`, `entity_by`, `rank_by` or `numerator_by`, `how`
 * becomes `aggregation`, a `window` becomes `window_start` and `window_end`, and `on` passes
 * through, a single role as a list of one. A root is the start or a second reading:
 *
 * - a spec, `{spec_id, rendering: {without_party_totals: true}}`, read at its newest version
 *   without party totals, as `client.fetch(spec)` reads it;
 * - a dataset or ref of one dataset member, `{spec_id, content_version, rendering}`, read at
 *   that version in the member's party-totals cut;
 * - a dataset or ref of one derived member, `{spec_id, content_version}`, which DFO expands
 *   into the recipe that made it;
 * - a dataset or ref of several members, sent as `{ref}`, which DFO refuses with
 *   `several_members`, since an operation takes one reading per side.
 */

import { Dataset } from "./dataset.ts";
import { clientError } from "../core/errors.ts";
import type { InvalidRequestError } from "../core/errors.ts";
import { isRecord } from "../core/json.ts";
import { checkOptions, declareOptions } from "../core/options.ts";
import { LatestYear, periodObject } from "../core/periods.ts";
import { DatasetRef, isDatasetMember } from "../core/ref.ts";
import type { Spec } from "../core/ref.ts";
import { inline, quoted } from "../core/text.ts";

/** A year: a calendar year such as 2020, or `latestYear(offset)`. */
export type Year = number | LatestYear;

/** One role or column, such as `"origin"`, or several. */
export type Columns = string | readonly string[];

/** How two readings' members pair: an object mapping a role of the first reading to the role of
 *  the other that holds the same entities, such as `{ destination: "place" }`, or a role or
 *  roles both readings name alike. */
export type Pairing = Readonly<Record<string, string>> | readonly string[] | string;

/** How an operation reduces several rows to one. */
export type Aggregation = "sum" | "mean" | "max" | "min";

/** How `growth` works out a change: `relative`, the change divided by the first year's value, a
 *  fraction where 0.25 is a 25% rise; or `difference`, the last year's value minus the first's,
 *  in the data's unit. */
export type GrowthChange = "relative" | "difference";

/** What a recipe starts from, and what a two-reading step takes as its other reading. */
export type Start = Spec | DatasetRef | Dataset | Recipe;

export type FilterOptions = {
  /** Each role or column, with the value or values its rows keep, as
   *  `{ destination: ["country/KEN"] }`. */
  keep: Readonly<Record<string, string | readonly string[]>>;
};

export type AggregateOptions = {
  /** The roles whose members stay apart; none totals every row of each year. */
  by?: Columns;
  /** `sum` by default. */
  how?: Aggregation;
};

export type GrowthOptions = {
  /** The roles whose members each get their own change; none by default. */
  by?: Columns;
  /** The first and last years, such as `[latestYear(-4), latestYear()]`. */
  window: readonly [start: Year, end: Year];
  /** `relative` by default, the change divided by the first year's value, a fraction where 0.25
   *  is a 25% rise; `difference` is the last year's value minus the first's, in the data's
   *  unit. */
  change?: GrowthChange;
};

export type RankOptions = {
  /** The roles whose members are ranked. */
  by: Columns;
  /** The years ranked over; none ranks every year the data holds. */
  window?: readonly [start: Year, end: Year] | null;
  /** How each member's rows in the window reduce to one value first; none ranks each member's
   *  one value. */
  how?: Aggregation | null;
  /** The most members kept, from 1 to 1000; a tie at the last place keeps every member that
   *  shares it. None keeps them all. */
  limit?: number | null;
};

export type PairOptions = {
  /** How the two readings' members pair, such as `{ destination: "place" }`; DFO pairs the
   *  roles both name alike when none is given. */
  on?: Pairing | null;
};

export type ShareOfOptions = PairOptions & {
  /** The roles whose members share the total. With no total reading, the total is the sum over
   *  their members in the same year. */
  by?: Columns | null;
};

const FILTER = declareOptions<FilterOptions>("filter", { keep: true });
const AGGREGATE = declareOptions<AggregateOptions>("aggregate", { by: true, how: true });
/** Growth's `change` words, in the engine's names. */
const GROWTH_CHANGES: Readonly<Record<GrowthChange, string>> = {
  relative: "relative",
  difference: "absolute",
};

const TIME_PERIOD = "time_period";
/** The parameters whose lists name the columns of a step's `by`. */
const ORDERED_BY = ["group_by", "entity_by", "rank_by"] as const;
/** The stored parameter that holds each two-reading step's `on`, its keys the columns of `data`
 *  and its values those of `other`. */
const STORED_PAIRS: Readonly<Record<string, string>> = {
  compare: "on",
  sum_of: "on",
  quotient_of: "denominator_by",
  share_of: "denominator_by",
  join: "right_keys",
};

const GROWTH = declareOptions<GrowthOptions>("growth", { by: true, window: true, change: true });
const RANK = declareOptions<RankOptions>("rank", {
  by: true,
  window: true,
  how: true,
  limit: true,
});
const PAIR = declareOptions<PairOptions>("a two-reading step", { on: true });
const SHARE_OF = declareOptions<ShareOfOptions>("shareOf", { by: true, on: true });

/** The most members a ranking keeps, as DFO's rank accepts it. */
const MAX_LIMIT = 1000;

/** The most characters of a refused value a refusal quotes. */
const SHOWN_MAX = 60;

/** A reading a recipe starts from, as the request names it. */
type RootNode = {
  readonly kind: "root";
  readonly node: Readonly<Record<string, unknown>>;
  readonly name: string;
};

/** One operation over its inputs, with its arguments in the engine's names. */
type StepNode = {
  readonly kind: "step";
  readonly verb: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly data: TreeNode;
  readonly other: TreeNode | undefined;
  /** The call's own options as the text form prints them, `{ by: "origin", limit: 10 }`, after
   *  the other reading; empty when it was given none. */
  readonly call: string;
};

type TreeNode = RootNode | StepNode;

/** Makes a recipe and reads its tree; Recipe's static block assigns them. */
let makeRecipe: (tree: TreeNode) => Recipe;
let treeOf: (recipe: Recipe) => TreeNode;

/**
 * A chain of DFO's operations, described without running it. `client.fetch(recipe)` runs the
 * whole chain in one request. Each step method takes the options of the `client.analysis`
 * call of its name, without the first reading, and returns a new recipe one step longer. A
 * two-reading step takes the other reading as a spec, `DatasetRef`, `Dataset` or `Recipe`.
 * `String(recipe)` prints the chain as it was called, and `equals` compares the trees two
 * recipes send.
 */
export class Recipe {
  readonly #tree: TreeNode;

  static {
    makeRecipe = (tree) => new Recipe(tree);
    treeOf = (recipe) => recipe.#tree;
  }

  private constructor(tree: TreeNode) {
    this.#tree = tree;
    Object.freeze(this);
  }

  /** The chain as it was called, each reading by its spec id, as
   *  `recipe(spec_…).rank({ by: "origin", limit: 10 })`. */
  toString(): string {
    return inline(callText(this.#tree));
  }

  /** Whether `other` is a recipe that sends the same tree, so `{ by: "origin" }` and
   *  `{ by: ["origin"] }` make equal recipes. */
  equals(other: unknown): boolean {
    return other instanceof Recipe && canonical(wire(this.#tree)) === canonical(wire(other.#tree));
  }

  /** Node's `console.log` and `util.inspect` show the recipe as `String(recipe)` does. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }

  /**
   * The tree `POST /datasets/analysis` takes, as a new object on each call.
   *
   * @throws {InvalidRequestError} The recipe has no step and starts from a dataset version or a
   *   spec, which a fetch reads itself (`invalid_argument`).
   */
  tree(): Record<string, unknown> {
    const tree = this.#tree;
    if (tree.kind === "root" && !String(tree.node["spec_id"]).startsWith("ops_")) {
      throw invalid(
        `A recipe with no step reads ${tree.name} as it is; fetch it directly, or add a step ` +
          "such as .rank({ by: ... }).",
      );
    }
    return wire(tree);
  }

  /**
   * Keeps the rows whose role or column holds one of the values, as
   * `{ keep: { destination: ["country/KEN"] } }`.
   *
   * @throws {InvalidRequestError} `keep` is not a non-empty object of names to a value or a
   *   list of values (`invalid_argument`).
   */
  filter(options: FilterOptions): Recipe {
    const { keep } = checkOptions(FILTER, options);
    if (!isRecord(keep) || Object.keys(keep).length === 0) {
      throw refusal("keep", "maps a role to its values", keep);
    }
    const predicates = Object.entries(keep).map(([column, values]) => ({
      kind: "category_match",
      column: name("keep", column),
      values: texts("keep", values),
    }));
    return this.#step("filter", { predicates }, optionsText({ keep }));
  }

  /** Totals or averages the rows of each year, keeping the members of `by` apart. */
  aggregate(options: AggregateOptions = {}): Recipe {
    const { by = [], how = "sum" } = checkOptions(AGGREGATE, options);
    const members = columns("by", by, true);
    // The engine groups by exactly these columns and collapses every year into one span
    // without time_period, so the period always leads.
    const groupBy = [TIME_PERIOD, ...members.filter((column) => column !== TIME_PERIOD)];
    return this.#step(
      "aggregate",
      { group_by: groupBy, aggregation: word("how", how) },
      optionsText({
        by: members.length > 0 ? by : undefined,
        how: how === "sum" ? undefined : how,
      }),
    );
  }

  /**
   * The change of each member of `by` from the first to the last year of `window`.
   *
   * @throws {InvalidRequestError} `change` is neither `relative` nor `difference`
   *   (`invalid_argument`).
   */
  growth(options: GrowthOptions): Recipe {
    const { by = [], window, change = "relative" } = checkOptions(GROWTH, options);
    const entityBy = columns("by", by, true);
    if (!Object.hasOwn(GROWTH_CHANGES, change)) {
      throw refusal("change", 'is "relative" or "difference"', change);
    }
    return this.#step(
      "growth",
      { ...windowOf(window), entity_by: entityBy, change: GROWTH_CHANGES[change] },
      optionsText({
        by: entityBy.length > 0 ? by : undefined,
        window,
        change: change === "relative" ? undefined : change,
      }),
    );
  }

  /**
   * Orders the members of `by`, largest first, and keeps the top `limit`.
   *
   * @throws {InvalidRequestError} `by` names no role, or `limit` is not an integer from 1 to
   *   1000 (`invalid_argument`).
   */
  rank(options: RankOptions): Recipe {
    const { by, window, how, limit } = checkOptions(RANK, options);
    const rankBy = columns("by", by, false);
    const args: Record<string, unknown> = { rank_by: rankBy };
    if (window != null) Object.assign(args, windowOf(window));
    if (how != null) args["aggregation"] = word("how", how);
    if (limit != null) {
      if (!Number.isInteger(limit)) throw refusal("limit", "is a whole number of members", limit);
      if (limit < 1 || limit > MAX_LIMIT) {
        throw refusal("limit", `is from 1 to ${MAX_LIMIT}`, limit);
      }
      args["limit"] = limit;
    }
    return this.#step("rank", args, optionsText({ by, window, how, limit }));
  }

  /** Divides by another reading, pairing members through `on`, such as aid per person with
   *  `{ on: { destination: "place" } }`. */
  quotientOf(other: Start, options: PairOptions = {}): Recipe {
    return this.#pair("quotient_of", other, checkOptions(PAIR, options).on, null);
  }

  /**
   * Each value as a percentage of the matching row of `total`, from 0 to 100 when each value is
   * part of its total, so 25 is a quarter; or, with no `total`, of the total across all members
   * of `by` in the same year, as `.shareOf({ by: "origin" })`. The rows' `unit` names the
   * percentage.
   *
   * @throws {InvalidRequestError} Neither `total` nor `by` is given, or `on` is given with no
   *   total (`invalid_argument`).
   */
  shareOf(options: ShareOfOptions): Recipe;
  shareOf(total: Start, options?: ShareOfOptions): Recipe;
  shareOf(first?: Start | ShareOfOptions, second?: ShareOfOptions): Recipe {
    if (isStart(first)) {
      const { by, on } = checkOptions(SHARE_OF, second);
      return this.#pair("share_of", first, on, by ?? null);
    }
    if (second !== undefined) {
      throw invalid("shareOf takes the total reading first, then its options.");
    }
    const { by, on } = checkOptions(SHARE_OF, first);
    if (by == null) {
      throw invalid(
        "shareOf takes a total reading, or by naming the role whose members share the total, " +
          'such as .shareOf({ by: "origin" }).',
      );
    }
    if (on != null) {
      throw invalid(
        "shareOf takes on with a total reading; with by alone the total is the sum over by's " +
          "members.",
      );
    }
    const numeratorBy = columns("by", by, false);
    return this.#step("share_of", { numerator_by: numeratorBy }, optionsText({ by }));
  }

  /** Matches another reading's rows on their keys and keeps both sides' rows in long format,
   *  told apart by `stat_var`. */
  join(other: Start, options: PairOptions = {}): Recipe {
    return this.#pair("join", other, checkOptions(PAIR, options).on, null);
  }

  /** Adds the matching rows of another reading over the years both hold. */
  sumOf(other: Start, options: PairOptions = {}): Recipe {
    return this.#pair("sum_of", other, checkOptions(PAIR, options).on, null);
  }

  /** This reading minus another, for each matching member over the years both hold. DFO
   *  refuses two different units. */
  compare(other: Start, options: PairOptions = {}): Recipe {
    return this.#pair("compare", other, checkOptions(PAIR, options).on, null);
  }

  #pair(verb: string, other: Start, on: unknown, by: Columns | null): Recipe {
    const args: Record<string, unknown> = {};
    const numeratorBy = by === null ? [] : columns("by", by, false);
    if (by !== null) args["numerator_by"] = numeratorBy;
    if (on != null) args["on"] = pairing(on);
    const call = optionsText({ by: by ?? undefined, on: on ?? undefined });
    return this.#step(verb, args, call, nodeOf(other, "other"));
  }

  #step(verb: string, args: Record<string, unknown>, call: string, other?: TreeNode): Recipe {
    return makeRecipe(
      Object.freeze({
        kind: "step",
        verb,
        arguments: structuredClone(args),
        data: this.#tree,
        other,
        call,
      }),
    );
  }
}

/**
 * A recipe that starts from `start`: a spec, whose rows are never downloaded, a `DatasetRef`,
 * or a `Dataset`. A `Recipe` returns as it is.
 *
 * @throws {InvalidRequestError} `start` is none of those, such as a spec id on its own
 *   (`invalid_argument`).
 */
export function recipe(start: Start): Recipe {
  if (start instanceof Recipe) return start;
  return makeRecipe(nodeOf(start, "start"));
}

/** Whether a value is something a recipe starts from, as opposed to an options object: a
 *  `Recipe`, `DatasetRef` or `Dataset`, or an object with a `spec_id`. */
export const isStart = (value: unknown): value is Start =>
  value instanceof Recipe ||
  value instanceof DatasetRef ||
  value instanceof Dataset ||
  (isRecord(value) && Object.hasOwn(value, "spec_id"));

/** The node a recipe's `start` or a step's other reading sends. */
function nodeOf(start: unknown, role: string): TreeNode {
  if (start instanceof Recipe) return treeOf(start);
  const ref = start instanceof Dataset ? start.ref : start;
  if (ref instanceof DatasetRef) return refRoot(ref);
  if (isRecord(start) && typeof start["spec_id"] === "string" && start["spec_id"] !== "") {
    const specId = start["spec_id"];
    return root({ spec_id: specId, rendering: { without_party_totals: true } }, specId);
  }
  throw invalid(
    `A recipe's ${role} is a spec, a DatasetRef, a Dataset or a Recipe, not ${described(start)}.`,
  );
}

function refRoot(ref: DatasetRef): RootNode {
  const [member, ...others] = ref.members;
  if (member === undefined || others.length > 0) {
    // DFO refuses several readings with `several_members`, naming them.
    return root({ ref: structuredClone(ref.toJSON()) }, `${ref.members.length} readings`);
  }
  const specId = member.spec.spec_id;
  if (isDatasetMember(member)) {
    return root(
      {
        spec_id: specId,
        content_version: member.contentVersion,
        rendering: { without_party_totals: member.rendering.without_party_totals === true },
      },
      specId,
    );
  }
  return root({ spec_id: specId, content_version: member.contentVersion }, specId);
}

const root = (node: Record<string, unknown>, name: string): RootNode =>
  Object.freeze({ kind: "root", node: Object.freeze(node), name });

function wire(node: TreeNode): Record<string, unknown> {
  if (node.kind === "root") return structuredClone(node.node);
  const inputs: Record<string, unknown> = { data: wire(node.data) };
  if (node.other !== undefined) inputs["other"] = wire(node.other);
  return { verb: node.verb, arguments: structuredClone(node.arguments), inputs };
}

/** The chain that makes `node`, as it was called: `recipe(spec_…).rank({ … })`. */
function callText(node: TreeNode): string {
  if (node.kind === "root") return `recipe(${node.name})`;
  const other =
    node.other === undefined
      ? ""
      : node.other.kind === "root"
        ? node.other.name
        : callText(node.other);
  const args = [other, node.call].filter((text) => text !== "").join(", ");
  // The method a step's verb is called by: `quotient_of` is `quotientOf`.
  const method = node.verb.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  return `${callText(node.data)}.${method}(${args})`;
}

/** The options given, as a call writes them; undefined and null are ones left out. */
function optionsText(options: Readonly<Record<string, unknown>>): string {
  const given = Object.entries(options).filter(([, value]) => value != null);
  if (given.length === 0) return "";
  return `{ ${given.map(([key, value]) => `${key}: ${valueText(value)}`).join(", ")} }`;
}

/** A value as code writes it: text quoted, a latest year as its call, arrays and objects in
 *  their literal forms. */
function valueText(value: unknown): string {
  if (value instanceof LatestYear) return String(value);
  if (Array.isArray(value)) return `[${value.map(valueText).join(", ")}]`;
  if (isRecord(value)) {
    const entries = Object.entries(value).map(
      ([key, item]) =>
        `${/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)}: ${valueText(item)}`,
    );
    return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
  }
  return quoted(value);
}

/** A tree as JSON with every object's keys sorted, so equal trees write equal text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  // A tree holds JSON values alone, so undefined stands only for a missing member.
  return value === undefined ? "null" : JSON.stringify(value);
}

/**
 * The role word `chain` named each of DFO's columns by, such as
 * `{ financingRecipient: "destination" }`, read step by step from the tree the client sent and
 * the tree DFO stored for it. A column the call named by itself is left out, as is one two
 * words name and one whose word the stored tree does not place, such as a role of a step whose
 * `by` and `on` DFO merged into one sorted list. The stored tree holds columns alone, so a word
 * pairs with a column by name or by elimination, never by position: a list DFO stored in another
 * order names no role rather than the wrong one.
 */
export function columnRoles(chain: Recipe, stored: unknown): Record<string, string> {
  const found = new Map<string, Set<string>>();
  noteRoles(treeOf(chain), stored, found);
  const roles: Record<string, string> = {};
  for (const [column, words] of found) {
    const [word] = words;
    if (words.size === 1 && word !== undefined && word !== column) roles[column] = word;
  }
  return roles;
}

/** Adds to `found` the columns a step and its inputs name each word by. */
function noteRoles(node: TreeNode, stored: unknown, found: Map<string, Set<string>>): void {
  if (node.kind !== "step" || !isRecord(stored)) return;
  const opSpec = stored["op_spec"];
  const inputs = stored["inputs"];
  if (!isRecord(opSpec) || !isRecord(inputs) || !isRecord(opSpec["parameters"])) return;
  const parameters = opSpec["parameters"];
  const note = (words: unknown, columnsOf: unknown): void => {
    for (const [word, column] of paired(words, columnsOf)) {
      found.set(column, (found.get(column) ?? new Set<string>()).add(word));
    }
  };
  const args = node.arguments;
  for (const name of ORDERED_BY) note(args[name], parameters[name]);
  const on = args["on"];
  const pairs = Array.isArray(on)
    ? Object.fromEntries(on.map((word: unknown) => [String(word), word]))
    : on;
  if (isRecord(pairs)) {
    const storedPairs = parameters[STORED_PAIRS[node.verb] ?? ""];
    if (isRecord(storedPairs)) {
      note(Object.keys(pairs), Object.keys(storedPairs));
      note(Object.values(pairs), Object.values(storedPairs));
    } else if (node.verb === "join" && Object.keys(pairs).length === 1) {
      // A join whose pair names one column on both sides stores it alone.
      const [[key, value]] = Object.entries(pairs) as [[string, unknown]];
      note([key], parameters["join_keys"]);
      note([value], parameters["join_keys"]);
    }
  } else if (Object.hasOwn(args, "numerator_by")) {
    note(args["numerator_by"], parameters["numerator_by"]);
  }
  // Compare reads `data` as its right frame, as DFO's runner places it.
  const dataSlot = node.verb === "compare" ? "right_frame_ref" : "frame_ref";
  noteRoles(node.data, inputs[dataSlot], found);
  if (node.other !== undefined) {
    const otherSlots = Object.keys(inputs).filter((slot) => slot !== dataSlot);
    if (otherSlots.length === 1) noteRoles(node.other, inputs[otherSlots[0]!], found);
  }
}

/** Each word of a step's list with the stored column it names: a word that is a column names
 *  itself, and the one word left names the one column left. Lists of different lengths, or of
 *  several words left, pair no more. */
function paired(words: unknown, columnsOf: unknown): [string, string][] {
  if (!Array.isArray(words) || !Array.isArray(columnsOf)) return [];
  const texts = words.filter((word: unknown): word is string => typeof word === "string");
  const stored = columnsOf.filter(
    (column: unknown): column is string => typeof column === "string",
  );
  if (texts.length !== words.length || stored.length !== columnsOf.length) return [];
  if (texts.length !== stored.length) return [];
  const named: [string, string][] = texts
    .filter((word) => stored.includes(word))
    .map((word) => [word, word]);
  const left = texts.filter((word) => !stored.includes(word));
  const unnamed = stored.filter((column) => !texts.includes(column));
  if (left.length === 1 && unnamed.length === 1) named.push([left[0]!, unnamed[0]!]);
  return named;
}

const clipped = (text: string): string =>
  text.length <= SHOWN_MAX ? text : `${text.slice(0, SHOWN_MAX - 1).trimEnd()}…`;

const invalid = (detail: string): InvalidRequestError =>
  clientError("invalid_argument", { detail });

const refusal = (argument: string, rule: string, value: unknown): InvalidRequestError =>
  invalid(`${argument} ${rule}, not ${shown(value)}.`);

/** A value as a refusal quotes it. */
const shown = (value: unknown): string => clipped(quoted(value));

/** What a start that is none of the four is, for a refusal. */
function described(value: unknown): string {
  if (value === undefined || value === null) return String(value);
  if (typeof value === "string") return `the string ${JSON.stringify(clipped(value))}`;
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object with no spec_id" : typeof value;
}

function name(argument: string, value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw refusal(argument, "names roles or columns by non-empty text", value);
  }
  return value;
}

/** A value or a list of values, each non-empty text. */
function texts(argument: string, values: unknown): string[] {
  const listed = typeof values === "string" ? [values] : values;
  if (!Array.isArray(listed) || listed.length === 0) {
    throw refusal(argument, "maps each name to a value or a list of values", values);
  }
  return listed.map((value: unknown) => name(argument, value));
}

/** One role or column, or several, as a list. */
function columns(argument: string, value: unknown, empty: boolean): string[] {
  if (typeof value === "string") return [name(argument, value)];
  if (!Array.isArray(value) || (value.length === 0 && !empty)) {
    throw refusal(argument, 'names a role, such as "origin", or several', value);
  }
  return value.map((item: unknown) => name(argument, item));
}

function pairing(on: unknown): Record<string, string> | string[] {
  if (typeof on === "string" || Array.isArray(on)) return columns("on", on, false);
  if (!isRecord(on) || Object.keys(on).length === 0) {
    throw refusal("on", "pairs at least one role", on);
  }
  return Object.fromEntries(
    Object.entries(on).map(([key, value]) => [name("on", key), name("on", value)]),
  );
}

function windowOf(window: unknown): Record<string, unknown> {
  if (!Array.isArray(window) || window.length !== 2) {
    throw refusal("window", "is [firstYear, lastYear], such as [2015, latestYear()]", window);
  }
  const [start, end] = window as unknown[];
  return {
    window_start: periodObject(start, "window"),
    window_end: periodObject(end, "window"),
  };
}

/** An option's word; DFO refuses one it does not know, listing the others. */
function word(argument: string, value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw refusal(argument, 'is a word such as "sum"', value);
  }
  return value;
}
