import type { Gap } from "../search/answer.ts";
import {
  decodeRows,
  encodeStacked,
  memberRows,
  presentedOrder,
  readParquet,
  stackedColumns,
} from "./parquet.ts";
import type { Row, Table } from "./parquet.ts";
import { checkKeys, DatasetRef, invalid, isDerived, loadRef, objectAt } from "../core/ref.ts";
import type {
  DatasetRefJson,
  DerivedRefMember,
  Layout,
  RefMember,
  Rendering,
  ResolvedPeriod,
  Spec,
} from "../core/ref.ts";
import { manifestWarningsOf } from "../core/parse.ts";
import type { PartFacts } from "../core/parse.ts";
import type { Assumption, Departure, Notice, RequestedOperation } from "../wire.ts";
import { canonicalJson, compareCodePoints, isRecord, list, objects, text } from "../core/json.ts";
import { inline } from "../core/text.ts";
import { clientError } from "../core/errors.ts";
import { COLUMN_ROLE_KEYS } from "../generated/role-keys.ts";
import { platformFileWriter } from "./save.ts";

/** The version of the provenance a file from `toBytes()` carries under `dfo.*` keys, the one
 *  Python's `Dataset.save` writes: 1 for a dataset of dataset versions, and 2 for a derived
 *  dataset, whose `dfo.ref` is a format 2 ref and which adds `dfo.left_out` and `dfo.steps`, so
 *  a client that reads format 1 alone refuses it as a later format. */
const SAVED_FORMAT_VERSION = 1;
const SAVED_DERIVED_FORMAT_VERSION = 2;
/** The format of the object `Provenance.toObject()` returns. */
const PROVENANCE_FORMAT_VERSION = 1;

/** One source a dataset cites. */
export type CitationSource = {
  /** The source's id in the graph. */
  readonly ref: string;
  /** The source's name. */
  readonly label: string;
  /** The licence's name, or null when the source declares none. */
  readonly licence: string | null;
  /** Where the licence is published, or null when the source names no page. */
  readonly licenceUrl: string | null;
  /** Where the source publishes the data, or null when the source names no page. */
  readonly url: string | null;
};

/** How to cite the data: the citation text and the cited sources. */
export type Citation = {
  readonly text: string;
  readonly sources: readonly CitationSource[];
};

/** One reading inside a dataset: the exact version built for it. */
export type Member = {
  /** The variable text of each answer part the member answers, in query order, or empty for a
   *  spec fetched outside an answer. */
  readonly parts: readonly string[];
  /** The spec the server built, which a narrowing gives its own `spec_id`. */
  readonly spec: Spec;
  readonly contentVersion: string;
  /** Search's sentence for the built identity. */
  readonly sentence: string;
  readonly citation: Citation;
  /** The SHA-256 digest of the member's Parquet file, which the fetch checked. */
  readonly digest: string;
  readonly rendering: Rendering;
};

/** One derived frame inside a dataset: the frame an analysis recipe computed, with its
 *  citation. */
export type DerivedMember = DerivedRefMember & { readonly citation: Citation };

/** The step of a recipe that dropped a series. */
export type LeftOutStep = {
  /** The step's operation, such as `growth`. */
  readonly verb: string;
  /** The step's place in the recipe: 0 is the step that made the dataset, and each step comes
   *  before the steps it reads from. */
  readonly node: number;
};

/** A left-out series' fields, as the derived manifest serves them and a saved file keeps
 *  them. */
export type LeftOutFields = {
  readonly coordinates: Readonly<Record<string, string>>;
  readonly step: LeftOutStep;
  readonly side: string;
  readonly reason: string;
  readonly rows: number;
};

/**
 * A series a step of the recipe behind a dataset dropped for missing data.
 *
 * `String(series)` leads with the entity, as
 * `LeftOutSeries(destination=country/NGA: growth dropped 1 row from data, endpoint_missing)`. A
 * dataset a recipe from this client made names each column by the role the call used, such as
 * `destination`; one read from a ref names DFO's column, such as `financingRecipient`. The
 * `stat_var` of a frame an earlier step computed, `dcid:ops_…`, is left out of the text.
 *
 * `reason` is one of DFO's data-gap codes:
 *
 * - `endpoint_missing`: growth found no value in the window's first year or its last.
 * - `zero_or_sign_crossing_base`: a relative growth's first-year value is zero, or the value
 *   changes sign, so the fraction has no meaning.
 * - `non_finite`: the change worked out to a number too large to hold.
 * - `unmatched_key`: the other reading holds no row for this member, as when a population
 *   reading lacks Ghana; `side` names the reading that held the row.
 * - `period_unmatched`: the two readings share no year for this member, or hold some of its
 *   years on one side only.
 * - `zero_denominator`: a quotient whose other reading sums to zero.
 * - `unit_unbound`: the rows declare no unit, so the step could not check that both readings
 *   share one.
 *
 * A newer DFO can send a code this list lacks.
 */
export class LeftOutSeries {
  /** The value of each column that names the series, by DFO's column names, such as
   *  `{ financingRecipient: "country/NGA" }`, which match the frame's columns. */
  readonly coordinates: Readonly<Record<string, string>>;
  /** The step that dropped the series. */
  readonly step: LeftOutStep;
  /** The step input it came from: `data`, or `other` for the second reading of a two-reading
   *  operation. */
  readonly side: string;
  /** Why the step dropped it, one of the codes above. */
  readonly reason: string;
  /** The rows of the series the step left out. */
  readonly rows: number;
  /** The role word the call named each column by, for the text form alone. */
  readonly #roles: Readonly<Record<string, string>>;

  /** @internal A series comes from a derived dataset's `leftOut`. */
  constructor(fields: LeftOutFields, roles: Readonly<Record<string, string>> = {}) {
    this.coordinates = Object.freeze({ ...fields.coordinates });
    this.step = Object.freeze({ verb: fields.step.verb, node: fields.step.node });
    this.side = fields.side;
    this.reason = fields.reason;
    this.rows = fields.rows;
    this.#roles = Object.freeze({ ...roles });
    Object.freeze(this);
  }

