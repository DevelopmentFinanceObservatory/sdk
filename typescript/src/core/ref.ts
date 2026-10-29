/**
 * The `DatasetRef` format every DFO client writes and reads, fixed by
 * `contract/dataset-ref.schema.json`, so a ref saved by one language loads in another. Format 1
 * holds dataset members, each a version of a built spec. Format 2 holds derived members, each the
 * frame an analysis recipe computed, which DFO describes in full: the client copies every field
 * from the server's answer and computes none.
 */

import { clientError } from "./errors.ts";
import { isRecord, parseJson } from "./json.ts";
import { inline } from "./text.ts";
import type { ResolvedSpec } from "../wire.ts";

/** The layouts a dataset comes in: the labelled long table, or the pipeline frame. */
export type Layout = "long" | "frame";

/** Which rendering of a version an artifact is, as a ref stores it: format, bundle and layout,
 *  and `without_party_totals` when its fetch posted the party-totals cut, the default, whether
 *  or not the cut left a row out. The flag is present only when true, so the JSON of a
 *  rendering fetched with `partyTotals: true` has no such key. */
export type Rendering = {
  readonly format: "csv" | "xlsx" | "parquet";
  readonly bundle: boolean;
  readonly layout?: "frame";
  readonly without_party_totals?: true;
};

/** One reading of a question, the unit the server builds a dataset from: an answer's spec, a
 *  ref member's, or one read back from JSON. The definition stays as the server sent it, because
 *  the server needs its `identity` back unmodified. `resolved` is Search's reading of the spec,
 *  which gives its sentence and entity groups; a spec from a ref or written by hand has none. */
export type Spec = {
  readonly spec_id: string;
  readonly definition: Readonly<Record<string, unknown>>;
  readonly resolved?: ResolvedSpec | null | undefined;
};

/** One member of a ref: the exact version of one reading. */
export type RefMember = {
  /** The variable text of each answer part the member answers, in query order; empty for a
   *  spec fetched outside an answer. */
  readonly parts: readonly string[];
  /** Search's sentence for the built identity. */
  readonly sentence: string;
  readonly spec: Spec;
  readonly contentVersion: string;
  readonly digest: string;
  readonly rendering: Rendering;
};

/** The recipe a derived member's frame comes from, as DFO names it: its `ops_` id, and the
 *  recipe's two hashes. `normal_form_hash` names the computation whatever data it ran on, and
 *  `replay_key` names it on these roots under this execution identity. */
export type DerivedSpec = {
  readonly spec_id: string;
  readonly recipe: { readonly normal_form_hash: string; readonly replay_key: string };
};

/** A dataset version a recipe ran on, with the rendering it read. */
export type Root = {
  readonly specId: string;
  readonly contentVersion: string;
  readonly rendering: Rendering;
};

/** A period a recipe states relative to the latest period, with the year it resolved to. */
export type ResolvedPeriod = {
  readonly anchor: "latest";
  /** Periods before the anchor, 0 or below. */
  readonly offset: number;
  /** How the latest period was settled: the newest period at least half the series hold. */
  readonly rule: "half1";
  readonly period: string;
};

/** One derived member of a ref: the frame an analysis recipe computed. DFO computes every field;
 *  a client copies them from the server's answer. */
export type DerivedRefMember = {
  /** Empty for a derived member, which no answer part names. */
  readonly parts: readonly string[];
  /** The server's sentence for the derived frame. */
  readonly sentence: string;
  readonly spec: DerivedSpec;
  /** The frame's version, `ocv_…`. */
  readonly contentVersion: string;
  /** The digest of the frame's output alone, `out_…`, which `sameData` compares. */
  readonly outputDigest: string;
  readonly roots: readonly Root[];
  /** The engine, frame grammar and reduction policy versions that ran the recipe, joined by `|`. */
  readonly executionIdentity: string;
  /** Each period the recipe states relative to the latest, resolved; empty when it states none. */
  readonly resolvedPeriods: readonly ResolvedPeriod[];
  readonly digest: string;
  readonly rendering: Rendering;
};

