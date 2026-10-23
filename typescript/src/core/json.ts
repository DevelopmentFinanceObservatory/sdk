/** True for a non-null, non-array object, the shape of a JSON object. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A JSON array, or an empty one when the value is not an array. */
export const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

/** The objects of a JSON array, skipping any item that is not one, or an empty array when the
 *  value is not an array. */
export const objects = (value: unknown): Record<string, unknown>[] => list(value).filter(isRecord);

/** A JSON string, or null when the value is not one. */
export const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** The deepest nesting `parseJson` reads. The deepest response body recorded under
 *  contract/scenarios nests 14 levels, so 256 leaves over 18 times that as headroom. `JSON.parse`
 *  itself reads any depth, but the client walks a parsed body recursively, as when it redacts
 *  the key from a refusal, and that recursion overflows the call stack at a depth that depends
 *  on the platform. */
export const JSON_MAX_DEPTH = 256;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN = new Set([0x5b, 0x7b]);
const CLOSE = new Set([0x5d, 0x7d]);

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
    } else if (OPEN.has(char)) {
      if (++depth > JSON_MAX_DEPTH) return true;
    } else if (CLOSE.has(char)) {
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
