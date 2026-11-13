/**
 * The parts of a Search answer as `Answer.parts` gives them. A part keeps the type of each member
 * the client checks, the ones `contract/strict-fields.json` lists: `status` and the member it
 * names (`spec`, `candidates.specs`, `no_data.reason` or `unsupported.code`), and within a spec
 * its `spec_id`, `definition.spec_id`, `definition.identity` and `resolved`. Every other member
 * is `unknown`, since the client passes it on as the server sent it. Read
 * assumptions, departures, operations and warnings from `answer.facts`, which reads them through
 * `partFacts`. The wire schemas are in `@developmentfinance/client/wire`.
 */
import { STRICT_ENUMS, STRICT_SCHEMAS } from "../generated/strict.ts";
import { text } from "./json.ts";
import { conforms } from "./strict.ts";
import type { StrictSchema } from "./strict.ts";
import type { UnknownPart } from "./unknown-part.ts";
import type { components } from "../generated/openapi.ts";

/** A part that holds a reading. */
export type DefinitePart = {
  readonly status: "definite";
  /** The reading. The client checks its `spec_id`, its `definition`'s `spec_id` and `identity`,
   *  and that `resolved` is an object. Every other member, the members of `resolved` among
   *  them, is `unknown`. `client.fetch` takes it as it is. */
  readonly spec: {
    readonly spec_id: string;
    readonly definition: {
      readonly spec_id: string;
      readonly identity: Readonly<Record<string, unknown>>;
      readonly [member: string]: unknown;
    };
    /** Search's reading of the spec. Its members are unchecked. */
    readonly resolved: Readonly<Record<string, unknown>>;
    readonly [member: string]: unknown;
  };
  /** Unchecked. Read assumptions, departures, operations and warnings from `answer.facts`. */
  readonly [member: string]: unknown;
};

/** A part with several readings, one of which a choice settles. */
export type CandidatesPart = {
  readonly status: "candidates";
  readonly candidates: {
    /** Each reading, checked as a definite part's `spec` is. */
    readonly specs: readonly DefinitePart["spec"][];
    readonly [member: string]: unknown;
  };
  /** Unchecked. Read assumptions, departures, operations and warnings from `answer.facts`. */
  readonly [member: string]: unknown;
};

/** A part Search found no data for, with the reason. */
export type NoDataPart = {
  readonly status: "no_data";
  readonly no_data: {
    readonly reason: components["schemas"]["NoData"]["reason"];
    readonly [member: string]: unknown;
  };
  /** Unchecked. Read assumptions, departures, operations and warnings from `answer.facts`. */
  readonly [member: string]: unknown;
};

/** A part asking for something Search does not support, with the code. */
export type UnsupportedPart = {
  readonly status: "unsupported";
  readonly unsupported: { readonly code: string; readonly [member: string]: unknown };
  /** Unchecked. Read assumptions, departures, operations and warnings from `answer.facts`. */
  readonly [member: string]: unknown;
};

/** A part whose status this release knows and that holds the members the client checks. Its
 *  `status` narrows it. */
export type KnownPart = DefinitePart | CandidatesPart | NoDataPart | UnsupportedPart;

/** One part of an answer, as `Answer.parts` holds it. */
export type Part = KnownPart | UnknownPart;

export type { UnknownPart };

/** The part statuses this release knows, from `contract/strict-fields.json`. */
export const PART_STATUSES: readonly KnownPart["status"][] = [
  ...STRICT_ENUMS.DefinitePart.status,
  ...STRICT_ENUMS.CandidatesPart.status,
  ...STRICT_ENUMS.NoDataPart.status,
  ...STRICT_ENUMS.UnsupportedPart.status,
];

/** The strict schema of each known part status. */
const PART_SCHEMAS: Readonly<Record<string, StrictSchema>> =
  STRICT_SCHEMAS.Resolution.children.parts.items.mapping;

/**
 * True for a part whose status this release knows and that holds each member the client checks
 * for that status as its JSON type, down to a spec's `spec_id`, `definition` and `resolved`. Such
 * a part then narrows on `status`. Every part of an answer from `client.search` whose status is
 * known passes, since the client checks the same members when it reads the response.
 */
export function isKnownPart(part: Part): part is KnownPart {
  const schema = Object.hasOwn(PART_SCHEMAS, part.status) ? PART_SCHEMAS[part.status] : undefined;
  return schema !== undefined && conforms(schema, part);
}

/** A part's variable text, or null when the part holds none or holds a value that is not a
 *  string. */
export const partText = (part: Part): string | null => text(part.variable_text);

/** The sentence a part reads as: its spec's for a definite part, else its own. */
export function partSentence(part: Part): string | null {
  if (isKnownPart(part) && part.status === "definite") {
    return text(part.spec.resolved.rendered_sentence);
  }
  return text(part.rendered_sentence);
}

/** The definite parts, in order. */
export function definiteParts(parts: readonly Part[]): DefinitePart[] {
  return parts.filter(
    (part): part is DefinitePart => isKnownPart(part) && part.status === "definite",
  );
}
