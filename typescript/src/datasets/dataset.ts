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
import { DatasetRef, invalid, isDerived, loadRef, objectAt } from "../core/ref.ts";
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
import { canonicalJson, isRecord, list, objects, parseJson, text } from "../core/json.ts";
import { inline } from "../core/text.ts";
import { clientError } from "../core/errors.ts";
import { partyTotalsLine, partyTotalsOf, rootPartyTotalsOf } from "./party-totals.ts";
import type { PartyTotalsLeftOut } from "./party-totals.ts";
import { platformFileWriter } from "./save.ts";
import {
  arrayAt,
  checkComplete,
  checkRetention,
  datasetRetention,
  loadCitation,
  loadDay,
  loadGap,
  loadRetention,
  loadTime,
  loadWarning,
  readSaved,
  requireKeys,
  SAVED_DERIVED_FORMAT_VERSION,
  SAVED_FORMAT_VERSION,
  SAVED_PER_FORMAT_VERSION,
  stringAt,
} from "./saved.ts";

export type { KeptSeries, PartyTotalsLeftOut } from "./party-totals.ts";

/** The format of the record `Provenance.toJSON()` returns. */
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

/** One reading inside a dataset: the exact version built for it, with its retention. */
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
  /** Whether DFO keeps the version without a time limit, or null when the client does not know,
   *  as for a file saved by a client before 0.3.0. */
  readonly pinned: boolean | null;
  /** The time the version can still be fetched without being pinned, as the server gives it, or
   *  null when it is pinned, the server did not say, or the client does not know. A saved file
   *  and a provenance record keep the day, which reads back as midnight UTC. */
  readonly heldUntil: Date | null;
};

/** How long DFO keeps a member's version: whether it is pinned, and when it stops being
 *  guaranteed. */
type Retention = Pick<Member, "pinned" | "heldUntil">;

/** One derived frame inside a dataset: the frame an analysis recipe computed, with its
 *  citation and retention. */
export type DerivedMember = DerivedRefMember &
  Pick<Member, "pinned" | "heldUntil"> & { readonly citation: Citation };

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
 *  roles it keeps apart, for a ranking the columns or roles that split it (`per`, empty for
 *  none), and the most members it keeps. */
export type DerivedStep = {
  readonly verb: string;
  readonly by: readonly string[];
  readonly limit: number | null;
  readonly per: readonly string[];
};

/** A step as `rank by origin per destination, limit 10`. */
const stepText = ({ verb, by, limit, per }: DerivedStep): string =>
  verb +
  (by.length > 0 ? ` by ${by.join(", ")}` : "") +
  (per.length > 0 ? ` per ${per.join(", ")}` : "") +
  (limit === null ? "" : `, limit ${limit}`);

/** Steps in the order they run and what they start from, as
 *  `growth by origin, then rank by origin, limit 10, from 1 reading`. */
export function stepsText(steps: readonly DerivedStep[], source: string): string {
  const done = steps.map(stepText).join(", then ");
  return done === "" ? `from ${source}` : `${done}, from ${source}`;
}

/** A reading a recipe read summed over its StatVars, with how many StatVars with rows DFO
 *  summed into its one series. */
export type SummedReading = {
  /** The reading's spec, `spec_…`. */
  readonly specId: string;
  /** The version of the reading DFO summed. */
  readonly contentVersion: string;
  /** How many StatVars with rows the sum added together, more than one. */
  readonly count: number;
};

/** How many StatVars DFO summed each reading over, as `Summed: 1,598 StatVars`, or
 *  `Summed: 1,598 and 40 StatVars in 2 readings`; undefined when it summed none. */
function summedLine(summed: readonly SummedReading[]): string | undefined {
  const counts = summed.map(({ count }) => count.toLocaleString("en-GB"));
  const last = counts.at(-1);
  if (last === undefined) return undefined;
  if (counts.length === 1) return `Summed: ${last} StatVars`;
  return `Summed: ${counts.slice(0, -1).join(", ")} and ${last} StatVars in ${counts.length} readings`;
}

