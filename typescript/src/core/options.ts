/**
 * The check every public options object passes before a call reads it: an object, or null or
 * undefined for none, holding no key outside its type's own.
 *
 * Each options type declares its keys once, as an `OptionKeys` literal, which the compiler
 * holds to the type: a key the type adds and the literal lacks, or a key the literal names and
 * the type lacks, fails the build. A key outside the set raises `InvalidRequestError`
 * (`invalid_argument`) naming the nearest key, compared in lower case with `_` and `-` dropped,
 * so the Python spelling `party_totals` finds `partyTotals`. An option's old spelling names the
 * option that replaced it, with what that option's default does.
 */
import { capped, clientError } from "./errors.ts";
import { isRecord } from "./json.ts";
import { nearest } from "./nearest.ts";

/** Every key of an options type, each marked true. */
export type OptionKeys<T> = { readonly [K in keyof T]-?: true };

/** A call's options type: the call as a refusal names it, and the keys it takes, as a list and
 *  as a set. */
export type DeclaredOptions<T> = {
  readonly call: string;
  readonly keys: readonly (keyof T & string)[];
  readonly taken: ReadonlySet<string>;
};

/** The options of `call`, from the literal that lists `T`'s keys. */
export function declareOptions<T>(call: string, keys: OptionKeys<T>): DeclaredOptions<T> {
  const names = Object.keys(keys) as (keyof T & string)[];
  return Object.freeze({ call, keys: Object.freeze(names), taken: new Set<string>(names) });
}

/** A key as it compares with another: lower case, with `_` and `-` dropped. */
const keyFold = (key: string): string => key.toLowerCase().replace(/[_-]/g, "");

/** Options that replaced another, keyed by the old one's folded spelling, with the sentence
 *  that says what the new one's default does. `withoutPartyTotals: true` was the old way to
 *  ask for what `partyTotals` now does by default, so the hint says so. */
const RENAMED: ReadonlyMap<string, { readonly key: string; readonly note: string }> = new Map([
  [
    keyFold("withoutPartyTotals"),
    {
      key: "partyTotals",
      note: "It is false by default, which leaves party totals out; true keeps them.",
    },
  ],
]);

/**
 * The options a call reads, `{}` for null or undefined.
 *
 * @throws {InvalidRequestError} The options are not an object, or hold a key the call does not
 *   take (`invalid_argument`).
 */
export function checkOptions<T extends object>(
  { call, keys, taken }: DeclaredOptions<T>,
  options: T | null | undefined,
): T {
  // An options type has only optional members, so `{}` is one.
  if (options === null || options === undefined) return {} as T;
  if (!isRecord(options)) {
    throw clientError("invalid_argument", {
      detail: `${call} takes an options object, not ${shown(options)}.`,
    });
  }
  const unknown = Object.keys(options).find((key) => !taken.has(key));
  if (unknown === undefined) return options;
  const named = `${call} has no option ${JSON.stringify(capped(unknown))}`;
  const renamed = RENAMED.get(keyFold(unknown));
  if (renamed !== undefined && taken.has(renamed.key)) {
    throw clientError("invalid_argument", {
      detail: `${named}; did you mean ${JSON.stringify(renamed.key)}? ${renamed.note}`,
    });
  }
  const near = nearest(unknown, keys, keyFold);
  throw clientError("invalid_argument", {
    detail:
      near === undefined
        ? `${named}; its options are ${keys.join(", ")}.`
        : `${named}; did you mean ${JSON.stringify(near)}?`,
  });
}

function shown(value: unknown): string {
  if (typeof value === "function") return "a function";
  if (Array.isArray(value)) return "an array";
  return capped(String(typeof value === "string" ? JSON.stringify(value) : value));
}