/** Whether a member of a ref or a dataset is a derived member, whose `spec` is a
 *  `DerivedSpec`: `isDerived(data.members[0])` narrows to `DerivedMember`, and a ref's member
 *  to `DerivedRefMember`. */
export const isDerived = <TMember extends RefMember | DerivedRefMember>(
  member: TMember,
): member is Extract<TMember, DerivedRefMember> => "outputDigest" in member;

/** Whether a member of a ref or a dataset is a dataset member, whose `spec` is a `Spec` that
 *  `client.fetch` takes: `isDatasetMember(data.members[0])` narrows to `Member`, and a ref's
 *  member to `RefMember`. */
export const isDatasetMember = <TMember extends RefMember | DerivedRefMember>(
  member: TMember,
): member is Exclude<TMember, DerivedRefMember> => !isDerived(member);

/** A ref as JSON, in the stored format: format 1 of dataset members, or format 2 of derived
 *  members. */
export type DatasetRefJson =
  | {
      format_version: 1;
      members: {
        parts: string[];
        sentence: string;
        spec: { spec_id: string; definition: Readonly<Record<string, unknown>> };
        content_version: string;
        artifact: {
          digest: string;
          rendering: {
            format: string;
            bundle: boolean;
            layout?: "frame";
            without_party_totals?: true;
          };
        };
      }[];
    }
  | {
      format_version: 2;
      members: {
        parts: string[];
        sentence: string;
        spec: { spec_id: string; recipe: { normal_form_hash: string; replay_key: string } };
        content_version: string;
        output_digest: string;
        roots: {
          spec_id: string;
          content_version: string;
          rendering: {
            format: string;
            bundle: boolean;
            layout?: "frame";
            without_party_totals?: true;
          };
        }[];
        execution_identity: string;
        resolved_periods: { anchor: "latest"; offset: number; rule: "half1"; period: string }[];
        artifact: {
          digest: string;
          rendering: {
            format: string;
            bundle: boolean;
            layout?: "frame";
            without_party_totals?: true;
          };
        };
      }[];
    };

/** Why stored JSON is not a ref: it breaks the format's shape, a member's definition names
 *  another spec, or two members hold one spec. */
export type FormatErrorReason =
  "format_invalid" | "definition_spec_id_mismatch" | "repeated_spec_id";

/** Stored JSON for a `DatasetRef` does not match the format. */
export class FormatError extends TypeError {
  readonly reason: FormatErrorReason;
  /** A JSON Pointer to the offending value. */
  readonly pointer: string;

  constructor(reason: FormatErrorReason, pointer: string, detail: string) {
    super(`${pointer || "/"}: ${detail}`);
    this.reason = reason;
    this.pointer = pointer;
  }
}
Object.defineProperty(FormatError.prototype, "name", { value: "FormatError", configurable: true });

/** A `format_invalid` error at `pointer`. */
const invalid = (pointer: string, detail: string): FormatError =>
  new FormatError("format_invalid", pointer, detail);

/** The ref format of dataset members, and the one of derived members. */
const DATASET_FORMAT = 1;
const DERIVED_FORMAT = 2;
/** A dataset spec's id, and the id of a recipe's frame DFO computed. */
export const SPEC_ID = /^spec_[0-9a-f]{32}$/;
export const OPS_ID = /^ops_[0-9a-f]{32}$/;
const DERIVED_VERSION = /^ocv_[0-9a-f]{32}$/;
const OUTPUT_DIGEST = /^out_[0-9a-f]{32}$/;
const NORMAL_FORM_HASH = /^rnf_[0-9a-f]{32}$/;
const REPLAY_KEY = /^rpk_[0-9a-f]{32}$/;
const EXECUTION_IDENTITY = /^[0-9A-Za-z.+-]+\|[0-9A-Za-z.+-]+\|[0-9A-Za-z.+-]+$/;
const PERIOD = /^[0-9]{4}$/;
/** A version's id, as the ref format and the server write it. */
export const CONTENT_VERSION = /^cv_[0-9a-f]{32}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const FORMATS: readonly string[] = ["csv", "xlsx", "parquet"];
const isFormat = (value: unknown): value is Rendering["format"] =>
  typeof value === "string" && FORMATS.includes(value);

