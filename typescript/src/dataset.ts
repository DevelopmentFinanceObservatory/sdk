import type { Gap } from "./answer.ts";
import { decodeRows, encodeStacked, readParquet, stackedColumns } from "./parquet.ts";
import type { ParquetFile, Row, TablePart } from "./parquet.ts";
import { DatasetRef } from "./ref.ts";
import type { Layout, Rendering, SpecLike } from "./ref.ts";
import type {
  Assumption,
  CitationSource,
  Departure,
  Part,
  RequestedOperation,
  WarningModel,
} from "./wire.ts";
import { isRecord } from "./json.ts";

/** The version of the provenance a file from `bytes()` carries under `dfo.*` keys, the one
 *  Python's `Dataset.save` writes. */
export const SAVED_FORMAT_VERSION = 1;

/** How to cite the data: the citation text and the cited sources. */
export type Citation = {
  readonly text: string;
  readonly sources: readonly CitationSource[];
};

/** One reading inside a dataset: the exact version built for it. */
export type Member = {
  /** The variable text of each answer part the member answers, in query order; empty for a
   *  spec fetched outside an answer. */
  readonly parts: readonly string[];
  /** The spec the server built, which a narrowing gives its own `spec_id`. */
  readonly spec: SpecLike;
  readonly contentVersion: string;
  /** Search's sentence for the built identity. */
  readonly sentence: string;
  readonly citation: Citation;
  /** The SHA-256 digest of the member's Parquet file, which the fetch checked. */
  readonly digest: string;
  readonly rendering: Rendering;
};

/** A built version, downloaded and checked against its digest, ready to join a dataset. */
export type FetchedMember = {
  readonly parts: readonly string[];
  readonly spec: SpecLike;
  readonly sentence: string;
  readonly contentVersion: string;
  /** The manifest the server answered for the version, as parsed JSON. */
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly digest: string;
  readonly rendering: Rendering;
  readonly data: Uint8Array;
  /** The answer parts the member answers, when it came from an answer; their departures,
   *  requested computations and assumptions reach the dataset. */
  readonly answerParts?: readonly Part[];
};

/** A cited source as the server sent it, with the two members every source carries. */
const isSource = (value: unknown): value is CitationSource =>
  isRecord(value) && typeof value["ref"] === "string" && typeof value["label"] === "string";

function citationOf(manifest: Readonly<Record<string, unknown>>): Citation {
  const citation = manifest["citation"];
  if (!isRecord(citation)) return { text: "", sources: [] };
  const sources = Array.isArray(citation["sources"]) ? citation["sources"] : [];
  return {
    text: typeof citation["text"] === "string" ? citation["text"] : "",
    sources: sources.filter(isSource),
  };
}

const unique = <T>(items: readonly T[]): T[] => [
  ...new Map(items.map((item) => [JSON.stringify(item), item])).values(),
];

const objects = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

/** The datasets surface's warnings in the manifests, each with the members every warning has. */
const warningsOf = (manifests: readonly Readonly<Record<string, unknown>>[]): WarningModel[] =>
  unique(
    manifests.flatMap((manifest) =>
      objects(manifest["warnings"]).flatMap((notice) =>
        typeof notice["code"] === "string" &&
        typeof notice["severity"] === "string" &&
        typeof notice["message"] === "string"
          ? [notice as WarningModel]
          : [],
      ),
    ),
  );

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

/** Reads a dataset's private table parts; Dataset's static block assigns it. */
let readParts: (dataset: Dataset<Gap>) => TablePart[];

/**
 * A table of data with its provenance: one exact version per member. It holds no client, so its
 * conversions never touch the network. `TMissing` is the type of the parts a partial fetch left
 * out; a dataset fetched from a spec or a ref leaves none out.
 */
export class Dataset<TMissing extends Gap = never> {
  /** What the data shows, in Search's words: the members' sentences in order. */
  readonly sentence: string;
  readonly members: readonly Member[];
  /** How to cite the data, every member's sources together. */
  readonly citation: Citation;
  /** The datasets surface's warnings about the members' data. */
  readonly warnings: readonly WarningModel[];
  /** How the readings differ from the question. */
  readonly departures: readonly Departure[];
  /** Computations the question asked for, which the data leaves to the caller. */
  readonly requestedOperations: readonly RequestedOperation[];
  /** What Search assumed to read the question, as the answer parts' sentences state it. */
  readonly assumptions: readonly Assumption[];
  /** Whether every part of the question has a member. */
  readonly complete: boolean;
  /** The parts a partial fetch left out. */
  readonly missing: readonly TMissing[];
  /** The earliest time any member's version can still be fetched; null when every member is
   *  pinned, or while the server does not say. */
  readonly heldUntil: Date | null;
  /** Whether every member's version is kept without a time limit. */
  readonly pinned: boolean;
  readonly layout: Layout;
  /** The artifact layout each member's manifest names, distinct ones joined by "; ". */
  readonly layoutVersion: string;
  readonly #files: readonly ParquetFile[];
  readonly #data: readonly Uint8Array[];

