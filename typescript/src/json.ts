/** True for a JSON object: a non-null, non-array object. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A JSON array, or an empty one when the value is not an array. */
export const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

/** The objects of a JSON array, skipping any item that is not one; empty when the value is not
 *  an array. */
export const objects = (value: unknown): Record<string, unknown>[] => list(value).filter(isRecord);

/** A JSON string, or null when the value is not one. */
export const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