/** What a derived dataset adds to its member: every series its recipe left out, whether that
 *  list is whole, its steps in the order they ran, the role word the call named each column
 *  by, and the readings DFO summed over their StatVars. */
export type DerivedFacts = {
  readonly leftOut: readonly LeftOutFields[];
  readonly leftOutComplete: boolean;
  readonly steps: readonly DerivedStep[];
  readonly roles?: Readonly<Record<string, string>>;
  readonly statVarsSummed?: readonly SummedReading[];
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

/** The forms `heldUntilOf` reads: a date, `2026-11-18`, or a date-time with seconds, an optional
 *  fraction and an optional `Z` or `±HH:MM` offset, `2026-11-18T23:30:00.5-05:00`. */
const HELD_UNTIL =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))?)?$/;

/**
 * A retention's `held_until` as the UTC midnight of the date it names, or null when it is no
 * string, is in another form, or names a date or time that does not exist, as `2026-02-30` or
 * `T25:00:00`. It reads `2026-11-18` and `2026-11-18T23:30:00Z`, with an optional fraction of a
 * second and `Z` or `±HH:MM` for the offset or none, the forms the server writes. The date is the
 * one the text writes, in its own offset. Python's `read_held_until` reads the same forms with
 * the same pattern, and its year 1 is the first either reads.
 */
export function heldUntilOf(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const found = HELD_UNTIL.exec(value);
  if (found === null) return null;
  // An absent time or offset reads as 0, which is in range.
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = found
    .slice(1)
    .map((part: string | undefined) => Number(part ?? 0)) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  // `Date.UTC` reads a year below 100 as 1900 plus it, so the year is set on its own.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  const exists =
    year > 0 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  const inRange = hour < 24 && minute < 60 && second < 60 && offsetHour < 24 && offsetMinute < 60;
  return exists && inRange ? date : null;
}

/** A version's retention as its manifest serves it: pinned with no day, or not pinned and held
 *  until the day the server gives, null when it gives none. A manifest without `retention`
 *  leaves both unknown, and a `pinned` that is not a boolean leaves it unknown. */
function servedRetention(manifest: Readonly<Record<string, unknown>>): Retention {
  const retention = manifest["retention"];
  if (!isRecord(retention)) return { pinned: null, heldUntil: null };
  const pinned = retention["pinned"];
  if (pinned === true) return { pinned: true, heldUntil: null };
  return {
    pinned: typeof pinned === "boolean" ? pinned : null,
    heldUntil: heldUntilOf(retention["held_until"]),
  };
}

/**
 * How new the versions a `latest: "stored"` fetch read are, from best to worst, as DFO's
 * `x-dfo-freshness` header states it for each member:
 *
 * - `current`: DFO confirmed the version is the newest within its recheck window.
 * - `pending`: the window has passed and DFO is checking for newer data, so the version is the
 *   one its last check found.
 * - `stale`: the window has passed and DFO is not checking, as after a check failed, so the
 *   version may be older than the newest data.
 */
export const FRESHNESS = ["current", "pending", "stale"] as const;

/** How new the versions a `latest: "stored"` fetch read are; `FRESHNESS` lists the values. */
export type Freshness = (typeof FRESHNESS)[number];

/** How `Dataset.create` assembles its members: the layout, the parts a partial fetch left out,
 *  and for a derived dataset what its manifest adds. */
type DatasetOptions = {
  readonly layout: Layout;
  readonly missing?: readonly Gap[];
  readonly derived?: DerivedFacts;
  /** The question the dataset answers, when it came from an answer. */
  readonly question?: string | null;
  /** When the data left the server. Now by default. */
  readonly fetchedAt?: Date;
  /** How new a `latest: "stored"` fetch's versions are. Null by default. */
  readonly freshness?: Freshness | null;
};

/** A member a dataset is made from, without its bytes, which the dataset holds itself. */
type MemberInput = Omit<FetchedMember, "data"> | Omit<FetchedDerivedMember, "data">;

/**
 * What a dataset holds beside its rows, as a fetch reads it from the members' manifests or a
 * saved file from its `dfo.*` keys. A copy of a dataset, as after a pin, changes it and keeps
 * the rows.
 */
