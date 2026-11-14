/**
 * What the lookups return: a `Match` per name resolved, a `Node`, a `Code` and the `Catalogue`.
 *
 * Each is a frozen object whose fields take their types from the wire schema they read, and
 * whose `raw` holds that wire object untouched. Each prints as one line of at most `LINE_MAX`
 * characters, such as `Kenya -> Kenya  country/KEN  (country)`, through `toString` and Node's
 * `util.inspect`, with the server's text passed through `inline`.
 */

import { clientError } from "../core/errors.ts";
import { isRecord, strings } from "../core/json.ts";
import { inline } from "../core/text.ts";
import type {
  CatalogueResponse,
  CodeRegistryEntry,
  EntityRef,
  paths,
  ResolveResult,
} from "../wire.ts";

/** One graph node, told apart by its `kind`. */
export type GraphNode =
  paths["/api/graph/node/{dcid}"]["get"]["responses"][200]["content"]["application/json"];

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/** The most characters a result's line holds. */
const LINE_MAX = 180;

/** The most characters a match's text, a listed node's name and a catalogue's example take in
 *  a line, and the most candidates or near matches a match lists before it counts the rest. */
const TEXT_MAX = 40;
const NAME_MAX = 30;
const EXAMPLE_MAX = 60;
const SHOWN_MAX = 3;

/** `text` cut to `width` characters, counted as code points, the last one `…`. */
function clipped(text: string, width: number): string {
  const characters = Array.from(text);
  if (characters.length <= width) return text;
  return `${characters
    .slice(0, width - 1)
    .join("")
    .trimEnd()}…`;
}

const line = (text: string): string => clipped(inline(text), LINE_MAX);

/** `1 near match`, `2 near matches`: `plural` spells a plural that is not the noun and `s`. */
const counted = (count: number, noun: string, plural = `${noun}s`): string =>
  `${count} ${count === 1 ? noun : plural}`;

/** `Kenya  country/KEN`, the name cut to `width`, or the dcid alone when there is no name. */
const named = (dcid: string, name: string | null, width = NAME_MAX): string =>
  name ? `${clipped(name, width)}  ${dcid}` : dcid;

/** `Kenya  country/KEN  (country)`, with the name or the kind left out when there is none. */
const nodeLine = (dcid: string, name: string | null, kind: string | null): string =>
  `${named(dcid, name, LINE_MAX)}${kind ? `  (${kind})` : ""}`;

/** Up to `SHOWN_MAX` entities as `name  dcid`, joined by ` | `, then `+N more`. */
function listed(entities: readonly Entity[]): string {
  const shown = entities.slice(0, SHOWN_MAX).map((entity) => named(entity.dcid, entity.name));
  const rest = entities.length - SHOWN_MAX;
  return [...shown, ...(rest > 0 ? [`+${rest} more`] : [])].join(" | ");
}

/** A graph node a name resolved to, or a candidate or near match for one. */
export class Entity {
  /** The node's id, such as `country/KEN`. */
  readonly dcid: EntityRef["ref"];
  readonly name: EntityRef["label"];
  /** Null only for a node the graph names and does not hold. */
  readonly kind: EntityRef["kind"];

  /** @internal Entities come from `client.lookup.resolve`. */
  constructor(ref: EntityRef) {
    this.dcid = ref.ref;
    this.name = ref.label;
    this.kind = ref.kind ?? null;
    Object.freeze(this);
  }

  /** `Kenya  country/KEN  (country)`. */
  toString(): string {
    return line(nodeLine(this.dcid, this.name, this.kind));
  }

  /** Node's `console.log` and `util.inspect` show the entity as `String(entity)` does. */
  [INSPECT](): string {
    return this.toString();
  }
}

/** The entities a result lists; a list held as another JSON type reads as none. */
const isList = (refs: readonly EntityRef[] | null): refs is readonly EntityRef[] =>
  Array.isArray(refs);
const entities = (refs: readonly EntityRef[] | null): readonly Entity[] =>
  Object.freeze((isList(refs) ? refs : []).map((ref) => new Entity(ref)));