/**
 * The bare Parquet rendering both clients build for a layout, cut of party totals or not.
 *
 * @throws {InvalidRequestError} The layout is neither `long` nor `frame` (`invalid_argument`).
 */
export function renderingFor(layout: Layout, withoutPartyTotals: boolean = false): Rendering {
  const cut = withoutPartyTotals ? { without_party_totals: true as const } : {};
  switch (layout) {
    case "long":
      return { format: "parquet", bundle: false, ...cut };
    case "frame":
      return { format: "parquet", bundle: false, layout: "frame", ...cut };
    default:
      throw clientError("invalid_argument", {
        detail: `layout is "long" or "frame", not ${JSON.stringify(layout satisfies never)}.`,
      });
  }
}

/** The layout a rendering holds. */
export const layoutOf = (rendering: Rendering): Layout =>
  rendering.layout === "frame" ? "frame" : "long";

/** A rendering as the server takes it, both as a build request's `options` and as the file
 *  selector's query: format, bundle, layout, and `without_party_totals`, sent only when true,
 *  as the server records it. */
export function mintOptions(rendering: Rendering): Record<string, string | boolean> {
  const options: Record<string, string | boolean> = {
    format: rendering.format,
    bundle: rendering.bundle,
  };
  if (rendering.layout !== undefined) options["layout"] = rendering.layout;
  if (rendering.without_party_totals === true) options["without_party_totals"] = true;
  return options;
}

/** Whether a manifest artifact's rendering object is this rendering. The server's object
 *  carries more members, such as the long layout's version, so it matches on format, bundle
 *  and whether its layout is the frame. `without_party_totals` plays no part: the version a
 *  build answers is already the cut or the plain one. */
export function renderingMatches(rendering: Rendering, served: unknown): boolean {
  if (!isRecord(served)) return false;
  return (
    served["format"] === rendering.format &&
    served["bundle"] === rendering.bundle &&
    (served["layout"] === "frame") === (rendering.layout === "frame")
  );
}

/** Whether two renderings are the same: format, bundle, layout and the party-totals cut. */
export const sameRendering = (a: Rendering, b: Rendering): boolean =>
  a.format === b.format &&
  a.bundle === b.bundle &&
  layoutOf(a) === layoutOf(b) &&
  (a.without_party_totals === true) === (b.without_party_totals === true);

/** A derived member in the stored format, its keys in the schema's order. */
const derivedJson = (member: DerivedRefMember) => ({
  parts: [...member.parts],
  sentence: member.sentence,
  spec: {
    spec_id: member.spec.spec_id,
    recipe: {
      normal_form_hash: member.spec.recipe.normal_form_hash,
      replay_key: member.spec.recipe.replay_key,
    },
  },
  content_version: member.contentVersion,
  output_digest: member.outputDigest,
  roots: member.roots.map((root) => ({
    spec_id: root.specId,
    content_version: root.contentVersion,
    rendering: { ...root.rendering },
  })),
  execution_identity: member.executionIdentity,
  resolved_periods: member.resolvedPeriods.map(({ anchor, offset, rule, period }) => ({
    anchor,
    offset,
    rule,
    period,
  })),
  artifact: { digest: member.digest, rendering: { ...member.rendering } },
});

/** Whether two members are one identity: the same spec at the same version in the same
 *  rendering, and for derived members the same recipe. */
