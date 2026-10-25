/**
 * The DFO wire types, generated from the served OpenAPI document in `contract/served/openapi.json`.
 * Every schema has an alias named after it, with `Operation`, the computation a Search question
 * asks for, named `RequestedOperation`. String enums are open unions, so a value the server adds
 * still typechecks. Part `status` stays closed, so it narrows `KnownPart`.
 */
export type * from "./generated/openapi.ts";
export type { UnknownPart } from "./core/unknown-part.ts";

import type {
  CandidatesPart,
  DefinitePart,
  NoDataPart,
  UnsupportedPart,
  components,
} from "./generated/openapi.ts";
import type { UnknownPart } from "./core/unknown-part.ts";

/** A part whose status this release knows. Its `status` narrows it. */
export type KnownPart = DefinitePart | CandidatesPart | NoDataPart | UnsupportedPart;

/** One part of a resolution, as `Resolution["parts"]` holds it. */
export type Part = KnownPart | UnknownPart;

/** A warning the server attached to an answer, a part or a dataset: its registry code, its
 *  severity and its message. `severity` is a `Severity` for Search; the datasets surface may send
 *  others. */
export type Notice = components["schemas"]["Warning"];