  static {
    readParts = (dataset) => dataset.#parts();
  }

  /** Builds a dataset from the members a fetch downloaded and checked against their digests. */
  constructor(
    members: readonly FetchedMember[],
    options: { layout: Layout; missing?: readonly TMissing[] },
  ) {
    if (members.length === 0) throw new TypeError("A dataset needs at least one member.");
    if (options.layout === "frame" && members.length > 1) {
      throw new TypeError("The frame layout holds one member.");
    }
    const built = members.map((member) => ({
      parts: Object.freeze([...member.parts]),
      spec: member.spec,
      contentVersion: member.contentVersion,
      sentence: member.sentence,
      citation: citationOf(member.manifest),
      digest: member.digest,
      rendering: member.rendering,
    }));
    const manifests = members.map((member) => member.manifest);
    const answerParts = members.flatMap((member) => member.answerParts ?? []);
    const retention = retentionOf(manifests);
    this.sentence = built.map((member) => member.sentence).join(" ");
    this.members = Object.freeze(built);
    this.citation = mergeCitations(built.map((member) => member.citation));
    this.warnings = Object.freeze(warningsOf(manifests));
    this.departures = Object.freeze(
      unique(answerParts.flatMap((part) => (part.departures ?? []) as Departure[])),
    );
    this.requestedOperations = Object.freeze(
      unique(answerParts.flatMap((part) => (part.operations ?? []) as RequestedOperation[])),
    );
    // Each assumption keeps the four members both clients save, so equal ones count once.
    this.assumptions = Object.freeze(
      unique(
        answerParts.flatMap((part) =>
          ((part.assumptions ?? []) as Assumption[]).map(({ kind, binding_ref, text, refs }) => ({
            kind,
            binding_ref,
            text,
            refs: refs ?? [],
          })),
        ),
      ),
    );
    this.missing = Object.freeze([...(options.missing ?? [])]);
    this.complete = this.missing.length === 0;
    this.heldUntil = retention.heldUntil;
    this.pinned = retention.pinned;
    this.layout = options.layout;
    this.#data = members.map((member) => member.data.slice());
    this.#files = this.#data.map(readParquet);
    this.layoutVersion = [
      ...new Set(members.map((member) => artifactLayout(member, options.layout))),
    ].join("; ");
    // Reading the columns checks the members stack before the dataset is returned; a pair of
    // column types that does not widen raises ContractError.
    stackedColumns(this.#parts());
  }

  /** The exact versions the dataset holds, to fetch them again with `client.fetch(ref)`. */
  get ref(): DatasetRef {
    return new DatasetRef(
      this.members.map((member) => ({
        parts: member.parts,
        sentence: member.sentence,
        spec: member.spec,
        contentVersion: member.contentVersion,
        digest: member.digest,
        rendering: member.rendering,
      })),
    );
  }

  /** The number of rows in the table. */
  get rows(): number {
    return this.#files.reduce((total, file) => total + file.rows, 0);
  }

  /** The table's column names, `part` first when several members stack. */
  get columns(): readonly string[] {
    return stackedColumns(this.#parts()).map((column) => column.name);
  }

  /**
   * The dataset as one Parquet file whose key-value metadata carries the provenance and the ref
   * under `dfo.*` keys, as Python's `Dataset.save` writes it, so `dfo.open_bundle` reads it
   * back. Several members stack into the file, `part` first. `memberBytes` gives the file the
   * server built.
   */
  async bytes(): Promise<Uint8Array> {
    return encodeStacked(this.#parts(), this.#metadata());
  }

  /** One member's Parquet file as the server built it, checked against its digest. */
  memberBytes(index: number): Uint8Array {
    const data = this.#data[index];
    if (data === undefined) {
      throw new RangeError(`This dataset has ${this.#data.length} member(s), not ${index + 1}.`);
    }
    return data.slice();
  }

  /** Every row as an object keyed by column name. `JSON.stringify` works on the result. */
  toRows(): Promise<Row[]> {
    return decodeRows(this.#parts());
  }

  /** The provenance as the file's key-value metadata, in the shape Python's
   *  `Dataset.save` writes, so `dfo.open_bundle` reads the file back. */
  #metadata(): Record<string, string> {
    const sources = this.citation.sources;
    const licences = [...new Set(sources.flatMap((source) => source.license ?? []))];
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
      }),
      "dfo.ref": JSON.stringify(this.ref),
    };
  }

  #parts(): TablePart[] {
    return this.#files.map((file, index) => {
      const member = this.members[index]!;
      return { file, label: member.parts.join("; ") || member.sentence };
    });
  }
}

/** A dataset's stacked table parts, for the `arrow` entry point. */
export function tableParts(dataset: Dataset<Gap>): TablePart[] {
  return readParts(dataset);
}

/** The layout a member's manifest names for its artifact, else the fetch's layout. */
function artifactLayout(member: FetchedMember, layout: Layout): string {
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

/** A gap as Python's `Dataset.save` writes it: a choice of place or source keeps its options. */
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
