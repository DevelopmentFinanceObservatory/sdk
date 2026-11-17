/**
 * A spec's conversion offer: the currencies, years and base years its values convert to, which
 * Search states as `resolved.unit_conversion` on a spec it resolved. `client.fetch(spec, {
 * currency })` and `answer.fetch({ currency })` ask for one of them.
 */
import { capped, clientError } from "./errors.ts";
import type { ContractError } from "./errors.ts";
import { isRecord } from "./json.ts";
import type { Spec } from "./ref.ts";

/** One currency a spec converts to, and the years each price basis converts. */
export type ConversionCurrency = {
  /** The ISO 4217 code `currency` takes, such as `"EUR"`. */
  readonly code: string;
  /** The plural noun the sentence names the currency by, such as `"euros"`. */
  readonly noun: string;
  /** The first and last years a current-price fetch shows, within the years the spec as held
   *  serves; null when no year converts. A wider or narrower `window` serves other years. */
  readonly currentYears: readonly [startYear: number, endYear: number] | null;
  /** The first and last years a constant-price fetch shows, read as `currentYears` is. */
  readonly constantYears: readonly [startYear: number, endYear: number] | null;
  /** The first and last base years a constant-price fetch takes; null when none converts. */
  readonly baseYears: readonly [first: number, last: number] | null;
};

/** The conversions a spec offers. */
export type UnitConversion = {
  /** Each currency the spec converts to, sorted by code as Search sends them. */
  readonly currencies: readonly ConversionCurrency[];
  /** The base year the conversion tables declare as their default. A constant-price fetch still
   *  names its `baseYear`; this is the year to pass when the caller has no other. */
  readonly defaultBaseYear: number;
};

const POINTER = "/resolved/unit_conversion";

/**
 * The conversions a spec offers, from Search's `resolved.unit_conversion`, or null. It is null
 * when the spec carries no Search reading (`spec.resolved` is missing, as for a ref member's
 * spec or one written by hand) or when its values convert to no currency, as for a debt stock.
 * A fetch with `currency` still works on a spec with no reading: the server decides.
 *
 * ```ts
 * const offer = unitConversion(answer.specs[0]!);
 * const eur = offer?.currencies.find((currency) => currency.code === "EUR");
 * eur?.constantYears; // [2015, 2022]
 * ```
 *
 * @throws {ContractError} The offer is not one this client reads (`contract_violation`).
 */
export function unitConversion(spec: Spec): UnitConversion | null {
  const resolved: unknown = isRecord(spec) ? spec.resolved : undefined;
  const offer = isRecord(resolved) ? resolved["unit_conversion"] : undefined;
  if (offer === undefined || offer === null) return null;
  if (!isRecord(offer)) throw malformed(spec, "");
  const currencies = offer["currencies"];
  if (!Array.isArray(currencies)) throw malformed(spec, "/currencies");
  const defaultBaseYear = offer["default_base_year"];
  if (!isYear(defaultBaseYear)) throw malformed(spec, "/default_base_year");
  return Object.freeze({
    currencies: Object.freeze(
      (currencies as unknown[]).map((item, index) => currencyOf(spec, item, index)),
    ),
    defaultBaseYear,
  });
}

function currencyOf(spec: Spec, item: unknown, index: number): ConversionCurrency {
  const at = `/currencies/${index}`;
  if (!isRecord(item)) throw malformed(spec, at);
  const { code, noun } = item;
  if (typeof code !== "string" || code === "") throw malformed(spec, `${at}/code`);
  if (typeof noun !== "string") throw malformed(spec, `${at}/noun`);
  const min = item["base_year_min"] ?? null;
  const max = item["base_year_max"] ?? null;
  if ((min === null) !== (max === null)) throw malformed(spec, `${at}/base_year_max`);
  let baseYears: readonly [number, number] | null = null;
  if (min !== null) {
    if (!isYear(min)) throw malformed(spec, `${at}/base_year_min`);
    if (!isYear(max) || max < min) throw malformed(spec, `${at}/base_year_max`);
    baseYears = Object.freeze([min, max] as const);
  }
  return Object.freeze({
    code,
    noun,
    currentYears: yearsOf(spec, item["current_years"], `${at}/current_years`),
    constantYears: yearsOf(spec, item["constant_years"], `${at}/constant_years`),
    baseYears,
  });
}

/** A `TimeWindow` as a pair, or null. */
function yearsOf(spec: Spec, value: unknown, at: string): readonly [number, number] | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw malformed(spec, at);
  const start = value["start_year"];
  const end = value["end_year"];
  if (!isYear(start) || !isYear(end) || end < start) throw malformed(spec, at);
  return Object.freeze([start, end] as const);
}

const isYear = (value: unknown): value is number => Number.isSafeInteger(value);

function malformed(spec: Spec, at: string): ContractError {
  return clientError("contract_violation", {
    detail:
      `The conversion offer of ${capped(spec.spec_id)} cannot be read at ` + `${POINTER}${at}.`,
    pointer: `${POINTER}${at}`,
  });
}
