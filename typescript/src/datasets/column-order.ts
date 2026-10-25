/**
 * The order a dataset presents its columns in, by the contract's column-order rule
 * (`contract/rules/column-order.json`): each reading slot filled by the first of its names the
 * table holds, in slot order, then every other column in the order the server wrote it, with
 * `stat_var` last. The order moves columns and changes no value.
 */

import { READING_COLUMNS } from "../generated/column-order.ts";

/** The column every table puts last: the long dcid of the statistical variable. */
const STAT_VAR = "stat_var";

/** Column names in reading order. */
export function readingOrder(names: readonly string[]): string[] {
  const held = new Set(names);
  const lead = READING_COLUMNS.flatMap((slot) => slot.find((name) => held.has(name)) ?? []);
  const led = new Set<string>(lead);
  const rest = names.filter((name) => !led.has(name) && name !== STAT_VAR);
  return [...lead, ...rest, ...(held.has(STAT_VAR) ? [STAT_VAR] : [])];
}