/** What one name resolved to. `entity` is set when `status` is `resolved` or `not_held`; a
 *  `not_held` entity names an id the resolver knows and the graph does not hold, so it does not
 *  open on the node route. `candidates` holds the nodes an `ambiguous` name may mean, and
 *  `nearMatches` the names close to one, as hints for a person. */
export class Match {
  /** The name as asked. */
  readonly text: ResolveResult["input"];
  readonly status: ResolveResult["status"];
  readonly entity: Entity | null;
  readonly candidates: readonly Entity[];
  readonly nearMatches: readonly Entity[];
  /** The resolver's result for the name, untouched. */
  readonly raw: ResolveResult;

  /** @internal Matches come from `client.lookup.resolve`. */
  constructor(result: ResolveResult) {
    this.text = result.input;
    this.status = result.status;
    // An entity held as another JSON type than an object reads as none.
    this.entity = isRecord(result.entity) ? new Entity(result.entity) : null;
    this.candidates = entities(result.candidates);
    this.nearMatches = entities(result.near_matches);
    this.raw = result;
    Object.freeze(this);
  }

  /** The name and what it resolved to: `Kenya -> Kenya  country/KEN  (country)`, then
   *  `+N near matches` when there are some; `Atlantis -> not held: ` and the entity named;
   *  `Congo -> ambiguous: ` and the candidates; or `Germny -> not found; nearest: ` and the near
   *  matches. */
  toString(): string {
    const text = clipped(this.text, TEXT_MAX);
    if (this.status === "resolved" && this.entity !== null) {
      const near = this.nearMatches.length;
      const nearLine = near > 0 ? `  +${counted(near, "near match", "near matches")}` : "";
      return line(`${text} -> ${this.entity.toString()}${nearLine}`);
    }
    const status = this.status.replaceAll("_", " ");
    if (this.entity !== null) return line(`${text} -> ${status}: ${this.entity.toString()}`);
    if (this.candidates.length > 0) return line(`${text} -> ${status}: ${listed(this.candidates)}`);
    if (this.nearMatches.length > 0) {
      return line(`${text} -> ${status}; nearest: ${listed(this.nearMatches)}`);
    }
    return line(`${text} -> ${status}`);
  }

  /** Node's `console.log` and `util.inspect` show the match as `String(match)` does. */
  [INSPECT](): string {
    return this.toString();
  }
}

/** One graph node, read by its dcid. `raw` holds the kind's own block, such as a country's
 *  `country.contained_in`. */
export class Node {
  readonly dcid: GraphNode["ref"];
  /** Null when the graph gives the node no name. */
  readonly name: GraphNode["label"];
  readonly kind: GraphNode["kind"];
  /** The node's graph types, such as `Country`. */
  readonly types: readonly GraphNode["types"][number][];
  /** The node route's response body, untouched. */
  readonly raw: GraphNode;

  /** @internal Nodes come from `client.lookup.node`. */
  constructor(node: GraphNode) {
    this.dcid = node.ref;
    this.name = node.label ?? null;
    this.kind = node.kind;
    // A type that is not a string is left out, as Python's client leaves it.
    this.types = Object.freeze(strings(node.types));
    this.raw = node;
    Object.freeze(this);
  }

  /** `Kenya  country/KEN  (country)  types: Country`. */
  toString(): string {
    const types = this.types.length > 0 ? `  types: ${this.types.join(", ")}` : "";
    return line(`${nodeLine(this.dcid, this.name, this.kind)}${types}`);
  }

  /** Node's `console.log` and `util.inspect` show the node as `String(node)` does. */
  [INSPECT](): string {
    return this.toString();
  }
}

/** A code's registry entry: what a refusal or warning code means. */
export class Code {
  readonly code: CodeRegistryEntry["code"];
  /** Null for a code the registry does not define. */
  readonly definition: CodeRegistryEntry["definition"];
  /** The registry's response body, untouched. */
  readonly raw: CodeRegistryEntry;

  /** @internal Codes come from `client.lookup.code`. */
  constructor(entry: CodeRegistryEntry) {
    this.code = entry.code;
    this.definition = entry.definition ?? null;
    this.raw = entry;
    Object.freeze(this);
  }

