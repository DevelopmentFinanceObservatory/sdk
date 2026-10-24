/** True for a non-null, non-array object, the shape of a JSON object. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A JSON array, or an empty one when the value is not an array. */
export const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

/** The objects of a JSON array, skipping any item that is not one, or an empty array when the
 *  value is not an array. */
export const objects = (value: unknown): Record<string, unknown>[] => list(value).filter(isRecord);

/** The strings of a JSON array, skipping any item that is not one, or an empty array when the
 *  value is not an array. */
export const strings = (value: unknown): string[] =>
  list(value).filter((item): item is string => typeof item === "string");

/** A JSON string, or null when the value is not one. */
export const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** The members of `fields` whose value is not undefined, for an object whose optional members
 *  are left out when they hold nothing. */
export const present = <T extends Record<string, unknown>>(
  fields: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };

/** The deepest nesting `parseJson` reads. The deepest response body recorded under
 *  contract/scenarios nests 14 levels, so 256 leaves over 18 times that as headroom. `JSON.parse`
 *  itself reads any depth, but the client walks a parsed body recursively, as when it redacts
 *  the key from a refusal, and that recursion overflows the call stack at a depth that depends
 *  on the platform. */
export const JSON_MAX_DEPTH = 256;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_ARRAY = 0x5b;
const OPEN_OBJECT = 0x7b;
const CLOSE_ARRAY = 0x5d;
const CLOSE_OBJECT = 0x7d;

/** Whether `text` opens more than `JSON_MAX_DEPTH` arrays or objects at once, counting only the
 *  brackets outside strings. */
function tooDeep(text: string): boolean {
  if (text.length <= JSON_MAX_DEPTH) return false;
  let depth = 0;
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text.charCodeAt(index);
    if (inString) {
      if (char === BACKSLASH) index++;
      else if (char === QUOTE) inString = false;
    } else if (char === QUOTE) {
      inString = true;
    } else if (char === OPEN_ARRAY || char === OPEN_OBJECT) {
      if (++depth > JSON_MAX_DEPTH) return true;
    } else if (char === CLOSE_ARRAY || char === CLOSE_OBJECT) {
      depth--;
    }
  }
  return false;
}

/**
 * `JSON.parse(text)`, refusing text nested deeper than `JSON_MAX_DEPTH` before it is parsed.
 *
 * @throws {SyntaxError} The text is not JSON, or is nested too deeply.
 */
export function parseJson(text: string): unknown {
  if (tooDeep(text)) throw new SyntaxError(`nested deeper than ${JSON_MAX_DEPTH} levels`);
  return JSON.parse(text) as unknown;
}
