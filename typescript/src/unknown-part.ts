/**
 * A part whose `status` this release of the client does not know. Its members pass through
 * untouched. No TypeScript type is a string other than the known statuses, so a `switch` on the
 * status of a part that may be unknown does not narrow. `isKnownPart` separates the two first.
 */
export type UnknownPart = {
  status: string;
  variable_text?: string | null;
  [member: string]: unknown;
};