function sameIdentity(a: RefMember | DerivedRefMember, b: RefMember | DerivedRefMember): boolean {
  if (
    a.spec.spec_id !== b.spec.spec_id ||
    a.contentVersion !== b.contentVersion ||
    !sameRendering(a.rendering, b.rendering) ||
    isDerived(a) !== isDerived(b)
  ) {
    return false;
  }
  if (!isDerived(a) || !isDerived(b)) return true;
  return (
    a.spec.recipe.normal_form_hash === b.spec.recipe.normal_form_hash &&
    a.spec.recipe.replay_key === b.spec.recipe.replay_key
  );
}

/** Whether two members hold the same output: derived members with one output digest, or dataset
 *  members at one version with the same party-totals cut. */
function sameOutput(a: RefMember | DerivedRefMember, b: RefMember | DerivedRefMember): boolean {
  if (isDerived(a) && isDerived(b)) return a.outputDigest === b.outputDigest;
  if (isDerived(a) || isDerived(b)) return false;
  return (
    a.contentVersion === b.contentVersion &&
    (a.rendering.without_party_totals === true) === (b.rendering.without_party_totals === true)
  );
}

/** The exact versions a dataset holds. `JSON.stringify(ref)` writes the stored format,
 *  `DatasetRef.fromJSON` reads one written by any DFO client, `client.fetch(ref)` fetches those
 *  versions, and `client.fetch(ref, { latest: true })` the newest versions of its specs. A ref
 *  holds dataset members or derived members, one kind per ref. `client.fetch` reads a ref of one
 *  derived member as the exact frame it names. When DFO no longer stores that frame, it computes
 *  the recipe again on the root versions the ref names. `client.fetch(ref, { latest: true })`
 *  computes the recipe on its datasets' newest versions. */
export class DatasetRef {
  readonly members: readonly (RefMember | DerivedRefMember)[];

  /** @throws {TypeError} The members mix dataset members and derived members. */
  constructor(members: readonly (RefMember | DerivedRefMember)[]) {
    if (new Set(members.map(isDerived)).size > 1) {
      throw new TypeError("A DatasetRef holds dataset members or derived members, not both.");
    }
    this.members = Object.freeze([...members]);
  }

  /**
   * Whether `other` is a ref to the same specs at the same versions in the same renderings, in
   * order, and for derived members the same recipes. Digests, sentences and part labels are left
   * out, since a version rendered again holds the same data under another digest.
   */
  equals(other: unknown): boolean {
    if (!(other instanceof DatasetRef) || other.members.length !== this.members.length) {
      return false;
    }
    return this.members.every((member, index) => sameIdentity(member, other.members[index]!));
  }

  /**
   * Whether `other` holds the same output: as many members, and at each position derived members
   * with the same output digest, or dataset members at the same version with the same
   * party-totals cut. Recipes, roots, execution identities, layouts and file formats are left
   * out, so an engine release or an upstream rebuild that moves no number keeps it true.
   *
   * @throws {InvalidRequestError} `other` is not a `DatasetRef` (`invalid_argument`).
   */
  sameData(other: DatasetRef): boolean {
    const given: unknown = other;
    if (!(given instanceof DatasetRef)) {
      const kind = given === null ? "null" : Array.isArray(given) ? "an array" : typeof given;
      throw clientError("invalid_argument", {
        detail:
          `sameData compares two DatasetRefs, not ${kind}; read a saved ref with ` +
          "DatasetRef.fromJSON first.",
      });
    }
    if (other.members.length !== this.members.length) return false;
    return this.members.every((member, index) => sameOutput(member, other.members[index]!));
  }

  /** The specs and the exact versions the ref names, as `DatasetRef(1 member: spec_… at cv_…,
   *  exact)`, on one line through `inline`. */
  toString(): string {
    const count = this.members.length;
    const versions = this.members.map(
      (member) => `${member.spec.spec_id} at ${member.contentVersion}`,
    );
    return inline(
      `DatasetRef(${count} member${count === 1 ? "" : "s"}: ${versions.join(", ")}, exact)`,
    );
  }