export type DatasetState = {
  readonly sentence: string;
  readonly members: readonly (Member | DerivedMember)[];
  readonly citation: Citation;
  readonly warnings: readonly Notice[];
  readonly departures: readonly Departure[];
  readonly requestedOperations: readonly RequestedOperation[];
  readonly assumptions: readonly Assumption[];
  readonly complete: boolean;
  readonly missing: readonly Gap[];
  readonly layout: Layout;
  readonly layoutVersion: string;
  readonly question: string | null;
  readonly fetchedAt: Date | null;
  readonly leftOut: readonly LeftOutFields[];
  readonly leftOutComplete: boolean;
  /** The recipe's steps in the order they ran, each column named as `roles` names it. */
  readonly steps: readonly DerivedStep[];
  /** The role word the call named each column by, for the text forms alone. */
  readonly roles: Readonly<Record<string, string>>;
  readonly partyTotalsLeftOut: readonly PartyTotalsLeftOut[];
  /** The share slot a share fetch read, as the text form's "Shown by" line names it:
   *  `share k3Qx8vTa, slot 2 "Malaria grants", on 3 October 2026`. */
  readonly shownBy?: string;
  /** How new a `latest: "stored"` fetch's versions are. A saved file holds none. */
  readonly freshness?: Freshness | null;
  /** The readings DFO summed over their StatVars, from the analysis answer. A saved file holds
   *  none. */
  readonly statVarsSummed?: readonly SummedReading[];
};

/** What a dataset reads from its members' manifests and the fetch's options. */
function stateOf(members: readonly MemberInput[], options: DatasetOptions): DatasetState {
  const built = members.map((member): Member | DerivedMember => {
    const citation = citationOf(member.manifest);
    const parts = Object.freeze([...member.parts]);
    const retention = servedRetention(member.manifest);
    if (isDerived(member)) {
      return { ...derivedRefMember(member), parts, citation, ...retention };
    }
    return {
      parts,
      spec: member.spec,
      contentVersion: member.contentVersion,
      sentence: member.sentence,
      citation,
      digest: member.digest,
      rendering: member.rendering,
      ...retention,
    };
  });
  const manifests = members.map((member) => member.manifest);
  const facts = members.flatMap((member) => (isDerived(member) ? [] : (member.answerFacts ?? [])));
  const missing = Object.freeze([...(options.missing ?? [])]);
  const derived = options.derived;
  const roles = derived?.roles ?? {};
  return {
    sentence: built.map((member) => member.sentence).join(" "),
    members: Object.freeze(built),
    citation: mergeCitations(built.map((member) => member.citation)),
    warnings: Object.freeze(warningsOf(manifests)),
    departures: Object.freeze(unique(facts.flatMap((part) => part.departures))),
    requestedOperations: Object.freeze(unique(facts.flatMap((part) => part.operations))),
    // Each assumption keeps the four members both clients save, so equal ones count once.
    assumptions: Object.freeze(unique(facts.flatMap((part) => part.assumptions ?? []))),
    complete: missing.length === 0,
    missing,
    layout: options.layout,
    layoutVersion: [
      ...new Set(members.map((member) => artifactLayout(member, options.layout))),
    ].join("; "),
    question: options.question ?? null,
    fetchedAt: options.fetchedAt ?? new Date(),
    freshness: options.freshness ?? null,
    leftOut: derived?.leftOut ?? [],
    leftOutComplete: derived?.leftOutComplete ?? true,
    steps: (derived?.steps ?? []).map((step) => ({
      ...step,
      by: step.by.map((column) => roles[column] ?? column),
      per: step.per.map((column) => roles[column] ?? column),
    })),
    roles,
    statVarsSummed: derived?.statVarsSummed ?? [],
    partyTotalsLeftOut: members.flatMap((member) =>
      isDerived(member)
        ? rootPartyTotalsOf(member)
        : partyTotalsOf(member.manifest, member.spec.spec_id),
    ),
  };
}

