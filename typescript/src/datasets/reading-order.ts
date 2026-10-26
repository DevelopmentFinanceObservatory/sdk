/**
 * The order a dataset presents its columns and rows in, by the contract's reading-order rule
 * (`contract/rules/reading-order.json`). The columns come in four groups: each reading slot
 * filled by the first of its names the table holds, in slot order; the other columns whose
 * values differ between rows; the other columns that hold one value in every row, null
 * included; and `stat_var`. The second and third groups keep the order the server wrote them.
 * The rows of each member are sorted by the filled slots other than the value and the time
 * period, then by the varying columns in presented order, `stat_var` after them when it varies,
 * then by the time period. The order moves columns and rows and changes no value.
 */

import { READING_COLUMNS } from "../generated/reading-order.ts";

/** The column every table puts last: the long dcid of the statistical variable. */
const STAT_VAR = "stat_var";
const TIME_PERIOD = "time_period";
/** The measure, which fills a slot and is no sort key. */
const VALUE = "value";

/** A stacked column's stored values, one per row. */
export type ColumnValues = { readonly name: string; readonly values: readonly unknown[] };

/** The presented column names, and the stacked row each presented row reads. */
export type ReadingOrder = { readonly columns: readonly string[]; readonly rows: Uint32Array };

/**
 * The reading order of a stacked table: `columns` in the order the server wrote them, the
 * members' rows one after another, and `memberRows` the number of rows of each member. Which
 * columns vary is judged over the whole stacked table, where a member's rows hold null in a
 * column that member lacks; a table of no row or one row has no varying column. Rows sort
 * within their member, so the members keep their order.
 */
export function readingOrder(
  columns: readonly ColumnValues[],
  memberRows: readonly number[],
): ReadingOrder {
  const held = new Map(columns.map((column) => [column.name, column]));
  const slots = READING_COLUMNS.flatMap((slot) => slot.find((name) => held.has(name)) ?? []);
  const filled = new Set<string>(slots);
  const others = columns.filter(({ name }) => !filled.has(name) && name !== STAT_VAR);
  const varying = others.filter(({ values }) => varies(values));
  const constant = others.filter(({ values }) => !varies(values));
  const statVar = held.get(STAT_VAR);
  const names = [
    ...slots,
    ...varying.map(({ name }) => name),
    ...constant.map(({ name }) => name),
    ...(statVar === undefined ? [] : [STAT_VAR]),
  ];

  const keys = [
    ...slots
      .filter((name) => name !== VALUE && name !== TIME_PERIOD)
      .map((name) => held.get(name)!),
    ...varying,
    ...(statVar !== undefined && varies(statVar.values) ? [statVar] : []),
    ...(filled.has(TIME_PERIOD) ? [held.get(TIME_PERIOD)!] : []),
  ].map(({ values }) => values);
  const total = memberRows.reduce((sum, count) => sum + count, 0);
  const rows = Uint32Array.from({ length: total }, (_, index) => index);
  if (keys.length === 0) return { columns: names, rows };
  // Equal keys fall back to the stacked row, so the sort is stable by construction.
  const compareRows = (left: number, right: number): number => {
    for (const values of keys) {
      const order = compareValues(values[left], values[right]);
      if (order !== 0) return order;
    }
    return left - right;
  };
  let start = 0;
  for (const count of memberRows) {
    rows.subarray(start, start + count).sort(compareRows);
    start += count;
  }
  return { columns: names, rows };
}

const isMissing = (value: unknown): boolean => value === null || value === undefined;

/** Whether two stored values are the same value; null is a value like any other. */
function same(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (isMissing(left) || isMissing(right)) return false;
  if (left instanceof Uint8Array || right instanceof Uint8Array) {
    return compareValues(left, right) === 0;
  }
  return Number.isNaN(left) && Number.isNaN(right);
}

/** Whether a column holds more than one value. */
function varies(values: readonly unknown[]): boolean {
  const first = values[0];
  return values.some((value) => !same(value, first));
}

const encoder = new TextEncoder();

/** A UTF-16 code unit moved so that code units order as the code points they encode: the
 *  surrogates, which encode the code points past U+FFFF, after U+E000 to U+FFFF. */
const codePointRank = (unit: number): number =>
  unit < 0xd800 ? unit : unit < 0xe000 ? unit + 0x2000 : unit - 0x800;

/** Two strings in Unicode code point order. JavaScript's `<` compares UTF-16 code units, which
 *  put U+E000 to U+FFFF after the code points past U+FFFF. */
function compareStrings(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.charCodeAt(index);
    const b = right.charCodeAt(index);
    if (a !== b) return codePointRank(a) - codePointRank(b);
  }
  return left.length - right.length;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return left.length - right.length;
}

/**
 * Two stored values in ascending order, nulls last: numbers, `bigint`s and booleans by value,
 * NaN after every number, strings by code point, bytes bytewise. A binary column stacked from a string member holds
 * both, compared as UTF-8, whose bytewise order is code point order.
 */
export function compareValues(left: unknown, right: unknown): number {
  if (isMissing(left) || isMissing(right)) {
    return isMissing(left) === isMissing(right) ? 0 : isMissing(left) ? 1 : -1;
  }
  if (typeof left === "string" && typeof right === "string") return compareStrings(left, right);
  if (left instanceof Uint8Array || right instanceof Uint8Array) {
    const bytes = (value: unknown): Uint8Array =>
      typeof value === "string" ? encoder.encode(value) : (value as Uint8Array);
    return compareBytes(bytes(left), bytes(right));
  }
  const [a, b] = [left as number | bigint | boolean, right as number | bigint | boolean];
  if (a < b) return -1;
  if (a > b) return 1;
  return Number(Number.isNaN(a)) - Number(Number.isNaN(b));
}
