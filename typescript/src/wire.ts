/**
 * The DFO wire types, generated from the served OpenAPI document in `contract/served/openapi.json`.
 * Every schema has an alias named after it, with `Operation`, the computation a Search question
 * asks for, named `RequestedOperation`. String enums are open unions, so a value the server adds
 * still typechecks. Part `status` stays closed, so it narrows `KnownPart`.
 */
export type * from "./generated/openapi.ts";
export type { UnknownPart } from "./unknown-part.ts";

import type {
  CandidatesPart,
  DefinitePart,
  NoDataPart,
  UnsupportedPart,
} from "./generated/openapi.ts";
import type { UnknownPart } from "./unknown-part.ts";

/** A part whose status this release knows. Its `status` narrows it. */
export type KnownPart = DefinitePart | CandidatesPart | NoDataPart | UnsupportedPart;

/** One part of a resolution, as `Resolution["parts"]` holds it. */
export type Part = KnownPart | UnknownPart;
