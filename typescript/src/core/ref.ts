/**
 * The `DatasetRef` format every DFO client writes and reads, fixed by
 * `contract/dataset-ref.schema.json`, so a ref saved by one language loads in another.
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

/** A ref as JSON, in the stored format. */
export type DatasetRefJson = {
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

const FORMAT_VERSION = 1;
const SPEC_ID = /^spec_[0-9a-f]{32}$/;
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

/** A rendering as a build request's `options` take it: format, bundle, layout, and
 *  `without_party_totals`, sent only when true, as the server records it. */
export function mintOptions(rendering: Rendering): Record<string, string | boolean> {
  const options: Record<string, string | boolean> = {
    format: rendering.format,
    bundle: rendering.bundle,
  };
  if (rendering.layout !== undefined) options["layout"] = rendering.layout;
  if (rendering.without_party_totals === true) options["without_party_totals"] = true;
  return options;
}

/** The query keys a version's file selector reads. */
const SELECTOR_QUERY_KEYS = ["format", "bundle", "layout"] as const;

/** The file selector's query for a rendering: its build options among `SELECTOR_QUERY_KEYS`,
 *  layout only when set. The selector serves a stored version, which is already the
 *  party-totals cut or the plain version, and refuses any other key as `request_invalid`. */
export function selectorQuery(rendering: Rendering): URLSearchParams {
  const options = mintOptions(rendering);
  return new URLSearchParams(
    SELECTOR_QUERY_KEYS.filter((key) => key in options).map((key) => [key, String(options[key])]),
  );
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

/** The exact versions a dataset holds. `JSON.stringify(ref)` writes the stored format,
 *  `DatasetRef.fromJSON` reads one written by any DFO client, `client.fetch(ref)` fetches those
 *  versions, and `client.fetch(ref, { latest: true })` the newest versions of its specs. */
export class DatasetRef {
  readonly members: readonly RefMember[];

  constructor(members: readonly RefMember[]) {
    this.members = Object.freeze([...members]);
  }

  /**
   * Whether `other` is a ref to the same specs at the same versions in the same renderings, in
   * order. Digests, sentences and part labels are left out, since a version rendered again
   * holds the same data under another digest.
   */
  equals(other: unknown): boolean {
    if (!(other instanceof DatasetRef) || other.members.length !== this.members.length) {
      return false;
    }
    return this.members.every((member, index) => {
      const theirs = other.members[index]!;
      return (
        member.spec.spec_id === theirs.spec.spec_id &&
        member.contentVersion === theirs.contentVersion &&
        sameRendering(member.rendering, theirs.rendering)
      );
    });
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

  /** The ref in the stored format. */
  toJSON(): DatasetRefJson {
    return {
      format_version: FORMAT_VERSION,
      members: this.members.map((member) => ({
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
    if (ref["format_version"] !== FORMAT_VERSION) {
      throw invalid("/format_version", `not ${FORMAT_VERSION}`);
    }
    const members = ref["members"];
    if (!Array.isArray(members) || members.length === 0) {
      throw invalid("/members", "not a non-empty array");
    }
    const loaded = members.map((member: unknown, index) => loadMember(member, `/members/${index}`));
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

function loadMember(value: unknown, pointer: string): RefMember {
  const member = objectAt(value, pointer);
  checkKeys(member, pointer, ["parts", "sentence", "spec", "content_version", "artifact"]);
  const parts = member["parts"];
  if (!Array.isArray(parts) || !parts.every(isText)) {
    throw new FormatError(
      "format_invalid",
      `${pointer}/parts`,
      "not an array of non-empty strings",
    );
  }
  const sentence = member["sentence"];
  if (!isText(sentence)) {
    throw invalid(`${pointer}/sentence`, "not a non-empty string");
  }

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
  const artifact = objectAt(member["artifact"], `${pointer}/artifact`);
  checkKeys(artifact, `${pointer}/artifact`, ["digest", "rendering"]);
  const digest = matching(DIGEST, artifact["digest"], `${pointer}/artifact/digest`, "a digest");
  return Object.freeze({
    parts: Object.freeze([...parts]),
    sentence,
    spec: Object.freeze({
      spec_id: specId,
      definition: frozenCopy(definition, `${pointer}/spec/definition`),
    }),
    contentVersion,
    digest,
    rendering: Object.freeze(loadRendering(artifact["rendering"], `${pointer}/artifact/rendering`)),
  });
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