  /** The series as `LeftOutSeries(destination=country/NGA: growth dropped 1 row from data,
   *  endpoint_missing)`. */
  toString(): string {
    const entity = Object.entries(this.coordinates)
      .filter(([key]) => key !== "stat_var")
      .map(([key, value]) => [this.#roles[key] ?? key, value]);
    const variable = this.coordinates["stat_var"];
    if (variable !== undefined && !variable.startsWith("dcid:ops_")) {
      entity.push(["stat_var", variable]);
    }
    const named = entity.map(([key, value]) => `${key}=${value}`).join(", ");
    const rows = this.rows === 1 ? "1 row" : `${this.rows.toLocaleString("en-GB")} rows`;
    return inline(
      `LeftOutSeries(${named === "" ? "" : `${named}: `}${this.step.verb} dropped ${rows} from ` +
        `${this.side}, ${this.reason})`,
    );
  }

  /** Node's `console.log` and `util.inspect` show the series as `String(series)` does. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}

/** One step of a recipe, as a derived dataset's text names it: the operation, the columns or
 *  roles it keeps apart, and for a ranking the most members it keeps. */
export type DerivedStep = {
  readonly verb: string;
  readonly by: readonly string[];
  readonly limit: number | null;
};

/** A step as `rank by origin, limit 10`. */
const stepText = ({ verb, by, limit }: DerivedStep): string =>
  verb + (by.length > 0 ? ` by ${by.join(", ")}` : "") + (limit === null ? "" : `, limit ${limit}`);

/** Steps in the order they run and what they start from, as
 *  `growth by origin, then rank by origin, limit 10, from 1 reading`. */
export function stepsText(steps: readonly DerivedStep[], source: string): string {
  const done = steps.map(stepText).join(", then ");
  return done === "" ? `from ${source}` : `${done}, from ${source}`;
}

/** One series whose rows kept an entry's totals, and the periods in which they stayed. */
export type KeptSeries = {
  /** Each column of the frame's grain other than the entry's role, `time_period` and
   *  `provenance`, such as `stat_var`, the other role columns, `unit` and `measurementMethod`,
   *  mapped to the cell the series holds there: a string, null, or a unit as a JSON object. */
  readonly series: Readonly<Record<string, unknown>>;
  /** The `time_period` values, sorted by code point, in which the series kept the totals. */
  readonly timePeriods: readonly string[];
};

/**
 * Group totals on one party role that a fetch left out of one member's rows. A fetch leaves
 * party totals out by default, so a sum over `value` counts each flow once. `partyTotals: true`
 * keeps them. DFO names what the cut dropped in the version's manifest, one entry per party role,
 * provenance and set of kept series and periods, and the dataset gathers those entries in member
 * order, then in the manifest's order. Two entries can share a role and a provenance. A derived
 * dataset's entries describe each reading its recipe ran on, in the order of its ref's roots.
 */
export type PartyTotalsLeftOut = {
  /** The spec of the member whose rows lost the totals, or for a derived dataset the reading's. */
  readonly specId: string;
  /** The party role, by DFO's column name, such as `financingProvider`. */
  readonly role: string;
  /** The key a caller names the role by in `entities`, `origin` or `destination`, or null for a
   *  column the client does not know. */
  readonly roleKey: string | null;
  /** The dcids of the totals left out, such as `DACCountriesTotal`. */
  readonly entities: readonly string[];
  /** The dataset whose rows lost the totals, or null for rows with no provenance, or when
   *  `everyProvenance` is true. */
  readonly provenance: string | null;
  /** Whether the totals left the rows of every dataset, as on a version DFO recorded before it
   *  named the provenance. */
  readonly everyProvenance: boolean;
  /** The series whose rows kept these totals, each with the periods where they stayed, in the
   *  manifest's order; empty when the totals left every series in every period. */
  readonly keptIn: readonly KeptSeries[];
};

/** A non-empty string. */
const isFilled = (value: unknown): value is string => typeof value === "string" && value !== "";

/** Compares two lists element by element with `compare`, a shorter prefix first. */
function compareLists<T>(
  a: readonly T[],
  b: readonly T[],
  compare: (x: T, y: T) => number,
): number {
  for (let index = 0; index < a.length && index < b.length; index += 1) {
    const order = compare(a[index]!, b[index]!);
    if (order !== 0) return order;
  }
  return Math.sign(a.length - b.length);
}

/** One series cell's sort key: its column, then null before a string before an object, then the
 *  string or the object's JCS text. */
type CellKey = readonly [column: string, kind: number, text: string];

const compareCellKeys = (a: CellKey, b: CellKey): number =>
  compareCodePoints(a[0], b[0]) || a[1] - b[1] || compareCodePoints(a[2], b[2]);

/** A `kept_in` item as `{series, timePeriods}` with its sort key, or null when it is no object of
 *  exactly a `series` object whose cells are strings, nulls or objects and `time_periods`, a
 *  non-empty list of non-empty strings sorted by code point, each once. */
function keptSeries(item: unknown): { kept: KeptSeries; key: CellKey[] } | null {
  if (!isRecord(item)) return null;
  const names = Object.keys(item);
  if (names.length !== 2 || !Object.hasOwn(item, "series")) return null;
  const { series, time_periods: periods } = item;
  if (!isRecord(series) || !Array.isArray(periods) || periods.length === 0) return null;
  if (
    !periods.every(
      (period: unknown, index) =>
        isFilled(period) &&
        (index === 0 || compareCodePoints(periods[index - 1] as string, period) < 0),
    )
  ) {
    return null;
  }
  const key: CellKey[] = [];
  for (const column of Object.keys(series).toSorted(compareCodePoints)) {
    const cell = series[column];
    if (cell === null) key.push([column, 0, ""]);
    else if (typeof cell === "string") key.push([column, 1, cell]);
    else if (isRecord(cell)) key.push([column, 2, canonicalJson(cell)]);
    else return null;
  }
  const kept = Object.freeze({
    series: Object.freeze(structuredClone(series)),
    timePeriods: Object.freeze([...(periods as string[])]),
  });
  return { kept, key };
}

/** The series a trace entry's `kept_in` lists: empty when it is absent, and null when it is no
 *  non-empty list of well-formed items in the contract's order, no two with the same series. */
function keptInOf(value: unknown): KeptSeries[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0) return null;
  const kept: KeptSeries[] = [];
  let previous: CellKey[] | null = null;
  for (const item of value) {
    const read = keptSeries(item);
    if (read === null) return null;
    if (previous !== null && compareLists(previous, read.key, compareCellKeys) >= 0) return null;
    kept.push(read.kept);
    previous = read.key;
  }
  return kept;
}

/**
 * One entry of a manifest's `trace.party_totals_left_out` as `{role, entities, provenance,
 * kept_in}`, where an absent `provenance` means every dataset's rows; null when the entry is no
 * object, its `role` is no non-empty string, its `entities` is no list of non-empty strings, its
 * `provenance` is neither absent, a string nor null, or its `kept_in` is neither absent nor a
 * well-formed list in the contract's order. Other keys are ignored.
 */
function partyTotalsEntry(entry: unknown, specId: string): PartyTotalsLeftOut | null {
  if (!isRecord(entry)) return null;
  const { role, entities, provenance } = entry;
  if (!isFilled(role)) return null;
  if (!Array.isArray(entities) || !entities.every(isFilled)) return null;
  if (provenance !== undefined && provenance !== null && typeof provenance !== "string") {
    return null;
  }
  const keptIn = keptInOf(entry["kept_in"]);
  if (keptIn === null) return null;
  return Object.freeze({
    specId,
    role,
    roleKey: Object.hasOwn(COLUMN_ROLE_KEYS, role) ? (COLUMN_ROLE_KEYS[role] ?? null) : null,
    entities: Object.freeze([...entities]),
    provenance: provenance ?? null,
    everyProvenance: !Object.hasOwn(entry, "provenance"),
    keptIn: Object.freeze(keptIn),
  });
}

/** The entries a list of trace entries names for `specId`: none when `served` is no list, and a
 *  malformed entry is dropped while the entries beside it still read. */
function partyTotalsFrom(served: unknown, specId: string): PartyTotalsLeftOut[] {
  if (!Array.isArray(served)) return [];
  return served.flatMap((entry: unknown) => partyTotalsEntry(entry, specId) ?? []);
}

/**
 * The totals a manifest's `trace.party_totals_left_out` names for the member of `specId`. The
 * list is empty when the trace names none: a trace that is no object or a member that is no list
 * names none, and a malformed entry is dropped while the entries beside it still read.
 */
function partyTotalsOf(
  manifest: Readonly<Record<string, unknown>>,
  specId: string,
): PartyTotalsLeftOut[] {
  const trace = manifest["trace"];
  return partyTotalsFrom(isRecord(trace) ? trace["party_totals_left_out"] : undefined, specId);
}

/**
 * The totals each root's read left out, as a derived manifest's `roots[].party_totals_left_out`
 * names them, each entry under its root's spec id, in the order of the ref member's roots. Each
 * ref root pairs with the first manifest root of the same `spec_id` and `content_version` that no
 * earlier ref root took, and a manifest root that pairs with none names none. Empty against a
 * server older than the per-root report, and when the server could not read a root, so an empty
 * list leaves open whether the reads kept every total.
 */
function rootPartyTotalsOf(member: Omit<FetchedDerivedMember, "data">): PartyTotalsLeftOut[] {
  const served = objects(member.manifest["roots"]);
  const taken = new Set<number>();
  return member.roots.flatMap(({ specId, contentVersion }) => {
    const index = served.findIndex(
      (root, at) =>
        !taken.has(at) && root["spec_id"] === specId && root["content_version"] === contentVersion,
    );
    if (index === -1) return [];
    taken.add(index);
    return partyTotalsFrom(served[index]!["party_totals_left_out"], specId);
  });
}

/** The text form's line counting the totals left out on each role, with the key a caller names
 *  it by where the client knows it, as
 *  `Party totals left out: 15 on financingProvider (origin) · data.partyTotalsLeftOut`. A derived
 *  dataset's line counts the totals its readings left out. */
function partyTotalsLine(
  entries: readonly PartyTotalsLeftOut[],
  derived: boolean,
): string | undefined {
  const byRole = new Map<string, { roleKey: string | null; dcids: Set<string> }>();
  for (const { role, roleKey, entities } of entries) {
    const counted = byRole.get(role) ?? { roleKey, dcids: new Set<string>() };
    for (const entity of entities) counted.dcids.add(entity);
    byRole.set(role, counted);
  }
  if (byRole.size === 0) return undefined;
  const counts = [...byRole]
    .map(
      ([role, { roleKey, dcids }]) =>
        `${dcids.size.toLocaleString("en-GB")} on ${role}` +
        (roleKey === null ? "" : ` (${roleKey})`),
    )
    .join(", ");
  const label = derived ? "Party totals left out of the readings" : "Party totals left out";
  return `${label}: ${counts} · data.partyTotalsLeftOut`;
}

/** What a derived dataset adds to its member: every series its recipe left out, whether that
 *  list is whole, its steps in the order they ran, and the role word the call named each
 *  column by. */
export type DerivedFacts = {
  readonly leftOut: readonly LeftOutFields[];
  readonly leftOutComplete: boolean;
  readonly steps: readonly DerivedStep[];
  readonly roles?: Readonly<Record<string, string>>;
};

/** A built version, downloaded and checked against its digest, ready to join a dataset. */
export type FetchedMember = {
  readonly parts: readonly string[];
  readonly spec: Spec;
  readonly sentence: string;
  readonly contentVersion: string;
  /** The manifest the server answered for the version, as parsed JSON. */
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly digest: string;
  readonly rendering: Rendering;
  readonly data: Uint8Array;
  /** What the answer parts the member answers state, as `partFacts` reads them, when it came
   *  from an answer. Their departures, requested computations and assumptions reach the
   *  dataset. */
  readonly answerFacts?: readonly PartFacts[];
};

/** A derived frame, downloaded and checked against its digest, ready to join a dataset. */
export type FetchedDerivedMember = DerivedRefMember & {
  /** The manifest the server answered for the frame, as parsed JSON. */
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly data: Uint8Array;
};

/** A cited source as the server sent it, with the two members every source carries. */
const isServedSource = (
  value: unknown,
): value is Record<string, unknown> & { ref: string; label: string } =>
  isRecord(value) && typeof value["ref"] === "string" && typeof value["label"] === "string";

function citationOf(manifest: Readonly<Record<string, unknown>>): Citation {
  const citation = manifest["citation"];
  if (!isRecord(citation)) return { text: "", sources: [] };
  return {
    text: text(citation["text"]) ?? "",
    // Read `licence*`, the preferred spelling, and fall back to the deprecated `license*` a
    // server from before the rename serves.
    sources: list(citation["sources"])
      .filter(isServedSource)
      .map((source) =>
        Object.freeze({
          ref: source.ref,
          label: source.label,
          licence: text(Object.hasOwn(source, "licence") ? source["licence"] : source["license"]),
          licenceUrl: text(
            Object.hasOwn(source, "licence_url") ? source["licence_url"] : source["license_url"],
          ),
          url: text(source["url"]),
        }),
      ),
  };
}

const unique = <T>(items: readonly T[]): T[] => [
  ...new Map(items.map((item) => [JSON.stringify(item), item])).values(),
];

/** The datasets surface's warnings in the manifests, each with the members every warning has. */
const warningsOf = (manifests: readonly Readonly<Record<string, unknown>>[]): Notice[] =>
  unique(manifests.flatMap((manifest) => manifestWarningsOf(manifest["warnings"])));

function mergeCitations(citations: readonly Citation[]): Citation {
  const texts = new Set<string>();
  const sources = new Map<string, CitationSource>();
  for (const citation of citations) {
    if (citation.text !== "") texts.add(citation.text);
    for (const source of citation.sources) {
      if (!sources.has(source.ref)) sources.set(source.ref, source);
    }
  }
  return { text: [...texts].join("; "), sources: [...sources.values()] };
}

/** The earliest `held_until` across members, and whether every member is pinned. A member
 *  whose manifest has no `retention` counts as neither pinned nor dated. */
function retentionOf(manifests: readonly Readonly<Record<string, unknown>>[]): {
  heldUntil: Date | null;
  pinned: boolean;
} {
  const retentions = manifests.map((manifest) => manifest["retention"]);
  if (retentions.every((retention) => isRecord(retention) && retention["pinned"] === true)) {
    return { heldUntil: null, pinned: true };
  }
  let heldUntil: Date | null = null;
  for (const retention of retentions) {
    if (!isRecord(retention) || retention["pinned"] === true) continue;
    const held = retention["held_until"];
    if (typeof held !== "string") continue;
    const date = new Date(held);
    if (Number.isNaN(date.getTime())) continue;
    if (heldUntil === null || date < heldUntil) heldUntil = date;
  }
  return { heldUntil, pinned: false };
}

/** How `Dataset.create` assembles its members: the layout, the parts a partial fetch left out,
 *  and for a derived dataset what its manifest adds. */
type DatasetOptions = {
  readonly layout: Layout;
  readonly missing?: readonly Gap[];
  readonly derived?: DerivedFacts;
  /** The retention in place of the one the manifests state, as after a pin. */
  readonly retention?: { readonly heldUntil: Date | null; readonly pinned: boolean };
  /** The question the dataset answers, when it came from an answer. */
  readonly question?: string | null;
  /** When the data left the server, which the copies of a dataset keep. Now by default. */
  readonly fetchedAt?: Date;
  /** The share slot a share fetch read, as the text form's "Shown by" line names it:
   *  `share k3Qx8vTa, slot 2 "Malaria grants", on 3 October 2026`. */
  readonly shownBy?: string;
};

/** A member a dataset is made from, without its bytes, which the dataset holds itself. */
type MemberInput = Omit<FetchedMember, "data"> | Omit<FetchedDerivedMember, "data">;

/** Copies a dataset as pinned; Dataset's static block assigns it. */
let pinnedCopy: (dataset: Dataset) => Dataset;

/** `dataset` with every version kept without a time limit, as a pin leaves it. */
export const pinnedDataset = (dataset: Dataset): Dataset => pinnedCopy(dataset);

/** Copies a dataset with the share slot it was read from; Dataset's static block assigns it. */
let shownCopy: (dataset: Dataset, shownBy: string) => Dataset;

/** `dataset` naming the share slot a share fetch read it from, as `shownBy` words it. */
export const shownDataset = (dataset: Dataset, shownBy: string): Dataset =>
  shownCopy(dataset, shownBy);

/** The years a recipe's latest years settled on, and the newest year they count back from, as
 *  `Period: 2020 to 2024, counted back from 2024, ...`, or undefined when none settled. */
function periodLine(periods: readonly ResolvedPeriod[]): string | undefined {
  const [first] = periods;
  if (first === undefined) return undefined;
  // Each period is a year, and its offset counts years back from the newest.
  const newest = Number(first.period) - first.offset;
  const years = [...new Set(periods.map((period) => Number(period.period)))].sort((a, b) => a - b);
  const [earliest, latest] = [years[0]!, years[years.length - 1]!];
  const span = earliest === latest ? `${earliest}` : `${earliest} to ${latest}`;
  const rule = "the newest year at least half the series hold";
  if (earliest === newest && latest === newest) return `Period: ${newest}, ${rule}`;
  return `Period: ${span}, counted back from ${newest}, ${rule}`;
}

/** Reads a dataset's private table; Dataset's static block assigns it. */
let readTable: (dataset: Dataset) => Table;

/**
 * A table of data with its provenance: one exact version per member. It holds no client, so its
 * conversions never touch the network. A dataset fetched from a spec or a ref leaves no part out.
 *
 * The type of `time_period` follows the layout. The long layout holds it as an integer calendar
 * year, such as 2022. The frame layout, which a derived dataset and a share fetch hold, writes
 * it as text: a year such as `"2022"`, or for a growth an interval of its first and last years,
 * such as `"2021/2022"`. So a filter on `row.time_period === 2022` finds no rows in a frame. The
 * text form's Rows line names the type.
 */
export class Dataset {
  /** What the data shows, in Search's words: the members' sentences in order. */
  readonly sentence: string;
  /** One member per built spec, or for a dataset DFO computed, one derived member. */
  readonly members: readonly (Member | DerivedMember)[];
  /** How to cite the data, every member's sources together. */
  readonly citation: Citation;
  /** The datasets surface's warnings about the members' data. */
  readonly warnings: readonly Notice[];
  /** How the readings differ from the question. */
  readonly departures: readonly Departure[];
  /** Computations the question asked for, which the data leaves to the caller. */
  readonly requestedOperations: readonly RequestedOperation[];
  /** What Search assumed to read the question, as the answer parts' sentences state it. */
  readonly assumptions: readonly Assumption[];
  /** Whether every part of the question has a member. */
  readonly complete: boolean;
  /** The parts a partial fetch left out. */
  readonly missing: readonly Gap[];
  /** The earliest time any member's version can still be fetched, or null when every member is
   *  pinned or while the server does not say. */
  readonly heldUntil: Date | null;
  /** Whether every member's version is kept without a time limit. */
  readonly pinned: boolean;
  readonly layout: Layout;
  /** The artifact layout each member's manifest names, distinct ones joined by "; ". */
  readonly layoutVersion: string;
  /** The question the dataset answers, when it came from `answer.fetch()`, else null. */
  readonly question: string | null;
  /** When the data left the server, to the second. */
  readonly fetchedAt: Date;
  readonly #data: readonly Uint8Array[];
  /** Each member's file, one per member in member order, labelled as its `part` column holds
   *  it when several stack, in reading order. */
  readonly #table: Table;
  /** Every series a step of the recipe behind a derived dataset dropped for missing data, at
   *  any step, each naming its step. Empty for a dataset of dataset versions. DFO lists at most
   *  2,000; `String(data)` says "at least" when it dropped more. */
  readonly leftOut: readonly LeftOutSeries[];
  /** Whether `leftOut` lists every series the recipe dropped. */
  readonly #leftOutComplete: boolean;
  /** The group totals a fetch left out of each member's rows, one entry per member, party role,
   *  provenance and set of kept series and periods, in member order and then the manifest's
   *  order. Empty when nothing was left out and when the fetch passed `partyTotals: true`. A
   *  derived dataset's entries name the readings its recipe ran on and what each reading left
   *  out, in root order. Its list is also empty against a server older than this report and when
   *  the server could not read a reading, so an empty list there leaves open whether every total
   *  stayed. */
  readonly partyTotalsLeftOut: readonly PartyTotalsLeftOut[];
  /** The recipe's steps in the order they ran, for the text form's derived line. */
  readonly #steps: readonly DerivedStep[];
  /** The members and options the dataset was made from, less their bytes, for a copy. */
  readonly #inputs: { members: readonly MemberInput[]; options: DatasetOptions };

  static {
    readTable = (dataset) => dataset.#table;
    pinnedCopy = (dataset) => {
      const { members, options } = dataset.#inputs;
      const retention = { heldUntil: null, pinned: true };
      return new Dataset(members, { ...options, retention }, dataset.#data, dataset.#table);
    };
    shownCopy = (dataset, shownBy) => {
      const { members, options } = dataset.#inputs;
      return new Dataset(members, { ...options, shownBy }, dataset.#data, dataset.#table);
    };
  }

  /**
   * @internal Datasets come from a fetch. This builds one from the members it downloaded and
   * checked against their digests, decoding every member once to read the table's reading
   * order.
   *
   * @throws {ContractError} The members do not stack, or a file is not one the client can read.
   */
  static async create(
    members: readonly (FetchedMember | FetchedDerivedMember)[],
    options: DatasetOptions,
  ): Promise<Dataset> {
    if (members.length === 0) throw new TypeError("A dataset needs at least one member.");
    if (options.layout === "frame" && members.length > 1) {
      throw new TypeError("The frame layout holds one member.");
    }
    const data = members.map((member) => new Uint8Array(member.data));
    const parts = data.map((bytes, index) => {
      const member = members[index]!;
      return { file: readParquet(bytes), label: member.parts.join("; ") || member.sentence };
    });
    // Stacking the columns checks the members stack before any value is decoded. A pair of
    // column types that does not widen raises ContractError.
    stackedColumns(parts);
    const table = { parts: Object.freeze(parts), order: await presentedOrder(parts) };
    // The dataset holds the bytes itself, once.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the bytes are left out on purpose
    const inputs = members.map(({ data: _, ...member }) => member);
    const fetchedAt = options.fetchedAt ?? new Date();
    return new Dataset(inputs, { ...options, fetchedAt }, data, table);
  }

  private constructor(
    members: readonly MemberInput[],
    options: DatasetOptions,
    data: readonly Uint8Array[],
    table: Table,
  ) {
    this.#inputs = { members, options };
    const built = members.map((member): Member | DerivedMember => {
      const citation = citationOf(member.manifest);
      const parts = Object.freeze([...member.parts]);
      if (isDerived(member)) {
        return { ...derivedRefMember(member), parts, citation };
      }
      return {
        parts,
        spec: member.spec,
        contentVersion: member.contentVersion,
        sentence: member.sentence,
        citation,
        digest: member.digest,
        rendering: member.rendering,
      };
    });
    const manifests = members.map((member) => member.manifest);
    const facts = members.flatMap((member) =>
      isDerived(member) ? [] : (member.answerFacts ?? []),
    );
    const retention = options.retention ?? retentionOf(manifests);
    this.sentence = built.map((member) => member.sentence).join(" ");
    this.members = Object.freeze(built);
    this.citation = mergeCitations(built.map((member) => member.citation));
    this.warnings = Object.freeze(warningsOf(manifests));
    this.departures = Object.freeze(unique(facts.flatMap((part) => part.departures)));
    this.requestedOperations = Object.freeze(unique(facts.flatMap((part) => part.operations)));
    // Each assumption keeps the four members both clients save, so equal ones count once.
    this.assumptions = Object.freeze(unique(facts.flatMap((part) => part.assumptions ?? [])));
    this.missing = Object.freeze([...(options.missing ?? [])]);
    this.complete = this.missing.length === 0;
    this.heldUntil = retention.heldUntil;
    this.pinned = retention.pinned;
    this.layout = options.layout;
    this.question = options.question ?? null;
    // Seconds precision, as the saved file's `dfo.fetched_at` holds it.
    this.fetchedAt = new Date(
      Math.floor((options.fetchedAt ?? new Date()).getTime() / 1000) * 1000,
    );
    this.#data = data;
    this.#table = table;
    const derived = options.derived;
    const roles = derived?.roles ?? {};
    this.leftOut = Object.freeze(
      (derived?.leftOut ?? []).map((series) => new LeftOutSeries(series, roles)),
    );
    this.#leftOutComplete = derived?.leftOutComplete ?? true;
    this.partyTotalsLeftOut = Object.freeze(
      members.flatMap((member) =>
        isDerived(member)
          ? rootPartyTotalsOf(member)
          : partyTotalsOf(member.manifest, member.spec.spec_id),
      ),
    );
    this.#steps = Object.freeze(
      (derived?.steps ?? []).map((step) =>
        Object.freeze({ ...step, by: step.by.map((column) => roles[column] ?? column) }),
      ),
    );
    this.layoutVersion = [
      ...new Set(members.map((member) => artifactLayout(member, options.layout))),
    ].join("; ");
  }

  /** The exact versions the dataset holds, to fetch them again with `client.fetch(ref)`. */
  get ref(): DatasetRef {
    return refOf(this.members);
  }

  /** Where the data came from, as one record: `toObject()` gives it as JSON values to store
   *  beside the data, and `Provenance.fromObject` reads them back. */
  get provenance(): Provenance {
    return provenanceOf({
      sentence: this.sentence,
      citation: this.citation,
      fetchedAt: this.fetchedAt,
      question: this.question,
      pinned: this.pinned,
      heldUntil: this.heldUntil,
      warnings: this.warnings,
      members: this.members,
    });
  }

  /** The licences the sources publish under, joined by "; ", or empty when none says. */
  get licence(): string {
    return [...new Set(this.citation.sources.flatMap((source) => source.licence ?? []))].join("; ");
  }

  /** The number of rows in the table, which `toRows()` returns. */
  get rowCount(): number {
    return this.#table.order.rows.length;
  }

  /** The table's column names in reading order, `part` first when several members stack. */
  get columns(): readonly string[] {
    return this.#table.order.columns;
  }

  /**
   * The dataset as one Parquet file whose key-value metadata carries the provenance and the ref
   * under `dfo.*` keys, as Python's `Dataset.save` writes it, so `dfo.load` reads it back.
   * Several members stack into the file, `part` first. `member_rows` in `dfo.dataset` holds each
   * member's row count in member order, which marks where one member's rows end and the next
   * begin. `memberBytes` gives the file the server built. It decodes every member and encodes
   * the whole table in memory.
   */
  async toBytes(): Promise<Uint8Array> {
    return encodeStacked(this.#table, this.#metadata());
  }

  /**
   * Writes the file `toBytes()` returns to `path`, replacing any file there.
   *
   * @throws {InvalidRequestError} The runtime has no file system, as in a browser, where
   *   `toBytes()` gives the file to keep (`invalid_argument`).
   */
  async save(path: string | URL): Promise<void> {
    const write = platformFileWriter();
    if (write === undefined) {
      throw clientError("invalid_argument", {
        detail:
          "data.save(path) writes files on Node alone; here, await data.toBytes() gives the file.",
      });
    }
    await write(path, await this.toBytes());
  }

  /**
   * What the data shows, where it comes from, its versions and rows, and the line that keeps it:
   * the ref as JSON, whose specs `client.fetch(ref, { latest: true })` later builds anew. Each
   * line passes through `inline`, so the server's text keeps to its line.
   */
  toString(): string {
    const lines = [this.sentence];
    const sources = this.citation.sources.map((source) => source.label);
    if (sources.length > 0) lines.push(`Source: ${sources.join("; ")}`);
    lines.push(...this.#derivedSummary());
    const totals = partyTotalsLine(this.partyTotalsLeftOut, this.members.some(isDerived));
    if (totals !== undefined) lines.push(totals);
    if (this.#inputs.options.shownBy !== undefined) {
      lines.push(`Shown by: ${this.#inputs.options.shownBy}`);
    }
    const versions = this.members.map((member) => member.contentVersion);
    const label = versions.length === 1 ? "Version" : "Versions";
    lines.push(`${label}: ${versions.join(", ")} (exact)${retentionText(this)}`);
    lines.push(`Rows: ${this.rowCount.toLocaleString("en-GB")}${this.#periodType()}`);
    if (!this.complete) lines.push(`Incomplete: ${this.missing.length} part(s) left out`);
    lines.push(
      "Keep: JSON.stringify(data.ref) · newest later: client.fetch(data.ref, { latest: true })",
    );
    return `<Dataset ${lines.map(inline).join("\n  ")}>`;
  }

  /** Node's `console.log` and `util.inspect` show the dataset as `String(data)` does. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }

  /** The type `time_period` holds, as the Rows line names it. */
  #periodType(): string {
    const column = stackedColumns(this.#table.parts).find(({ name }) => name === "time_period");
    if (column === undefined) return "";
    if (column.type.kind === "int") return ", time_period as integer years";
    if (column.type.kind === "string")
      return ', time_period as text, such as "2022" or "2021/2022"';
    return `, time_period as ${column.type.kind}`;
  }

  /** The lines of a derived dataset: its steps, the period its latest years settled on, and
   *  the series it left out. Empty for dataset versions. */
  #derivedSummary(): string[] {
    const derived = this.members.filter((member): member is DerivedMember => isDerived(member));
    if (derived.length === 0) return [];
    const roots = unique(derived.flatMap((member) => member.roots));
    const readings = `${roots.length} reading${roots.length === 1 ? "" : "s"}`;
    const lines = [`Derived: ${stepsText(this.#steps, readings)}`];
    const period = periodLine(derived[0]!.resolvedPeriods);
    if (period !== undefined) lines.push(period);
    if (this.leftOut.length > 0) {
      const least = this.#leftOutComplete ? "" : "at least ";
      const count = this.leftOut.length.toLocaleString("en-GB");
      lines.push(`Missing data: ${least}${count} series left out · data.leftOut`);
    }
    return lines;
  }

  /**
   * One member's Parquet file as the server built it, checked against its digest.
   *
   * @throws {InvalidRequestError} The dataset has no member at `index` (`invalid_argument`).
   */
  memberBytes(index: number): Uint8Array {
    const data = this.#data[index];
    if (data === undefined) {
      throw clientError("invalid_argument", {
        detail: `This dataset has ${this.#data.length} member(s), not ${index + 1}.`,
      });
    }
    return data.slice();
  }

  /**
   * Every row as an object keyed by column name. `JSON.stringify` works on the result. It
   * decodes the whole table in memory, one object per row.
   *
   * @throws {InvalidRequestError} An INT64 value lies beyond a JavaScript number's exact range,
   *   which `toArrow()` keeps as a bigint (`invalid_argument`).
   */
  toRows(): Promise<Row[]> {
    return decodeRows(this.#table);
  }

  /** The provenance as the file's key-value metadata, in the shape Python's
   *  `Dataset.save` writes, so `dfo.load` reads the file back. The values
   *  `Provenance.toObject()` gives come from it, so the file and the record agree. */
  #metadata(): Record<string, string> {
    const record = this.provenance.toObject();
    const sources = this.citation.sources;
    const isDerivedDataset = this.members.some(isDerived);
    const derived = !isDerivedDataset
      ? {}
      : {
          "dfo.left_out": JSON.stringify({
            series: this.leftOut.map(({ coordinates, step, side, reason, rows }) => ({
              coordinates,
              step: { verb: step.verb, node: step.node },
              side,
              reason,
              rows,
            })),
            complete: this.#leftOutComplete,
          }),
          "dfo.steps": JSON.stringify(
            this.#steps.map(({ verb, by, limit }) => ({ verb, by, limit })),
          ),
        };
    return {
      "dfo.format_version": String(
        isDerivedDataset ? SAVED_DERIVED_FORMAT_VERSION : SAVED_FORMAT_VERSION,
      ),
      "dfo.sentence": record.sentence,
      "dfo.citation": JSON.stringify(record.citation),
      "dfo.sources": JSON.stringify(sources.map((source) => source.label)),
      "dfo.licence": this.licence,
      "dfo.dataset": JSON.stringify({
        member_citations: record.members.map((member) => member.citation),
        warnings: record.warnings,
        departures: this.departures.map(({ code, text, asked, shown, binding_ref }) => ({
          code,
          text,
          asked: asked ?? null,
          shown: shown ?? null,
          binding_ref: binding_ref ?? null,
        })),
        requested_operations: this.requestedOperations.map(
          ({ verb, phrase, over, target_year }) => ({
            verb,
            phrase,
            over: over ?? null,
            target_year: target_year ?? null,
          }),
        ),
        assumptions: this.assumptions,
        complete: this.complete,
        missing: this.missing.map(savedGap),
        held_until: record.held_until,
        pinned: record.pinned,
        stale: false,
        layout_version: this.layoutVersion,
        member_rows: memberRows(this.#table.parts),
      }),
      ...(record.ref === null ? {} : { "dfo.ref": JSON.stringify(record.ref) }),
      ...derived,
      // Keys of their own, since Python 0.1.0's loader refuses any key in `dfo.dataset` it does
      // not know and reads only the `dfo.*` keys it names.
      ...(record.question === null ? {} : { "dfo.question": JSON.stringify(record.question) }),
      ...(record.fetched_at === null
        ? {}
        : { "dfo.fetched_at": JSON.stringify(record.fetched_at) }),
      ...(this.partyTotalsLeftOut.length === 0
        ? {}
        : {
            "dfo.party_totals_left_out": JSON.stringify(
              this.partyTotalsLeftOut.map(
                ({ specId, role, entities, provenance, everyProvenance, keptIn }) => ({
                  spec_id: specId,
                  role,
                  entities,
                  ...(everyProvenance ? {} : { provenance }),
                  ...(keptIn.length === 0
                    ? {}
                    : {
                        kept_in: keptIn.map(({ series, timePeriods }) => ({
                          series,
                          time_periods: timePeriods,
                        })),
                      }),
                }),
              ),
            ),
          }),
    };
  }
}

/** The record `Provenance.toObject()` returns: plain JSON values, in the format
 *  `provenance.schema.json` gives, which Python's `Provenance.to_object` writes too. */
export type ProvenanceJson = {
  format_version: 1;
  sentence: string;
  citation: ReturnType<typeof savedCitation>;
  /** When the data left the server, in UTC to the second, as `2026-11-27T09:14:05Z`. */
  fetched_at: string | null;
  question: string | null;
  /** The ref `JSON.stringify(data.ref)` writes, or null for a dataset with no members. */
  ref: DatasetRefJson | null;
  pinned: boolean;
  /** As `YYYY-MM-DD`. */
  held_until: string | null;
  warnings: { code: string; severity: string; message: string; spec_id: string | null }[];
  members: {
    spec_id: string;
    content_version: string;
    digest: string;
    parts: string[];
    sentence: string;
    citation: ReturnType<typeof savedCitation>;
  }[];
};

/** Builds a `Provenance` from what it holds; its constructor is the class's own. */
let provenanceOf: (fields: ProvenanceFields) => Provenance;

/** What a `Provenance` holds. */
type ProvenanceFields = Pick<
  Provenance,
  | "sentence"
  | "citation"
  | "fetchedAt"
  | "question"
  | "pinned"
  | "heldUntil"
  | "warnings"
  | "members"
>;

/**
 * Where a dataset came from, as one record to store beside the data. `data.provenance.toObject()`
 * gives it as JSON values, and `Provenance.fromObject` reads them back, in this client or the
 * Python one. It holds what the file `data.toBytes()` writes holds of the same dataset.
 */
export class Provenance {
  /** What the data shows, as `Dataset.sentence`. */
  readonly sentence: string;
  /** How to cite the data, every member's sources together. */
  readonly citation: Citation;
  /** When the data left the server, to the second, or null when a member's fetch time is
   *  unknown, as in a record Python wrote for such a dataset. */
  readonly fetchedAt: Date | null;
  /** The question the data answers, when it came from `answer.fetch()`, else null. */
  readonly question: string | null;
  /** Whether every member's version is kept without a time limit. */
  readonly pinned: boolean;
  /** The earliest day any member's version can still be fetched without being pinned, or null
   *  when every member is pinned or the server did not say. */
  readonly heldUntil: Date | null;
  /** The datasets surface's warnings about the members' data. */
  readonly warnings: readonly Notice[];
  /** One member per built spec or derived frame, each an exact version with its digest, parts,
   *  sentence and citation. Empty for a dataset that names no version. */
  readonly members: readonly (Member | DerivedMember)[];

  static {
    provenanceOf = (fields) => new Provenance(fields);
  }

  private constructor(fields: ProvenanceFields) {
    this.sentence = fields.sentence;
    this.citation = fields.citation;
    this.fetchedAt = fields.fetchedAt;
    this.question = fields.question;
    this.pinned = fields.pinned;
    this.heldUntil = fields.heldUntil;
    this.warnings = Object.freeze([...fields.warnings]);
    this.members = Object.freeze([...fields.members]);
    Object.freeze(this);
  }

  /** The exact versions the members name, to fetch them again with `client.fetch(ref)`, or null
   *  when there are no members. */
  get ref(): DatasetRef | null {
    return this.members.length === 0 ? null : refOf(this.members);
  }

  /** The record as JSON values, which `Provenance.fromObject` reads back. */
  toObject(): ProvenanceJson {
    return {
      format_version: PROVENANCE_FORMAT_VERSION,
      sentence: this.sentence,
      citation: savedCitation(this.citation),
      fetched_at: this.fetchedAt === null ? null : isoTime(this.fetchedAt),
      question: this.question,
      ref: this.ref?.toJSON() ?? null,
      pinned: this.pinned,
      held_until: this.heldUntil?.toISOString().slice(0, 10) ?? null,
      warnings: this.warnings.map(({ code, severity, message, spec_id }) => ({
        code,
        severity,
        message,
        spec_id: spec_id ?? null,
      })),
      members: this.members.map((member) => ({
        spec_id: member.spec.spec_id,
        content_version: member.contentVersion,
        digest: member.digest,
        parts: [...member.parts],
        sentence: member.sentence,
        citation: savedCitation(member.citation),
      })),
    };
  }

  /** `JSON.stringify(provenance)` writes the object `toObject()` returns. */
  toJSON(): ProvenanceJson {
    return this.toObject();
  }

  /**
   * Reads a record `toObject()` wrote, in this client or another, from its parsed JSON value.
   *
   * @throws {FormatError} The value breaks the provenance format, a member differs from the
   *   member its ref names, or the ref breaks its own format, as `DatasetRef.fromJSON` throws,
   *   with a pointer under `/ref`.
   */
  static fromObject(value: unknown): Provenance {
    if (typeof value === "string") {
      throw invalid("", "JSON text, not a parsed object; pass JSON.parse(text)");
    }
    const record = objectAt(value, "");
    checkKeys(record, "", PROVENANCE_KEYS);
    if (record["format_version"] !== PROVENANCE_FORMAT_VERSION) {
      throw invalid("/format_version", `not ${PROVENANCE_FORMAT_VERSION}; a later client reads it`);
    }
    const stored = record["ref"] === null ? [] : loadRef(record["ref"], "/ref").members;
    const entries = arrayAt(record["members"], "/members");
    if (entries.length !== stored.length) {
      throw invalid(
        "/members",
        `holds ${entries.length} members for the ${stored.length} members ref names`,
      );
    }
    const pinned = record["pinned"];
    if (typeof pinned !== "boolean") throw invalid("/pinned", "not a boolean");
    const question = record["question"];
    return provenanceOf({
      sentence: stringAt(record["sentence"], "/sentence"),
      citation: loadCitation(record["citation"], "/citation"),
      fetchedAt: record["fetched_at"] === null ? null : loadTime(record["fetched_at"]),
      question: question === null ? null : stringAt(question, "/question"),
      pinned,
      heldUntil: record["held_until"] === null ? null : loadDay(record["held_until"]),
      warnings: arrayAt(record["warnings"], "/warnings").map((item, index) =>
        loadWarning(item, `/warnings/${index}`),
      ),
      members: entries.map((entry, index) =>
        provenanceMember(entry, stored[index]!, `/members/${index}`),
      ),
    });
  }

  /** The sentence, the number of members and the fetch time, as `Provenance(…, 2 members,
   *  fetched 13 November 2026 09:14 UTC)`, on one line through `inline`. */
  toString(): string {
    const count = this.members.length;
    const fetched =
      this.fetchedAt === null ? "fetch time unknown" : `fetched ${timeText(this.fetchedAt)}`;
    return inline(
      `Provenance(${this.sentence}, ${count} member${count === 1 ? "" : "s"}, ${fetched})`,
    );
  }

  /** Node's `console.log` and `util.inspect` show the record as `String(provenance)` does. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}

/** The keys of a provenance record, and of one member in it. */
const PROVENANCE_KEYS = [
  "format_version",
  "sentence",
  "citation",
  "fetched_at",
  "question",
  "ref",
  "pinned",
  "held_until",
  "warnings",
  "members",
] as const;
const PROVENANCE_MEMBER_KEYS = [
  "spec_id",
  "content_version",
  "digest",
  "parts",
  "sentence",
  "citation",
] as const;

/** The forms a provenance record writes a time and a day in, as its schema gives them. */
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A UTC time as the record writes it, to the second, such as `2026-11-27T09:14:05Z`. */
const isoTime = (date: Date): string => `${date.toISOString().slice(0, 19)}Z`;

/** A UTC time as `toString` prints it, such as `27 November 2026 09:14 UTC`. */
const timeText = (date: Date): string => `${dayText(date)} ${date.toISOString().slice(11, 16)} UTC`;

/** Whether the year, month and day a pattern matched name a day on the calendar. */
function dayExists(match: RegExpExecArray): boolean {
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function loadTime(value: unknown): Date {
  const match = ISO_TIME.exec(stringAt(value, "/fetched_at"));
  const date = match === null ? null : new Date(match[0]);
  if (match === null || !dayExists(match) || Number.isNaN(date!.getTime())) {
    throw invalid("/fetched_at", "not an ISO 8601 time with a zone on a day that exists");
  }
  return date!;
}

function loadDay(value: unknown): Date {
  const match = ISO_DAY.exec(stringAt(value, "/held_until"));
  if (match === null || !dayExists(match)) {
    throw invalid("/held_until", "not an ISO date on a day that exists");
  }
  return new Date(`${match[0]}T00:00:00Z`);
}

function stringAt(value: unknown, pointer: string): string {
  if (typeof value !== "string") throw invalid(pointer, "not a string");
  return value;
}

function nullableStringAt(value: unknown, pointer: string): string | null {
  return value === null ? null : stringAt(value, pointer);
}

function arrayAt(value: unknown, pointer: string): unknown[] {
  if (!Array.isArray(value)) throw invalid(pointer, "not an array");
  return value;
}

function loadCitation(value: unknown, pointer: string): Citation {
  const citation = objectAt(value, pointer);
  checkKeys(citation, pointer, ["text", "sources"]);
  return {
    text: stringAt(citation["text"], `${pointer}/text`),
    sources: arrayAt(citation["sources"], `${pointer}/sources`).map((item, index) => {
      const at = `${pointer}/sources/${index}`;
      const source = objectAt(item, at);
      checkKeys(source, at, ["ref", "label"], ["licence", "licence_url", "url"]);
      return Object.freeze({
        ref: stringAt(source["ref"], `${at}/ref`),
        label: stringAt(source["label"], `${at}/label`),
        licence: nullableStringAt(source["licence"] ?? null, `${at}/licence`),
        licenceUrl: nullableStringAt(source["licence_url"] ?? null, `${at}/licence_url`),
        url: nullableStringAt(source["url"] ?? null, `${at}/url`),
      });
    }),
  };
}

function loadWarning(value: unknown, pointer: string): Notice {
  const warning = objectAt(value, pointer);
  checkKeys(warning, pointer, ["code", "severity", "message", "spec_id"]);
  return {
    code: stringAt(warning["code"], `${pointer}/code`),
    severity: stringAt(warning["severity"], `${pointer}/severity`),
    message: stringAt(warning["message"], `${pointer}/message`),
    spec_id: nullableStringAt(warning["spec_id"], `${pointer}/spec_id`),
  };
}

/** A provenance member, which names the ref member at its position, with its citation. */
function provenanceMember(
  value: unknown,
  stored: RefMember | DerivedRefMember,
  pointer: string,
): Member | DerivedMember {
  const entry = objectAt(value, pointer);
  checkKeys(entry, pointer, PROVENANCE_MEMBER_KEYS);
  const named: Record<string, unknown> = {
    spec_id: stored.spec.spec_id,
    content_version: stored.contentVersion,
    digest: stored.digest,
    parts: stored.parts,
    sentence: stored.sentence,
  };
  for (const [key, expected] of Object.entries(named)) {
    if (JSON.stringify(entry[key]) !== JSON.stringify(expected)) {
      throw invalid(
        `${pointer}/${key}`,
        `is not the ${key} of the ref's member at the same position`,
      );
    }
  }
  return { ...stored, citation: loadCitation(entry["citation"], `${pointer}/citation`) };
}

/** The ref to a dataset's members. */
function refOf(members: readonly (Member | DerivedMember)[]): DatasetRef {
  return new DatasetRef(
    members.map((member) =>
      isDerived(member)
        ? derivedRefMember(member)
        : {
            parts: member.parts,
            sentence: member.sentence,
            spec: member.spec,
            contentVersion: member.contentVersion,
            digest: member.digest,
            rendering: member.rendering,
          },
    ),
  );
}

/** A derived member as a ref stores it, without what the dataset adds. */
const derivedRefMember = (member: DerivedRefMember): DerivedRefMember => ({
  parts: member.parts,
  sentence: member.sentence,
  spec: member.spec,
  contentVersion: member.contentVersion,
  outputDigest: member.outputDigest,
  roots: member.roots,
  executionIdentity: member.executionIdentity,
  resolvedPeriods: member.resolvedPeriods,
  digest: member.digest,
  rendering: member.rendering,
});

/** How long the server keeps a dataset's versions, as `toString` shows it after the versions. */
function retentionText({ pinned, heldUntil }: Pick<Dataset, "pinned" | "heldUntil">): string {
  if (pinned) return ", pinned";
  if (heldUntil === null) return "";
  return `, held until ${dayText(heldUntil)}, not pinned`;
}

/** A date's UTC day as a dataset's text form prints it, such as `27 November 2026`. */
export const dayText = (date: Date): string =>
  date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

/** A dataset's table, for the `arrow` entry point. */
export function datasetTable(dataset: Dataset): Table {
  return readTable(dataset);
}

/** The layout a member's manifest names for its artifact, else the fetch's layout. */
function artifactLayout(
  member: Pick<FetchedMember, "manifest" | "digest">,
  layout: Layout,
): string {
  const artifact = objects(member.manifest["artifacts"]).find(
    (entry) => entry["artifact_digest"] === member.digest,
  );
  const rendering = artifact?.["rendering"];
  const named = isRecord(rendering) ? rendering["layout"] : undefined;
  return typeof named === "string" || typeof named === "number" ? String(named) : layout;
}

/** A citation as Python's `Dataset.save` writes it, its sources' licence spelled `licence`. */
const savedCitation = ({ text, sources }: Citation) => ({
  text,
  sources: sources.map((source) => ({
    ref: source.ref,
    label: source.label,
    licence: source.licence,
    licence_url: source.licenceUrl,
    url: source.url,
  })),
});

/** A gap as Python's `Dataset.save` writes it, where a choice of place or source keeps its options. */
const savedGap = (gap: Gap) => ({
  part_index: gap.partIndex,
  part: gap.part,
  kind: gap.kind,
  message: gap.message,
  options: gap.options.flatMap((option) =>
    option.kind === "query"
      ? [{ label: option.label, mentions: option.mentions, data_query: option.dataQuery }]
      : [],
  ),
});