  /** Node's `console.log` and `util.inspect` show the ref as `String(ref)` does. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }

  /** The ref in the stored format: format 1 for dataset members, format 2 for derived ones. */
  toJSON(): DatasetRefJson {
    const derived = this.members.filter(isDerived);
    if (derived.length > 0) {
      return { format_version: DERIVED_FORMAT, members: derived.map(derivedJson) };
    }
    return {
      format_version: DATASET_FORMAT,
      members: this.members.filter(isDatasetMember).map((member) => ({
        parts: [...member.parts],
        sentence: member.sentence,
        spec: { spec_id: member.spec.spec_id, definition: member.spec.definition },
        content_version: member.contentVersion,
        artifact: { digest: member.digest, rendering: { ...member.rendering } },
      })),
    };
  }

  /**
   * Loads a ref from its JSON text, or from the parsed value.
   *
   * @throws {FormatError} The value breaks the format, a member's definition names another
   *   spec, or two members hold one spec.
   */
  static fromJSON(value: unknown): DatasetRef {
    let parsed: unknown = value;
    if (typeof value === "string") {
      try {
        parsed = parseJson(value);
      } catch (error) {
        throw Object.assign(invalid("", "not JSON"), { cause: error });
      }
    }
    const ref = objectAt(parsed, "");
    checkKeys(ref, "", ["format_version", "members"]);
    const version = ref["format_version"];
    if (version !== DATASET_FORMAT && version !== DERIVED_FORMAT) {
      throw invalid("/format_version", `not ${DATASET_FORMAT} or ${DERIVED_FORMAT}`);
    }
    const members = ref["members"];
    if (!Array.isArray(members) || members.length === 0) {
      throw invalid("/members", "not a non-empty array");
    }
    const load = version === DATASET_FORMAT ? loadMember : loadDerivedMember;
    const loaded = members.map((member: unknown, index) => load(member, `/members/${index}`));
    const seen = new Set<string>();
    for (const [index, member] of loaded.entries()) {
      if (seen.has(member.spec.spec_id)) {
        throw new FormatError(
          "repeated_spec_id",
          `/members/${index}/spec/spec_id`,
          `${member.spec.spec_id} is already a member`,
        );
      }
      seen.add(member.spec.spec_id);
    }
    return new DatasetRef(loaded);
  }
}

function objectAt(value: unknown, pointer: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalid(pointer, "not an object");
  return value;
}

function checkKeys(
  value: Record<string, unknown>,
  pointer: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw invalid(`${pointer}/${key}`, "missing");
    }
  }
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw invalid(`${pointer}/${key}`, "not a member of the format");
    }
  }
}

const isText = (value: unknown): value is string => typeof value === "string" && value !== "";

function matching(pattern: RegExp, value: unknown, pointer: string, what: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw invalid(pointer, `not ${what}`);
  }
  return value;
}

/** A member's `parts` and `sentence`. */
function loadText(
  member: Record<string, unknown>,
  pointer: string,
): { parts: readonly string[]; sentence: string } {
  const parts = member["parts"];
  if (!Array.isArray(parts) || !parts.every(isText)) {
    throw invalid(`${pointer}/parts`, "not an array of non-empty strings");
  }
  const sentence = member["sentence"];
  if (!isText(sentence)) {
    throw invalid(`${pointer}/sentence`, "not a non-empty string");
  }
  return { parts: Object.freeze([...parts]), sentence };
}

/** A member's artifact digest and rendering. */
function loadArtifact(value: unknown, pointer: string): { digest: string; rendering: Rendering } {
  const artifact = objectAt(value, pointer);
  checkKeys(artifact, pointer, ["digest", "rendering"]);
  return {
    digest: matching(DIGEST, artifact["digest"], `${pointer}/digest`, "a digest"),
    rendering: Object.freeze(loadRendering(artifact["rendering"], `${pointer}/rendering`)),
  };
}

