/**
 * A part whose `status` this release of the client does not know, or that lacks a member the
 * client checks for its status. Its members pass through untouched and are not checked. No
 * TypeScript type is a string other than the known statuses, so a `switch` on the status of a
 * part that may be unknown does not narrow. `isKnownPart` separates the two first.
 */
export type UnknownPart = {
  status: string;
  [member: string]: unknown;
};
