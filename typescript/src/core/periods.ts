/**
 * Years stated relative to the newest year the data holds.
 *
 * `latestYear(offset)` names a year counted back from the newest year at least half the series
 * hold, the rule DFO calls `half1`. DFO settles it each time a recipe runs, so a recipe over
 * `[latestYear(-4), latestYear()]` moves forward when a source publishes a new year. A recipe
 * sends it as `{ anchor: "latest", offset }`, and a derived member's `resolvedPeriods` records
 * the year each offset settled on.
 */

import { clientError } from "./errors.ts";
import { quoted } from "./text.ts";

/** The furthest back an offset reaches, as DFO's operations accept it. */
const MIN_OFFSET = -9999;

/** The years an operation takes as a calendar year. */
const FIRST_YEAR = 1000;
const LAST_YEAR = 9999;

/** A year counted back from the newest year at least half the series hold. `latestYear` makes
 *  one. */
export class LatestYear {
  /** Years before the newest, 0 or below: 0 is the newest year and -1 the year before it. */
  readonly offset: number;

  /** @internal `latestYear(offset)` checks the offset and makes one. */
  constructor(offset: number) {
    this.offset = offset;
    Object.freeze(this);
  }

  /** The call that makes it, as `latestYear(-4)` or `latestYear()`. */
  toString(): string {
    return this.offset === 0 ? "latestYear()" : `latestYear(${this.offset})`;
  }

  /** Node's `console.log` and `util.inspect` show it as `String(year)` does. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}

/**
 * A year counted back from the newest year at least half the series hold. DFO settles the year
 * each time the recipe that holds it runs, so `[latestYear(-9), latestYear()]` stays the last
 * ten years as sources publish. It is accepted wherever an operation takes a year.
 *
 * @param offset Years before the newest, 0 or below; 0 by default.
 * @throws {InvalidRequestError} `offset` is not an integer from -9999 to 0
 *   (`invalid_argument`).
 */
export function latestYear(offset: number = 0): LatestYear {
  if (!Number.isInteger(offset) || offset < MIN_OFFSET || offset > 0) {
    throw clientError("invalid_argument", {
      detail:
        "latestYear takes an offset from -9999 to 0 years before the newest, such as " +
        `latestYear(-4), not ${shown(offset)}.`,
    });
  }
  // -0 is 0, so the request sends 0.
  return new LatestYear(offset === 0 ? 0 : offset);
}

/** A latest year as an operation's argument names it. */
type RollingYear = { readonly anchor: "latest"; readonly offset: number };

/**
 * `year` as an operation's argument: a four-digit year as text, or a latest year as its rolling
 * reference.
 *
 * @throws {InvalidRequestError} `year` is neither an integer from 1000 to 9999 nor a
 *   `latestYear(...)` (`invalid_argument`). `name` names the argument.
 */
export function periodObject(year: unknown, name: string): string | RollingYear {
  if (year instanceof LatestYear) {
    // Typed apart from the string the function also returns, whose prototype has an `anchor`.
    const rolling: RollingYear = { anchor: "latest", offset: year.offset };
    return rolling;
  }
  if (Number.isInteger(year) && (year as number) >= FIRST_YEAR && (year as number) <= LAST_YEAR) {
    return String(year);
  }
  throw clientError("invalid_argument", {
    detail: `${name} holds years such as 2020 or latestYear(-4), not ${shown(year)}.`,
  });
}

/** A value as a refusal quotes it. */
const shown = (value: unknown): string =>
  value instanceof LatestYear ? String(value) : quoted(value);
