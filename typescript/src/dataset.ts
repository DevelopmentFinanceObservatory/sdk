import type * as Arrow from "apache-arrow";

import { decodeArrow, decodeRows, readParquet, stackedColumns } from "./parquet.ts";
import type { ParquetFile, Row, TablePart } from "./parquet.ts";
import { DatasetRef } from "./ref.ts";
import type { Layout, Rendering, SpecLike } from "./ref.ts";
import type { CitationSource } from "./wire.ts";

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
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

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

/**
 * A table of data with its provenance: one exact version per member. It holds no client, so its
 * conversions never touch the network. `TMissing` is the type of the parts a partial fetch left
 * out; a dataset fetched from a spec or a ref leaves none out.
 */
export class Dataset<TMissing = never> {
  /** What the data shows, in Search's words: the members' sentences in order. */
  readonly sentence: string;
  readonly members: readonly Member[];
  /** How to cite the data, every member's sources together. */
  readonly citation: Citation;
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
  readonly #files: readonly ParquetFile[];
  readonly #data: readonly Uint8Array[];

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
    const retention = retentionOf(members.map((member) => member.manifest));
    this.sentence = built.map((member) => member.sentence).join(" ");
    this.members = Object.freeze(built);
    this.citation = mergeCitations(built.map((member) => member.citation));
    this.missing = Object.freeze([...(options.missing ?? [])]);
    this.complete = this.missing.length === 0;
    this.heldUntil = retention.heldUntil;
    this.pinned = retention.pinned;
    this.layout = options.layout;
    this.#data = members.map((member) => member.data.slice());
    this.#files = this.#data.map(readParquet);
    // Reading the columns checks the members stack before the dataset is returned.
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
   * The Parquet file the server built, checked against its digest. A dataset of several
   * members has one file per member: read each with `memberBytes(index)`.
   */
  bytes(): Uint8Array {
    if (this.#data.length > 1) {
      throw new TypeError(
        `This dataset stacks ${this.#data.length} members, each its own Parquet file; ` +
          "read one with memberBytes(index).",
      );
    }
    return this.memberBytes(0);
  }

  /** One member's Parquet file, checked against its digest. */
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

  /** The table as an Arrow table. Needs the optional `apache-arrow` package. INT64 columns
   *  keep their `bigint` values. */
  toArrow(): Promise<Arrow.Table> {
    return decodeArrow(this.#parts());
  }

  #parts(): TablePart[] {
    return this.#files.map((file, index) => {
      const member = this.members[index]!;
      return { file, label: member.parts.join("; ") || member.sentence };
    });
  }
}
