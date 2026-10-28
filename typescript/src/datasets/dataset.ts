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
import { DatasetRef, isDerived } from "../core/ref.ts";
import type { DerivedRefMember, Layout, Rendering, ResolvedPeriod, Spec } from "../core/ref.ts";
import { manifestWarningsOf } from "../core/parse.ts";
import type { PartFacts } from "../core/parse.ts";
import type { Assumption, CitationSource, Departure, Notice, RequestedOperation } from "../wire.ts";
import { isRecord, list, objects, text } from "../core/json.ts";
import { inline } from "../core/text.ts";

/** The version of the provenance a file from `bytes()` carries under `dfo.*` keys, the one
 *  Python's `Dataset.save` writes. */
const SAVED_FORMAT_VERSION = 1;

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
const isSource = (value: unknown): value is CitationSource =>
  isRecord(value) && typeof value["ref"] === "string" && typeof value["label"] === "string";

function citationOf(manifest: Readonly<Record<string, unknown>>): Citation {
  const citation = manifest["citation"];
  if (!isRecord(citation)) return { text: "", sources: [] };
  return {
    text: text(citation["text"]) ?? "",
    sources: list(citation["sources"]).filter(isSource),
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
    return new Dataset(inputs, options, data, table);
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
    this.#data = data;
    this.#table = table;
    const derived = options.derived;
    const roles = derived?.roles ?? {};
    this.leftOut = Object.freeze(
      (derived?.leftOut ?? []).map((series) => new LeftOutSeries(series, roles)),
    );
    this.#leftOutComplete = derived?.leftOutComplete ?? true;
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
    return new DatasetRef(
      this.members.map((member) =>
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
  async bytes(): Promise<Uint8Array> {
    return encodeStacked(this.#table, this.#metadata());
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

  /** One member's Parquet file as the server built it, checked against its digest. */
  memberBytes(index: number): Uint8Array {
    const data = this.#data[index];
    if (data === undefined) {
      throw new RangeError(`This dataset has ${this.#data.length} member(s), not ${index + 1}.`);
    }
    return data.slice();
  }

  /** Every row as an object keyed by column name. `JSON.stringify` works on the result. It
   *  decodes the whole table in memory, one object per row. */
  toRows(): Promise<Row[]> {
    return decodeRows(this.#table);
  }

  /** The provenance as the file's key-value metadata, in the shape Python's
   *  `Dataset.save` writes, so `dfo.load` reads the file back. */
  #metadata(): Record<string, string> {
    const sources = this.citation.sources;
    const licences = [...new Set(sources.flatMap((source) => source.license ?? []))];
    const derived = !this.members.some(isDerived)
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
      "dfo.format_version": String(SAVED_FORMAT_VERSION),
      "dfo.sentence": this.sentence,
      "dfo.citation": JSON.stringify(savedCitation(this.citation)),
      "dfo.sources": JSON.stringify(sources.map((source) => source.label)),
      "dfo.licence": licences.join("; "),
      "dfo.dataset": JSON.stringify({
        member_citations: this.members.map((member) => savedCitation(member.citation)),
        warnings: this.warnings.map(({ code, severity, message }) => ({
          code,
          severity,
          message,
          spec_id: null,
        })),
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
        held_until: this.heldUntil?.toISOString().slice(0, 10) ?? null,
        pinned: this.pinned,
        stale: false,
        layout_version: this.layoutVersion,
        member_rows: memberRows(this.#table.parts),
      }),
      "dfo.ref": JSON.stringify(this.ref),
      ...derived,
    };
  }
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
    licence: source.license ?? null,
    licence_url: source.license_url ?? null,
    url: source.url ?? null,
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