function loadMember(value: unknown, pointer: string): RefMember {
  const member = objectAt(value, pointer);
  checkKeys(member, pointer, ["parts", "sentence", "spec", "content_version", "artifact"]);
  const { parts, sentence } = loadText(member, pointer);

  const spec = objectAt(member["spec"], `${pointer}/spec`);
  checkKeys(spec, `${pointer}/spec`, ["spec_id", "definition"]);
  const specId = matching(SPEC_ID, spec["spec_id"], `${pointer}/spec/spec_id`, "a spec id");
  const definition = objectAt(spec["definition"], `${pointer}/spec/definition`);
  checkKeys(definition, `${pointer}/spec/definition`, ["schema_version", "spec_id", "identity"]);
  if (!Number.isInteger(definition["schema_version"])) {
    throw new FormatError(
      "format_invalid",
      `${pointer}/spec/definition/schema_version`,
      "not an integer",
    );
  }
  objectAt(definition["identity"], `${pointer}/spec/definition/identity`);
  const named = matching(
    SPEC_ID,
    definition["spec_id"],
    `${pointer}/spec/definition/spec_id`,
    "a spec id",
  );
  if (named !== specId) {
    throw new FormatError(
      "definition_spec_id_mismatch",
      `${pointer}/spec/definition/spec_id`,
      `the definition is for ${named}, not ${specId}`,
    );
  }

  const contentVersion = matching(
    CONTENT_VERSION,
    member["content_version"],
    `${pointer}/content_version`,
    "a content version",
  );
  return Object.freeze({
    parts,
    sentence,
    spec: Object.freeze({
      spec_id: specId,
      definition: frozenCopy(definition, `${pointer}/spec/definition`),
    }),
    contentVersion,
    ...loadArtifact(member["artifact"], `${pointer}/artifact`),
  });
}

const DERIVED_KEYS = [
  "parts",
  "sentence",
  "spec",
  "content_version",
  "output_digest",
  "roots",
  "execution_identity",
  "resolved_periods",
  "artifact",
];

function loadDerivedMember(value: unknown, pointer: string): DerivedRefMember {
  const member = objectAt(value, pointer);
  checkKeys(member, pointer, DERIVED_KEYS);
  const { parts, sentence } = loadText(member, pointer);
  if (parts.length > 0) throw invalid(`${pointer}/parts`, "not empty");
  const spec = objectAt(member["spec"], `${pointer}/spec`);
  checkKeys(spec, `${pointer}/spec`, ["spec_id", "recipe"]);
  const recipe = objectAt(spec["recipe"], `${pointer}/spec/recipe`);
  checkKeys(recipe, `${pointer}/spec/recipe`, ["normal_form_hash", "replay_key"]);
  return Object.freeze({
    parts,
    sentence,
    spec: Object.freeze({
      spec_id: matching(OPS_ID, spec["spec_id"], `${pointer}/spec/spec_id`, "a recipe id"),
      recipe: Object.freeze({
        normal_form_hash: matching(
          NORMAL_FORM_HASH,
          recipe["normal_form_hash"],
          `${pointer}/spec/recipe/normal_form_hash`,
          "a normal form hash",
        ),
        replay_key: matching(
          REPLAY_KEY,
          recipe["replay_key"],
          `${pointer}/spec/recipe/replay_key`,
          "a replay key",
        ),
      }),
    }),
    contentVersion: matching(
      DERIVED_VERSION,
      member["content_version"],
      `${pointer}/content_version`,
      "a derived version",
    ),
    outputDigest: matching(
      OUTPUT_DIGEST,
      member["output_digest"],
      `${pointer}/output_digest`,
      "an output digest",
    ),
    roots: uniqueItems(member["roots"], `${pointer}/roots`, loadRoot, true),
    executionIdentity: matching(
      EXECUTION_IDENTITY,
      member["execution_identity"],
      `${pointer}/execution_identity`,
      "an execution identity",
    ),
    resolvedPeriods: uniqueItems(
      member["resolved_periods"],
      `${pointer}/resolved_periods`,
      loadResolvedPeriod,
      false,
    ),
    ...loadArtifact(member["artifact"], `${pointer}/artifact`),
  });
}