/** Copies a dataset as pinned; Dataset's static block assigns it. */
let pinnedCopy: (dataset: Dataset) => Dataset;

/** `dataset` with every member's version kept without a time limit, as a pin leaves it. */
export const pinnedDataset = (dataset: Dataset): Dataset => pinnedCopy(dataset);

/** Reads a saved file's bytes as a dataset; Dataset's static block assigns it. */
let savedDataset: (bytes: unknown, path?: string) => Promise<Dataset>;

/** The dataset in the saved file `load(path)` read from `path`, as `Dataset.fromBytes` reads its
 *  bytes, with a refusal of bytes that are no Parquet file naming `path`. */
export const datasetAt = (bytes: Uint8Array, path: string): Promise<Dataset> =>
  savedDataset(bytes, path);

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
  /** The earliest time any member's version not pinned can still be fetched, from the members'
   *  `heldUntil`, or null when every member is pinned or none of the others' times is known. */
  readonly heldUntil: Date | null;
  /** Whether every member's version is kept without a time limit; false with no members. */
  readonly pinned: boolean;
  readonly layout: Layout;
  /** The artifact layout each member's manifest names, distinct ones joined by "; ". */
  readonly layoutVersion: string;
  /** The question the dataset answers, when it came from `answer.fetch()`, else null. */
  readonly question: string | null;
  /** When the data left the server, to the second, or null when a saved file does not say, as
   *  one Python wrote for a dataset read from a website bundle does not. */
  readonly fetchedAt: Date | null;
  /** How new the versions are, for a dataset `client.fetch(ref, { latest: "stored" })` read:
   *  the worst of its members' freshness, `stale` before `pending` before `current`. Null for
   *  every other dataset, for one read from a server that does not state freshness, and for one
   *  read from a saved file, since freshness holds at the moment of the read. `dataset.ref`
   *  leaves it out. */
  readonly freshness: Freshness | null;
  /** Each member's file as the server built it, in member order, or null for a dataset read
   *  from a saved file, which holds one table for every member. */
  readonly #data: readonly Uint8Array[] | null;
  /** Each member's file, one per member in member order, labelled as its `part` column holds
   *  it when several stack, in reading order; or a saved file's one table, as the file holds
   *  it. */
  readonly #table: Table;
  /** Each member's row count in member order, which splits the table's rows by member. */
  readonly #memberRows: readonly number[];
  /** Every series a step of the recipe behind a derived dataset dropped for missing data, at
   *  any step, each naming its step. Empty for a dataset of dataset versions. DFO lists at most
   *  2,000; `String(data)` says "at least" when it dropped more. */
  readonly leftOut: readonly LeftOutSeries[];
  /** The group totals a fetch left out of each member's rows, one entry per member, party role,
   *  provenance and set of kept series and periods, in member order and then the manifest's
   *  order. Empty when nothing was left out and when the fetch passed `partyTotals: true`. A
   *  derived dataset's entries name the readings its recipe ran on and what each reading left
   *  out, in root order. Its list is also empty against a server older than this report and when
   *  the server could not read a reading, so an empty list there leaves open whether every total
   *  stayed. */
  readonly partyTotalsLeftOut: readonly PartyTotalsLeftOut[];
  /** Each reading the recipe behind a derived dataset read summed over its StatVars, as DFO
   *  answered the analysis: the reading's spec and version and how many StatVars with rows it
   *  summed into one series. DFO sums a reading of several StatVars by itself when no step names
   *  `stat_var`. Empty for a dataset of dataset versions, for a recipe that summed nothing, for
   *  a derived ref read at its exact version, which posts no analysis, and for a saved file. */
  readonly statVarsSummed: readonly SummedReading[];
  /** What the dataset holds beside its rows, for a copy. */
  readonly #state: DatasetState;

  static {
    readTable = (dataset) => dataset.#table;
    savedDataset = async (bytes, path) => {
      const { state, table, memberRows } = await readSaved(bytes, path);
      return new Dataset(state, table, memberRows, null);
    };
    pinnedCopy = (dataset) =>
      new Dataset(
        {
          ...dataset.#state,
          members: dataset.#state.members.map((member) => ({
            ...member,
            pinned: true,
            heldUntil: null,
          })),
        },
        dataset.#table,
        dataset.#memberRows,
        dataset.#data,
      );
    shownCopy = (dataset, shownBy) =>
      new Dataset(
        { ...dataset.#state, shownBy },
        dataset.#table,
        dataset.#memberRows,
        dataset.#data,
      );
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
    return new Dataset(stateOf(inputs, options), table, memberRows(parts), data);
  }

  /**
   * Reads the file `toBytes()` or `save()` writes, or Python's `data.save` or `data.to_bytes()`,
   * with its rows, provenance and ref. It works in any runtime. A file of several members holds
   * them in one table, `part` first, so the loaded dataset's `memberBytes` throws; its other
   * conversions work as on the dataset that wrote it, and `toBytes()` writes the file again.
   *
   * @throws {BundleError} The bytes are no Parquet file, a damaged one, or one without a saved
   *   dataset's `dfo.*` keys (`not_a_bundle`).
   * @throws {FormatError} A `dfo.*` key is missing or breaks the saved format, or the file comes
   *   from a later format version (`format_invalid`, or as `DatasetRef.fromJSON` throws for its
   *   `dfo.ref`). The pointer starts with the key, as in `/dfo.dataset/missing`.
   * @throws {InvalidRequestError} `bytes` is neither a Uint8Array nor an ArrayBuffer
   *   (`invalid_argument`).
   */
  static async fromBytes(bytes: Uint8Array | ArrayBuffer): Promise<Dataset> {
    return savedDataset(bytes);
  }

  private constructor(
    state: DatasetState,
    table: Table,
    memberRows: readonly number[],
    data: readonly Uint8Array[] | null,
  ) {
    this.#state = state;
    this.#table = table;
    this.#memberRows = Object.freeze([...memberRows]);
    this.#data = data;
    this.sentence = state.sentence;
    this.members = Object.freeze([...state.members]);
    this.citation = state.citation;
    this.warnings = Object.freeze([...state.warnings]);
    this.departures = Object.freeze([...state.departures]);
    this.requestedOperations = Object.freeze([...state.requestedOperations]);
    this.assumptions = Object.freeze([...state.assumptions]);
    this.missing = Object.freeze([...state.missing]);
    this.complete = state.complete;
    ({ heldUntil: this.heldUntil, pinned: this.pinned } = datasetRetention(this.members));
    this.layout = state.layout;
    this.layoutVersion = state.layoutVersion;
    this.question = state.question;
    this.freshness = state.freshness ?? null;
    // Seconds precision, as the saved file's `dfo.fetched_at` holds it.
    this.fetchedAt =
      state.fetchedAt === null
        ? null
        : new Date(Math.floor(state.fetchedAt.getTime() / 1000) * 1000);
    this.leftOut = Object.freeze(
      state.leftOut.map((series) => new LeftOutSeries(series, state.roles)),
    );
    this.partyTotalsLeftOut = Object.freeze([...state.partyTotalsLeftOut]);
    this.statVarsSummed = Object.freeze(
      (state.statVarsSummed ?? []).map((summed) => Object.freeze({ ...summed })),
    );
  }

  /**
   * The exact versions the dataset holds, to fetch them again with `client.fetch(ref)`.
   *
   * @throws {InvalidRequestError} The dataset names no version, as a file Python saved from a
   *   website bundle's folder does not (`ref_unavailable`).
   */
  get ref(): DatasetRef {
    if (this.members.length === 0) {
      throw clientError("ref_unavailable", {
        detail:
          "This dataset names no version, as a website bundle opened from a folder does not, so " +
          "it has no ref.",
      });
    }
    return refOf(this.members);
  }

  /** Where the data came from, as one record: `JSON.stringify(data.provenance)` writes it as
   *  JSON to store beside the data, and `Provenance.fromJSON` reads it back. */
  get provenance(): Provenance {
    return provenanceOf({
      sentence: this.sentence,
      citation: this.citation,
      fetchedAt: this.fetchedAt,
      question: this.question,
      warnings: this.warnings,
      members: this.members,
      complete: this.complete,
      missing: this.missing,
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
    if (this.#state.shownBy !== undefined) {
      lines.push(`Shown by: ${this.#state.shownBy}`);
    }
    const versions = this.members.map((member) => member.contentVersion);
    const retention = retentionText(this);
    if (versions.length > 0) {
      const label = versions.length === 1 ? "Version" : "Versions";
      lines.push(`${label}: ${versions.join(", ")} (exact)${retention}`);
    } else if (retention !== "") {
      // Without versions, the retention stands alone, as `Held until 27 November 2026, not pinned`.
      const alone = retention.slice(2);
      lines.push(alone.charAt(0).toUpperCase() + alone.slice(1));
    }
    lines.push(`Rows: ${this.rowCount.toLocaleString("en-GB")}${this.#periodType()}`);
    if (!this.complete) lines.push(`Incomplete: ${this.missing.length} part(s) left out`);
    lines.push(
      versions.length > 0
        ? "Keep: JSON.stringify(data.ref) · newest later: client.fetch(data.ref, { latest: true })"
        : "Keep: await data.toBytes()",
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

  /** The lines of a derived dataset: its steps, the StatVars it summed, the period its latest
   *  years settled on, and the series it left out. Empty for dataset versions. */
  #derivedSummary(): string[] {
    const derived = this.members.filter((member): member is DerivedMember => isDerived(member));
    if (derived.length === 0) return [];
    const roots = unique(derived.flatMap((member) => member.roots));
    const readings = `${roots.length} reading${roots.length === 1 ? "" : "s"}`;
    const lines = [`Derived: ${stepsText(this.#state.steps, readings)}`];
    const summed = summedLine(this.statVarsSummed);
    if (summed !== undefined) lines.push(summed);
    const period = periodLine(derived[0]!.resolvedPeriods);
    if (period !== undefined) lines.push(period);
    if (this.leftOut.length > 0) {
      const least = this.#state.leftOutComplete ? "" : "at least ";
      const count = this.leftOut.length.toLocaleString("en-GB");
      lines.push(`Missing data: ${least}${count} series left out · data.leftOut`);
    }
    return lines;
  }

  /**
   * One member's Parquet file as the server built it, checked against its digest.
   *
   * @throws {InvalidRequestError} The dataset has no member at `index`, or was read from a saved
   *   file, which holds no member's own file (`invalid_argument`).
   */
  memberBytes(index: number): Uint8Array {
    if (this.#data === null) {
      throw clientError("invalid_argument", {
        detail:
          "This dataset was read from a saved file, which holds every member's rows in one " +
          "table and none of the files the server built; client.fetch(data.ref) fetches them.",
      });
    }
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
   *  `Provenance.toJSON()` gives come from it, so the file and the record agree. */
  #metadata(): Record<string, string> {
    const record = this.provenance.toJSON();
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
            complete: this.#state.leftOutComplete,
          }),
          "dfo.steps": JSON.stringify(
            // Write `per` only where a step has one, since format 2 steps are the closed `{verb, by, limit}`.
            this.#state.steps.map(({ verb, by, limit, per }) =>
              per.length > 0 ? { verb, by, limit, per } : { verb, by, limit },
            ),
          ),
        };
    return {
      "dfo.format_version": String(
        !isDerivedDataset
          ? SAVED_FORMAT_VERSION
          : this.#state.steps.some(({ per }) => per.length > 0)
            ? SAVED_PER_FORMAT_VERSION
            : SAVED_DERIVED_FORMAT_VERSION,
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
        complete: record.complete,
        missing: record.missing,
        held_until: record.held_until,
        pinned: record.pinned,
        stale: false,
        layout_version: this.layoutVersion,
        member_rows: this.#memberRows,
      }),
      ...(record.ref === null
        ? {}
        : {
            "dfo.ref": JSON.stringify(record.ref),
            "dfo.retention": JSON.stringify(
              record.members.map(({ pinned, held_until }) => ({ pinned, held_until })),
            ),
          }),
      ...derived,
      // Keys of their own, as `dfo.retention` above, since Python 0.1.0's loader refuses any key
      // in `dfo.dataset` it does not know and reads only the `dfo.*` keys it names.
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

