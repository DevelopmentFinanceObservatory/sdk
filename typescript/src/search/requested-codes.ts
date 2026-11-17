/**
 * The series code each part of an answer was asked by, for an answer to a search by codes. The
 * answer sets them once, and its gaps, its JSON, its choices and its text read them, without a
 * public member.
 */
const CODES = new WeakMap<object, readonly string[]>();

/** Records the codes an answer's parts were asked by, one per part in part order. */
export function setRequestedCodes(answer: object, codes: readonly string[]): void {
  CODES.set(answer, codes);
}

/** The codes an answer's parts were asked by; null for an answer to a question in words. */
export function requestedCodes(answer: object): readonly string[] | null {
  return CODES.get(answer) ?? null;
}
