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

import { Dataset, stepsText } from "./dataset.ts";
import type { DerivedStep } from "./dataset.ts";
import { clientError } from "../core/errors.ts";
import type { InvalidRequestError } from "../core/errors.ts";
import { isRecord } from "../core/json.ts";
import { checkOptions, declareOptions } from "../core/options.ts";
import { periodObject } from "../core/periods.ts";
import type { LatestYear } from "../core/periods.ts";
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

/** `relative`, a fraction of the first year's value, or `absolute`, an amount. */
export type Change = "relative" | "absolute";

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
  /** `relative` by default, a fraction such as 0.25 for 25%; `absolute` is an amount in the
   *  data's unit. */
  change?: Change;
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

/** The most characters of the roots' names a recipe's text shows. */
const ROOTS_SHOWN_MAX = 60;

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
  readonly shown: DerivedStep;
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

  /** The steps in run order and what they start from, as
   *  `Recipe(growth by origin, then rank by origin, limit 10, from spec_…)`. */
  toString(): string {
    const start = clipped([...new Set(rootsOf(this.#tree))].join(", "));
    return inline(`Recipe(${stepsText(shownOf(this.#tree), start)})`);
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
    return this.#step("filter", { predicates }, { verb: "filter", by: [], limit: null });
  }

  /** Totals or averages the rows, keeping the members of `by` apart. */
  aggregate(options: AggregateOptions = {}): Recipe {
    const { by = [], how = "sum" } = checkOptions(AGGREGATE, options);
    const groupBy = columns("by", by, true);
    return this.#step(
      "aggregate",
      { group_by: groupBy, aggregation: word("how", how) },
      { verb: "aggregate", by: groupBy, limit: null },
    );
  }

  /** The change of each member of `by` from the first to the last year of `window`. */
  growth(options: GrowthOptions): Recipe {
    const { by = [], window, change = "relative" } = checkOptions(GROWTH, options);
    const entityBy = columns("by", by, true);
    return this.#step(
      "growth",
      { ...windowOf(window), entity_by: entityBy, change: word("change", change) },
      { verb: "growth", by: entityBy, limit: null },
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
    return this.#step("rank", args, { verb: "rank", by: rankBy, limit: limit ?? null });
  }

  /** Divides by another reading, pairing members through `on`, such as aid per person with
   *  `{ on: { destination: "place" } }`. */
  quotientOf(other: Start, options: PairOptions = {}): Recipe {
    return this.#pair("quotient_of", other, checkOptions(PAIR, options).on, null);
  }

  /**
   * Each value as a percentage of the matching row of `total`, or, with no `total`, of the
   * total across all members of `by` in the same year, as `.shareOf({ by: "origin" })`.
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
    return this.#step(
      "share_of",
      { numerator_by: numeratorBy },
      { verb: "share_of", by: numeratorBy, limit: null },
    );
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
    return this.#step(verb, args, { verb, by: numeratorBy, limit: null }, nodeOf(other, "other"));
  }

  #step(verb: string, args: Record<string, unknown>, shown: DerivedStep, other?: TreeNode): Recipe {
    return makeRecipe(
      Object.freeze({
        kind: "step",
        verb,
        arguments: structuredClone(args),
        data: this.#tree,
        other,
        shown: Object.freeze({ ...shown, by: Object.freeze([...shown.by]) }),
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

/** The steps in the order they run: each after its inputs, `data` first. */
function shownOf(node: TreeNode): DerivedStep[] {
  if (node.kind === "root") return [];
  const other = node.other === undefined ? [] : shownOf(node.other);
  return [...shownOf(node.data), ...other, node.shown];
}

function rootsOf(node: TreeNode): string[] {
  if (node.kind === "root") return [node.name];
  const other = node.other === undefined ? [] : rootsOf(node.other);
  return [...rootsOf(node.data), ...other];
}

const clipped = (text: string): string =>
  text.length <= ROOTS_SHOWN_MAX ? text : `${text.slice(0, ROOTS_SHOWN_MAX - 1).trimEnd()}…`;

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
