import { STRICT_ENUMS } from "./generated/strict.ts";
import { text } from "./json.ts";
import type { KnownPart, Part } from "./wire.ts";

/** The part statuses this release knows, from `contract/strict-fields.json`. */
export const PART_STATUSES: readonly KnownPart["status"][] = [
  ...STRICT_ENUMS.DefinitePart.status,
  ...STRICT_ENUMS.CandidatesPart.status,
  ...STRICT_ENUMS.NoDataPart.status,
  ...STRICT_ENUMS.UnsupportedPart.status,
];

/** True for a part whose status this release knows, which then narrows on `status`. */
export function isKnownPart(part: Part): part is KnownPart {
  return (PART_STATUSES as readonly string[]).includes(part.status);
}

/** A part's variable text, or null when the part holds none or holds a value that is not a
 *  string. */
export const partText = (part: Part): string | null => text(part.variable_text);