/** The items of a stored array, each loaded, frozen, and none repeated. Items compare by their
 *  JSON, which holds the same keys in the same order for every item one loader returns. */
function uniqueItems<TItem>(
  value: unknown,
  pointer: string,
  load: (item: unknown, pointer: string) => TItem,
  nonEmpty: boolean,
): readonly TItem[] {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    throw invalid(pointer, nonEmpty ? "not a non-empty array" : "not an array");
  }
  const seen = new Set<string>();
  const items = value.map((item: unknown, index) => {
    const loaded = load(item, `${pointer}/${index}`);
    const key = JSON.stringify(loaded);
    if (seen.has(key)) throw invalid(`${pointer}/${index}`, "repeated");
    seen.add(key);
    return Object.freeze(loaded);
  });
  return Object.freeze(items);
}

function loadRoot(value: unknown, pointer: string): Root {
  const root = objectAt(value, pointer);
  checkKeys(root, pointer, ["spec_id", "content_version", "rendering"]);
  return {
    specId: matching(SPEC_ID, root["spec_id"], `${pointer}/spec_id`, "a spec id"),
    contentVersion: matching(
      CONTENT_VERSION,
      root["content_version"],
      `${pointer}/content_version`,
      "a content version",
    ),
    rendering: Object.freeze(loadRendering(root["rendering"], `${pointer}/rendering`)),
  };
}

function loadResolvedPeriod(value: unknown, pointer: string): ResolvedPeriod {
  const period = objectAt(value, pointer);
  checkKeys(period, pointer, ["anchor", "offset", "rule", "period"]);
  if (period["anchor"] !== "latest") throw invalid(`${pointer}/anchor`, 'not "latest"');
  const offset = period["offset"];
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset > 0) {
    throw invalid(`${pointer}/offset`, "not an integer of 0 or below");
  }
  if (period["rule"] !== "half1") throw invalid(`${pointer}/rule`, 'not "half1"');
  return {
    anchor: "latest",
    offset,
    rule: "half1",
    period: matching(PERIOD, period["period"], `${pointer}/period`, "a year"),
  };
}

/** A deep copy of a definition, frozen at every level, so a later change to the value the ref
 *  was loaded from, or through the ref, leaves the ref as loaded.
 *
 * @throws {FormatError} The definition holds a value JSON cannot hold, such as a function.
 */
function frozenCopy<T extends object>(value: T, pointer: string): T {
  let copy: T;
  try {
    copy = structuredClone(value);
  } catch (error) {
    throw Object.assign(invalid(pointer, "not JSON"), { cause: error });
  }
  return deepFreeze(copy);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function loadRendering(value: unknown, pointer: string): Rendering {
  const rendering = objectAt(value, pointer);
  checkKeys(rendering, pointer, ["format", "bundle"], ["layout", "without_party_totals"]);
  const { format, bundle, layout } = rendering;
  if (!isFormat(format)) {
    throw invalid(`${pointer}/format`, "not csv, xlsx or parquet");
  }
  if (typeof bundle !== "boolean") {
    throw invalid(`${pointer}/bundle`, "not a boolean");
  }
  if (layout !== undefined && layout !== "frame") {
    throw invalid(`${pointer}/layout`, 'not "frame"');
  }
  const cut = Object.hasOwn(rendering, "without_party_totals");
  if (cut && rendering["without_party_totals"] !== true) {
    throw invalid(`${pointer}/without_party_totals`, "not true");
  }
  return {
    format,
    bundle,
    ...(layout === undefined ? {} : { layout }),
    ...(cut ? { without_party_totals: true } : {}),
  };
}
