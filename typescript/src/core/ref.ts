/**
 * The `DatasetRef` format every DFO client writes and reads, fixed by
 * `contract/dataset-ref.schema.json`, so a ref saved by one language loads in another.
 */

import { clientError } from "./errors.ts";
import { isRecord } from "./json.ts";

/** The layouts a dataset comes in: the labelled long table, or the pipeline frame. */
export type Layout = "long" | "frame";

/** Which rendering of a version an artifact is, as a ref stores it: the selector triple of
 *  format, bundle and layout. */
export type Rendering = {
  readonly format: "csv" | "xlsx" | "parquet";
  readonly bundle: boolean;
  readonly layout?: "frame";
};

/** A spec as the client holds it: the server's id and its definition, unmodified, because the
 *  server needs the definition's `identity` back as it sent it. */
export type SpecLike = {
  readonly spec_id: string;
  readonly definition: Readonly<Record<string, unknown>>;
};

/** One member of a ref: the exact version of one reading. */
export type RefMember = {
  /** The variable text of each answer part the member answers, in query order; empty for a
   *  spec fetched outside an answer. */
  readonly parts: readonly string[];
  /** Search's sentence for the built identity. */
  readonly sentence: string;
  readonly spec: SpecLike;
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
    artifact: { digest: string; rendering: { format: string; bundle: boolean; layout?: "frame" } };
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

const FORMAT_VERSION = 1;
const SPEC_ID = /^spec_[0-9a-f]{32}$/;
const CONTENT_VERSION = /^cv_[0-9a-f]{32}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const FORMATS: readonly string[] = ["csv", "xlsx", "parquet"];
const isFormat = (value: unknown): value is Rendering["format"] =>
  typeof value === "string" && FORMATS.includes(value);

/**
 * The bare Parquet rendering both clients build for a layout.
 *
 * @throws {InvalidRequestError} The layout is neither `long` nor `frame` (`invalid_argument`).
 */
export function renderingFor(layout: Layout): Rendering {
  switch (layout) {
    case "long":
      return { format: "parquet", bundle: false };
    case "frame":
      return { format: "parquet", bundle: false, layout: "frame" };
    default:
      throw clientError("invalid_argument", {
        detail: `layout is "long" or "frame", not ${JSON.stringify(layout satisfies never)}.`,
      });
  }
}

/** The layout a rendering holds. */
export const layoutOf = (rendering: Rendering): Layout =>
  rendering.layout === "frame" ? "frame" : "long";

/** The build request's `options`, and the file selector's query, for a rendering. */
export function renderingOptions(rendering: Rendering): Record<string, string | boolean> {
  const options: Record<string, string | boolean> = {
    format: rendering.format,
    bundle: rendering.bundle,
  };
  if (rendering.layout !== undefined) options["layout"] = rendering.layout;
  return options;
}

/** Whether a manifest artifact's rendering object is this rendering. The server's object
 *  carries more members, such as the long layout's version, so it matches on format, bundle
 *  and whether its layout is the frame. */
export function renderingMatches(rendering: Rendering, served: unknown): boolean {
  if (!isRecord(served)) return false;
  return (
    served["format"] === rendering.format &&
    served["bundle"] === rendering.bundle &&
    (served["layout"] === "frame") === (rendering.layout === "frame")
  );
}

/** The exact versions a dataset holds. `JSON.stringify(ref)` writes the stored format, and
 *  `DatasetRef.fromJSON` reads one written by any DFO client. */
export class DatasetRef {
  readonly members: readonly RefMember[];

  constructor(members: readonly RefMember[]) {
    this.members = Object.freeze([...members]);
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
        parsed = JSON.parse(value);
      } catch (error) {
        throw Object.assign(new FormatError("format_invalid", "", "not JSON"), { cause: error });
      }
    }
    const ref = objectAt(parsed, "");
    checkKeys(ref, "", ["format_version", "members"], []);
    if (ref["format_version"] !== FORMAT_VERSION) {
      throw new FormatError("format_invalid", "/format_version", `not ${FORMAT_VERSION}`);
    }
    const members = ref["members"];
    if (!Array.isArray(members) || members.length === 0) {
      throw new FormatError("format_invalid", "/members", "not a non-empty array");
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
  if (!isRecord(value)) throw new FormatError("format_invalid", pointer, "not an object");
  return value;
}

function checkKeys(
  value: Record<string, unknown>,
  pointer: string,
  required: readonly string[],
  optional: readonly string[],
): void {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new FormatError("format_invalid", `${pointer}/${key}`, "missing");
    }
  }
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw new FormatError("format_invalid", `${pointer}/${key}`, "not a member of the format");
    }
  }
}

const isText = (value: unknown): value is string => typeof value === "string" && value !== "";

function matching(pattern: RegExp, value: unknown, pointer: string, what: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new FormatError("format_invalid", pointer, `not ${what}`);
  }
  return value;
}

function loadMember(value: unknown, pointer: string): RefMember {
  const member = objectAt(value, pointer);
  checkKeys(member, pointer, ["parts", "sentence", "spec", "content_version", "artifact"], []);
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
    throw new FormatError("format_invalid", `${pointer}/sentence`, "not a non-empty string");
  }

  const spec = objectAt(member["spec"], `${pointer}/spec`);
  checkKeys(spec, `${pointer}/spec`, ["spec_id", "definition"], []);
  const specId = matching(SPEC_ID, spec["spec_id"], `${pointer}/spec/spec_id`, "a spec id");
  const definition = objectAt(spec["definition"], `${pointer}/spec/definition`);
  if (definition["schema_version"] !== 1) {
    throw new FormatError("format_invalid", `${pointer}/spec/definition/schema_version`, "not 1");
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
  checkKeys(artifact, `${pointer}/artifact`, ["digest", "rendering"], []);
  const digest = matching(DIGEST, artifact["digest"], `${pointer}/artifact/digest`, "a digest");
  return {
    parts: Object.freeze([...parts]),
    sentence,
    spec: { spec_id: specId, definition },
    contentVersion,
    digest,
    rendering: loadRendering(artifact["rendering"], `${pointer}/artifact/rendering`),
  };
}

function loadRendering(value: unknown, pointer: string): Rendering {
  const rendering = objectAt(value, pointer);
  checkKeys(rendering, pointer, ["format", "bundle"], ["layout"]);
  const { format, bundle, layout } = rendering;
  if (!isFormat(format)) {
    throw new FormatError("format_invalid", `${pointer}/format`, "not csv, xlsx or parquet");
  }
  if (typeof bundle !== "boolean") {
    throw new FormatError("format_invalid", `${pointer}/bundle`, "not a boolean");
  }
  if (layout !== undefined && layout !== "frame") {
    throw new FormatError("format_invalid", `${pointer}/layout`, 'not "frame"');
  }
  const selector = { format, bundle };
  return layout === undefined ? selector : { ...selector, layout };
}