  /** `spec_not_found: No definition is registered at this id, ...`. */
  toString(): string {
    return line(this.definition === null ? this.code : `${this.code}: ${this.definition}`);
  }

  /** Node's `console.log` and `util.inspect` show the code as `String(code)` does. */
  [INSPECT](): string {
    return this.toString();
  }
}

/** What Search holds data on: its counts and example questions, for one country when the
 *  lookup named one. */
export class Catalogue {
  /** The catalogue build the counts come from. */
  readonly version: CatalogueResponse["catalogue_version"];
  /** Counts across DFO, or at the country asked for. */
  readonly counts: CatalogueResponse["counts"];
  /** Questions to pass to `client.search`, such as `Life expectancy in Kenya`. */
  readonly examples: readonly CatalogueResponse["examples"][number]["text"][];
  /** The catalogue's response body, untouched. */
  readonly raw: CatalogueResponse;

  /** @internal The catalogue comes from `client.lookup.catalogue`. */
  constructor(catalogue: CatalogueResponse) {
    this.version = catalogue.catalogue_version;
    this.counts = catalogue.counts;
    this.examples = Object.freeze(catalogue.examples.map((example) => example.text));
    this.raw = catalogue;
    Object.freeze(this);
  }

  /** `7 publishers, 12,437 variables; 5 example questions, such as "ODA to Nigeria since
   *  2015"`: each top-level count, then the examples. */
  toString(): string {
    const totals = Object.entries(this.counts)
      .flatMap(([noun, count]) =>
        typeof count === "number" && Number.isInteger(count)
          ? [`${count.toLocaleString("en-US")} ${noun}`]
          : [],
      )
      .join(", ");
    const first = this.examples[0];
    const examples = `${counted(this.examples.length, "example question")}${
      first === undefined ? "" : `, such as "${clipped(first, EXAMPLE_MAX)}"`
    }`;
    return line(totals === "" ? examples : `${totals}; ${examples}`);
  }

  /** Node's `console.log` and `util.inspect` show the catalogue as `String(catalogue)` does. */
  [INSPECT](): string {
    return this.toString();
  }
}

/**
 * Fetch options with each `Entity` and resolved `Match` in `entities` read as its dcid, so a
 * role takes what `client.lookup.resolve` returns with no request of its own. Options that are
 * not an object, an `entities` that is not one, and any other value in a role stay as they
 * are, for the fetch to check.
 *
 * @throws {InvalidRequestError} A role holds a `Match` that did not resolve: an ambiguous name,
 *   a name not found, or a node the graph does not hold (`invalid_argument`).
 */
export function withEntityDcids<T>(options: T): T {
  if (!isRecord(options) || !isRecord(options["entities"])) return options;
  const entities = Object.entries(options["entities"]).map(([role, given]): [string, unknown] => [
    role,
    Array.isArray(given) ? given.map((item: unknown) => entityDcid(role, item)) : given,
  ]);
  return { ...options, entities: Object.fromEntries(entities) };
}

/**
 * The dcid an `Entity` or resolved `Match` names; any other value as it is.
 *
 * @throws {InvalidRequestError} A `Match` did not resolve (`invalid_argument`). The message
 *   names the dcid of its first candidate, else of its nearest match.
 */
function entityDcid(role: string, item: unknown): unknown {
  if (item instanceof Entity) return item.dcid;
  if (!(item instanceof Match)) return item;
  if (item.status === "resolved" && item.entity !== null) return item.entity.dcid;
  const [nearest] = item.candidates.length > 0 ? item.candidates : item.nearMatches;
  const fix =
    nearest === undefined
      ? "pass a dcid, or the Match of a name client.lookup.resolve resolved"
      : `pass the dcid you mean, such as ${JSON.stringify(nearest.dcid)}, or one of ` +
        (item.candidates.length > 0 ? "match.candidates" : "match.nearMatches");
  throw clientError("invalid_argument", {
    detail: `entities.${role} holds a Match that did not resolve, ${String(item)}; ${fix}.`,
  });
}