/** The record `Provenance.toJSON()` returns: plain JSON values, in the format
 *  `provenance.schema.json` gives, which Python's `Provenance.to_json` writes too. */
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
  complete: boolean;
  /** One entry per part a partial fetch left out, as the saved file's `dfo.dataset` holds it. */
  missing: ReturnType<typeof savedGap>[];
  members: {
    spec_id: string;
    content_version: string;
    digest: string;
    parts: string[];
    sentence: string;
    citation: ReturnType<typeof savedCitation>;
    /** Null when the client does not know. */
    pinned: boolean | null;
    /** As `YYYY-MM-DD`, or null. */
    held_until: string | null;
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
  | "warnings"
  | "members"
  | "complete"
  | "missing"
>;

/**
 * Where a dataset came from, as one record to store beside the data. `JSON.stringify(provenance)`
 * writes it, and `Provenance.fromJSON` reads it back, in this client or the Python one. It holds
 * what the file `data.toBytes()` writes holds of the same dataset.
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
  /** Whether every member's version is kept without a time limit; false with no members. */
  readonly pinned: boolean;
  /** The earliest day any member's version not pinned can still be fetched, from the members'
   *  `heldUntil`, or null when every member is pinned or none of the others' days is known. */
  readonly heldUntil: Date | null;
  /** The datasets surface's warnings about the members' data. */
  readonly warnings: readonly Notice[];
  /** One member per built spec or derived frame, each an exact version with its digest, parts,
   *  sentence, citation and retention, its own `pinned` and `heldUntil`. Empty for a dataset
   *  that names no version. */
  readonly members: readonly (Member | DerivedMember)[];
  /** Whether every part of the question has a member, as `Dataset.complete`. */
  readonly complete: boolean;
  /** The parts a partial fetch left out, as `Dataset.missing`. */
  readonly missing: readonly Gap[];

  static {
    provenanceOf = (fields) => new Provenance(fields);
  }

  private constructor(fields: ProvenanceFields) {
    this.sentence = fields.sentence;
    this.citation = fields.citation;
    this.fetchedAt = fields.fetchedAt;
    this.question = fields.question;
    this.warnings = Object.freeze([...fields.warnings]);
    this.members = Object.freeze([...fields.members]);
    this.complete = fields.complete;
    this.missing = Object.freeze([...fields.missing]);
    ({ heldUntil: this.heldUntil, pinned: this.pinned } = datasetRetention(this.members));
    Object.freeze(this);
  }

  /** The exact versions the members name, to fetch them again with `client.fetch(ref)`, or null
   *  when there are no members. */
  get ref(): DatasetRef | null {
    return this.members.length === 0 ? null : refOf(this.members);
  }

  /** The record as JSON values, which `JSON.stringify(provenance)` writes and
   *  `Provenance.fromJSON` reads back. */
  toJSON(): ProvenanceJson {
    return {
      format_version: PROVENANCE_FORMAT_VERSION,
      sentence: this.sentence,
      citation: savedCitation(this.citation),
      fetched_at: this.fetchedAt === null ? null : isoTime(this.fetchedAt),
      question: this.question,
      ref: this.ref?.toJSON() ?? null,
      pinned: this.pinned,
      held_until: isoDay(this.heldUntil),
      warnings: this.warnings.map(({ code, severity, message, spec_id }) => ({
        code,
        severity,
        message,
        spec_id: spec_id ?? null,
      })),
      complete: this.complete,
      missing: this.missing.map(savedGap),
      members: this.members.map((member) => ({
        spec_id: member.spec.spec_id,
        content_version: member.contentVersion,
        digest: member.digest,
        parts: [...member.parts],
        sentence: member.sentence,
        citation: savedCitation(member.citation),
        pinned: member.pinned,
        held_until: isoDay(member.heldUntil),
      })),
    };
  }

  /** Whether `other` is a `Provenance` holding the same facts, as Python's `==` compares two. */
  equals(other: unknown): boolean {
    return (
      other instanceof Provenance && canonicalJson(this.toJSON()) === canonicalJson(other.toJSON())
    );
  }

  /**
   * Loads a record any DFO client wrote, from its JSON text or the value `JSON.parse` gives for
   * it. Python's `Provenance.from_json` takes the text, as str or bytes, or the parsed object.
   * A key the format does not name is ignored, at the top level, in a member, in a citation and
   * its sources, in a warning, and in a missing part and its options, so a record a later client
   * wrote reads here. The ref keeps its own versioned format, which `DatasetRef.fromJSON` reads
   * strictly.
   *
   * @throws {FormatError} The value is neither JSON text nor a JSON object, breaks the provenance
   *   format or comes from a later format version, a member differs from the member its ref
   *   names, the record's `pinned` or `held_until` differs from what its members give, members
   *   or none, `complete` is not whether `missing` is empty, or the ref breaks its own format, as
   *   `DatasetRef.fromJSON` throws, with a pointer under `/ref`.
   */
  static fromJSON(value: unknown): Provenance {
    let parsed: unknown = value;
    if (typeof value === "string") {
      try {
        parsed = parseJson(value);
      } catch (error) {
        throw Object.assign(invalid("", "not JSON"), { cause: error });
      }
    }
    const record = objectAt(parsed, "");
    requireKeys(record, "", PROVENANCE_KEYS);
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
    const heldUntil =
      record["held_until"] === null ? null : loadDay(record["held_until"], "/held_until");
    const members = entries.map((entry, index) =>
      provenanceMember(entry, stored[index]!, `/members/${index}`),
    );
    checkRetention({ pinned, heldUntil }, members, "");
    const complete = record["complete"];
    if (typeof complete !== "boolean") throw invalid("/complete", "not a boolean");
    const missing = arrayAt(record["missing"], "/missing").map((item, index) =>
      loadGap(item, `/missing/${index}`, { closed: false }),
    );
    checkComplete(complete, missing, "");
    return provenanceOf({
      sentence: stringAt(record["sentence"], "/sentence"),
      citation: loadCitation(record["citation"], "/citation", { closed: false }),
      fetchedAt:
        record["fetched_at"] === null ? null : loadTime(record["fetched_at"], "/fetched_at"),
      question: question === null ? null : stringAt(question, "/question"),
      warnings: arrayAt(record["warnings"], "/warnings").map((item, index) =>
        loadWarning(item, `/warnings/${index}`, { provenance: true }),
      ),
      members,
      complete,
      missing,
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

/** The keys of a provenance record, and of one member in it. A reader requires these and
 *  ignores any other. */
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
  "complete",
  "missing",
  "members",
] as const;
const PROVENANCE_MEMBER_KEYS = [
  "spec_id",
  "content_version",
  "digest",
  "parts",
  "sentence",
  "citation",
  "pinned",
  "held_until",
] as const;

/** A UTC time as the record writes it, to the second, such as `2026-11-27T09:14:05Z`. */
const isoTime = (date: Date): string => `${date.toISOString().slice(0, 19)}Z`;

/** A day as the record writes it, `YYYY-MM-DD`, or null. */
const isoDay = (date: Date | null): string | null => date?.toISOString().slice(0, 10) ?? null;

/** A UTC time as `toString` prints it, such as `27 November 2026 09:14 UTC`. */
const timeText = (date: Date): string => `${dayText(date)} ${date.toISOString().slice(11, 16)} UTC`;

/** A provenance member, which names the ref member at its position, with its citation and
 *  retention. */
function provenanceMember(
  value: unknown,
  stored: RefMember | DerivedRefMember,
  pointer: string,
): Member | DerivedMember {
  const entry = objectAt(value, pointer);
  requireKeys(entry, pointer, PROVENANCE_MEMBER_KEYS);
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
  return {
    ...stored,
    citation: loadCitation(entry["citation"], `${pointer}/citation`, { closed: false }),
    ...loadRetention(entry, pointer),
  };
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
