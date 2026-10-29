/**
 * Reading the bare Parquet files a dataset holds with hyparquet, and writing a stacked dataset
 * as one Parquet file with hyparquet-writer. Several files stack into one table: a `part`
 * column first, then every file's columns, gathered in file order, with a column one file
 * lacks null in that file's rows. Every table the client returns presents the stacked table's
 * columns and rows in reading order, which `presentedOrder` reads from its values. A column
 * whose type differs between files widens as pyarrow's permissive promotion widens it, so a table either client stacks has the same types. A DECIMAL column
 * keeps its precision and scale. Its values are read as the unscaled integers the file stores,
 * so `bytes()` writes them exact, and `toRows()` and `toArrow()` give each the nearest 64-bit
 * float.
 */

import { parquetMetadata, parquetRead } from "hyparquet";
import type { FileMetaData, KeyValue, ParquetParsers, SchemaElement } from "hyparquet";
import { parquetWriteBuffer } from "hyparquet-writer";

import { readingOrder } from "./reading-order.ts";
import type { ReadingOrder } from "./reading-order.ts";
import { capped, clientError } from "../core/errors.ts";
import type { ContractError } from "../core/errors.ts";

/**
 * One cell of `toRows()`. INT64 columns arrive as numbers, so `JSON.stringify` works on the
 * rows. A value beyond `Number.MAX_SAFE_INTEGER` raises, and `toArrow()` keeps it as a
 * `bigint`. Timestamps and dates are `Date`s, JSON columns their text.
 */
export type Value = string | number | boolean | Date | Uint8Array | null;

/** One row of `toRows()`, keyed by column name in reading order. */
export type Row = Record<string, Value>;

/** A column's type, read from the Parquet schema, independent of any table library. */
export type ColumnType =
  | { readonly kind: "null" }
  | { readonly kind: "bool" }
  | { readonly kind: "int"; readonly bits: 8 | 16 | 32 | 64; readonly signed: boolean }
  | { readonly kind: "float"; readonly bits: 32 | 64 }
  /** A DECIMAL column, whose values `toRows()` and `toArrow()` read as 64-bit floats. */
  | { readonly kind: "decimal"; readonly precision: number; readonly scale: number }
  | { readonly kind: "date" }
  | {
      readonly kind: "timestamp";
      readonly unit: "MILLIS" | "MICROS" | "NANOS";
      readonly utc: boolean;
    }
  | { readonly kind: "string" }
  | { readonly kind: "binary" };

export type Column = { readonly name: string; readonly type: ColumnType };

/** One decoded Parquet file's shape, read from its footer. */
export type ParquetFile = {
  readonly buffer: ArrayBuffer;
  readonly metadata: FileMetaData;
  readonly columns: readonly Column[];
  readonly rows: number;
};

/** A file in a stacked table, with the label its `part` column holds when there are several. */
export type TablePart = { readonly file: ParquetFile; readonly label: string };

/** A stacked table's files and the reading order it presents them in. */
export type Table = { readonly parts: readonly TablePart[]; readonly order: ReadingOrder };

const PART_COLUMN = "part";

const NULL: ColumnType = { kind: "null" };
const STRING: ColumnType = { kind: "string" };
const UNSUPPORTED = new Set([
  "MAP",
  "LIST",
  "VARIANT",
  "GEOMETRY",
  "GEOGRAPHY",
  "BSON",
  "INTERVAL",
]);
const TEXT = new Set(["UTF8", "STRING", "ENUM", "JSON", "UUID"]);
const decoder = new TextDecoder();

const text = (bytes: Uint8Array | undefined): string | undefined => bytes && decoder.decode(bytes);

/** Parsers for stored values: timestamps and dates as their stored integers, JSON as text. */
const RAW_PARSERS: Partial<ParquetParsers> = {
  timestampFromMilliseconds: (value) => value,
  timestampFromMicroseconds: (value) => value,
  timestampFromNanoseconds: (value) => value,
  dateFromDays: (days) => days,
  jsonFromBytes: text,
};

/**
 * Reads a Parquet file's footer and column types.
 *
 * @throws {ContractError} The bytes are not a Parquet file the client can read
 *   (`unexpected_response`), or two columns share a name, or a column is nested or of a type the
 *   client cannot read (`contract_violation`).
 */
export function readParquet(bytes: Uint8Array): ParquetFile {
  // Dataset has already copied each public input into an owned, full-span ArrayBuffer. Keep that
  // one copy; callers of this standalone reader can still pass a view or shared backing store.
  const buffer =
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : new Uint8Array(bytes).buffer;
  let metadata: FileMetaData;
  try {
    metadata = parquetMetadata(buffer);
  } catch (error) {
    throw unreadable(error);
  }
  const columns = metadata.schema.slice(1).map((element) => ({
    name: element.name,
    type: columnType(element),
  }));
  const names = new Set<string>();
  for (const { name } of columns) {
    if (names.has(name)) {
      throw clientError("contract_violation", {
        detail: `The Parquet file holds two columns named ${capped(JSON.stringify(name))}.`,
      });
    }
    names.add(name);
  }
  return { buffer, metadata, columns, rows: Number(metadata.num_rows) };
}

/** The error for bytes hyparquet cannot read as Parquet, keeping what it raised as the cause. */
function unreadable(error: unknown): ContractError {
  const reason = error instanceof Error ? `: ${error.message}` : "";
  return clientError("unexpected_response", {
    detail: `Not a Parquet file the client can read${reason}.`,
    cause: error,
  });
}

function unsupported(element: SchemaElement, what: string): ContractError {
  return clientError("contract_violation", {
    detail: `The Parquet column ${capped(element.name)} is ${what}, which the client cannot read.`,
  });
}

function intType(bits: number, signed: boolean, element: SchemaElement): ColumnType {
  if (bits !== 8 && bits !== 16 && bits !== 32 && bits !== 64) {
    throw unsupported(element, `a ${bits}-bit integer`);
  }
  return { kind: "int", bits, signed };
}

/** A column's type from its schema element. Nested columns raise, since dataset files are flat. */
function columnType(element: SchemaElement): ColumnType {
  const logical = element.logical_type;
  const converted = element.converted_type;
  if (element.num_children !== undefined || element.repetition_type === "REPEATED") {
    throw unsupported(element, "nested");
  }
  if (
    (logical !== undefined && UNSUPPORTED.has(logical.type)) ||
    (converted !== undefined && UNSUPPORTED.has(converted))
  ) {
    throw unsupported(element, logical?.type ?? converted ?? "nested");
  }
  if (logical?.type === "NULL") return NULL;
  if (logical?.type === "DECIMAL") {
    return { kind: "decimal", precision: logical.precision, scale: logical.scale };
  }
  if (converted === "DECIMAL") {
    return { kind: "decimal", precision: element.precision ?? 0, scale: element.scale ?? 0 };
  }
  if (logical?.type === "TIMESTAMP") {
    return { kind: "timestamp", unit: logical.unit, utc: logical.isAdjustedToUTC };
  }
  if (converted === "TIMESTAMP_MILLIS") return { kind: "timestamp", unit: "MILLIS", utc: true };
  if (converted === "TIMESTAMP_MICROS") return { kind: "timestamp", unit: "MICROS", utc: true };
  if (element.type === "INT96") return { kind: "timestamp", unit: "NANOS", utc: false };
  if (logical?.type === "DATE" || converted === "DATE") return { kind: "date" };
  if (logical?.type === "FLOAT16") return { kind: "float", bits: 32 };
  if (
    (logical !== undefined && TEXT.has(logical.type)) ||
    (converted !== undefined && TEXT.has(converted))
  ) {
    return STRING;
  }
  if (logical?.type === "INTEGER") return intType(logical.bitWidth, logical.isSigned, element);
  const legacy = converted?.match(/^(U?)INT_(8|16|32|64)$/);
  if (legacy) return intType(Number(legacy[2]), legacy[1] === "", element);
  switch (element.type) {
    case "BOOLEAN":
      return { kind: "bool" };
    case "INT32":
      return { kind: "int", bits: 32, signed: true };
    case "INT64":
      return { kind: "int", bits: 64, signed: true };
    case "FLOAT":
      return { kind: "float", bits: 32 };
    case "DOUBLE":
      return { kind: "float", bits: 64 };
    default:
      return { kind: "binary" };
  }
}

const sameType = (left: ColumnType, right: ColumnType): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

type Bits = 8 | 16 | 32 | 64;

/** The decimal digits of each integer width's largest magnitude, which a decimal must hold in
 *  its integer digits for the integer column to stack with it. */
const INT_DIGITS = {
  signed: { 8: 3, 16: 5, 32: 10, 64: 19 },
  unsigned: { 8: 3, 16: 5, 32: 10, 64: 20 },
} as const;
/** The widest decimal pyarrow holds, in digits. */
const MAX_DECIMAL_PRECISION = 76;

/** Each timestamp unit's ticks per millisecond. */
const TICKS_PER_MS = { MILLIS: 1n, MICROS: 1_000n, NANOS: 1_000_000n } as const;

/**
 * The type two files' columns stack as, widened as pyarrow's permissive promotion widens it, or
 * undefined for a pair it refuses. Null takes the other type; integers take the wider width, a
 * signed and an unsigned one a signed type that holds both, up to 64 bits; an integer and a
 * float take the float, 64 bits unless a 32-bit float meets an integer of at most 16 bits;
 * timestamps in one time zone take the finer unit; a string and a binary column take binary.
 * Decimals take the larger scale and the most integer digits, up to 76 digits; a decimal and a
 * float take the float; a decimal and an integer take the decimal when its integer digits hold
 * every value of the integer's width, and are refused otherwise, as pyarrow's cast refuses them.
 */
export function widen(left: ColumnType, right: ColumnType): ColumnType | undefined {
  if (left.kind === "null") return right;
  if (right.kind === "null" || sameType(left, right)) return left;
  if (left.kind === "decimal" || right.kind === "decimal") return widenDecimal(left, right);
  if (left.kind === "int" && right.kind === "int") {
    if (left.signed === right.signed) {
      return { kind: "int", bits: Math.max(left.bits, right.bits) as Bits, signed: left.signed };
    }
    const [signed, unsigned] = left.signed ? [left, right] : [right, left];
    // A signed N-bit integer reaches 2**(N - 1) - 1, so it needs one more bit than the unsigned
    // member. There is no signed Parquet integer that holds both an UINT64 and any signed type.
    const required = Math.max(signed.bits, unsigned.bits + 1);
    const bits = ([8, 16, 32, 64] as const).find((width) => width >= required);
    if (bits === undefined) return undefined;
    return { kind: "int", bits, signed: true };
  }
  if (left.kind === "float" && right.kind === "float") return { kind: "float", bits: 64 };
  const float = left.kind === "float" ? left : right.kind === "float" ? right : undefined;
  const int = left.kind === "int" ? left : right.kind === "int" ? right : undefined;
  if (float !== undefined && int !== undefined) {
    return { kind: "float", bits: float.bits === 32 && int.bits <= 16 ? 32 : 64 };
  }
  if (left.kind === "timestamp" && right.kind === "timestamp" && left.utc === right.utc) {
    return TICKS_PER_MS[left.unit] > TICKS_PER_MS[right.unit] ? left : right;
  }
  const kinds = new Set([left.kind, right.kind]);
  if (kinds.has("string") && kinds.has("binary")) return { kind: "binary" };
  return undefined;
}

/** The type a decimal column stacks with another as, or undefined for a pair pyarrow refuses. */
function widenDecimal(left: ColumnType, right: ColumnType): ColumnType | undefined {
  const [decimal, other] = left.kind === "decimal" ? [left, right] : [right, left];
  if (decimal.kind !== "decimal") return undefined;
  if (other.kind === "float") return other;
  if (other.kind === "int") {
    const digits = INT_DIGITS[other.signed ? "signed" : "unsigned"][other.bits];
    return decimal.precision - decimal.scale >= digits ? decimal : undefined;
  }
  if (other.kind !== "decimal") return undefined;
  const scale = Math.max(decimal.scale, other.scale);
  const precision =
    Math.max(decimal.precision - decimal.scale, other.precision - other.scale) + scale;
  return precision > MAX_DECIMAL_PRECISION ? undefined : { kind: "decimal", precision, scale };
}

/** The stacked table's columns: `part` first when there are several files, then every
 *  file's columns, gathered in file order with each once, each of the
 *  type `widen` gives its files' types. A file with no
 *  rows adds no columns unless every file is empty, when the first file gives them. The server
 *  writes every column of an empty file as a string, which would not widen to a number.
 *
 * @throws {ContractError} A member's file has its own `part` column, or a column's types in two
 *   files do not widen to one (`contract_violation`).
 */
export function stackedColumns(parts: readonly TablePart[]): Column[] {
  const types = new Map<string, ColumnType>();
  const several = parts.length > 1;
  if (several) types.set(PART_COLUMN, STRING);
  const filled = parts.filter(({ file }) => file.rows > 0);
  for (const { file } of filled.length > 0 ? filled : parts.slice(0, 1)) {
    for (const { name, type } of file.columns) {
      if (several && name === PART_COLUMN) {
        throw clientError("contract_violation", {
          detail: `A member's file has its own ${PART_COLUMN} column, so the members do not stack.`,
        });
      }
      const seen = types.get(name);
      const stacked = seen === undefined ? type : widen(seen, type);
      if (stacked === undefined) {
        throw clientError("contract_violation", {
          detail:
            `The column ${capped(name)} is ${JSON.stringify(seen)} in one member and ` +
            `${JSON.stringify(type)} in another, so the members do not stack.`,
        });
      }
      types.set(name, stacked);
    }
  }
  return [...types].map(([name, type]) => ({ name, type }));
}

const encoder = new TextEncoder();

const DAY_MS = 86_400_000;

/** A DECIMAL's stored value as its unscaled integer: an INT32 or INT64 as read, a byte array
 *  as the big-endian two's complement it holds. */
function unscaledOf(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  const bytes = value as Uint8Array;
  let unscaled = 0n;
  for (const byte of bytes) unscaled = (unscaled << 8n) | BigInt(byte);
  const negative = bytes.length > 0 && (bytes[0]! & 0x80) !== 0;
  return negative ? unscaled - (1n << BigInt(bytes.length * 8)) : unscaled;
}

/** The 64-bit float nearest a decimal of `scale` holding `unscaled`. */
export const decimalNumber = (unscaled: bigint, scale: number): number =>
  Number(`${unscaled}e-${scale}`);

/** A file's metadata with its DECIMAL columns stripped of their annotations, so hyparquet reads
 *  their physical values and leaves the unscaled integers whole, where it would otherwise scale
 *  each through a 64-bit float. */
function physicalDecimals(metadata: FileMetaData): FileMetaData {
  const schema = metadata.schema.map((element) => {
    if (element.converted_type !== "DECIMAL" && element.logical_type?.type !== "DECIMAL") {
      return element;
    }
    const physical = { ...element };
    delete physical.converted_type;
    delete physical.logical_type;
    return physical;
  });
  return { ...metadata, schema };
}

/** A stacked table's columns, each with its values as stored: integers for dates and
 *  timestamps, in the column's unit, `bigint` for INT64, the unscaled `bigint` at the column's
 *  scale for a DECIMAL, a number for a float, text for strings, null where a file lacks the
 *  column. */
export type StoredColumn = Column & { readonly values: unknown[] };

/**
 * The reading order of the stacked table: `part` first when several files stack, then the
 * reading order of the other columns over the stacked rows, each file's rows sorted as one
 * member. A single file's own `part` column is data, ordered as any other column. The order
 * needs every value, since which columns vary and how the rows sort depend on them, so it
 * decodes every member.
 *
 * @throws {ContractError} The members do not stack (`contract_violation`), or a file's pages
 *   cannot be decoded (`unexpected_response`).
 */
export async function presentedOrder(parts: readonly TablePart[]): Promise<ReadingOrder> {
  const stacked = await decodeStacked(parts);
  const part = parts.length > 1 ? stacked.find(({ name }) => name === PART_COLUMN) : undefined;
  const { columns, rows } = readingOrder(
    stacked.filter((column) => column !== part),
    memberRows(parts),
  );
  return { columns: Object.freeze(part ? [PART_COLUMN, ...columns] : [...columns]), rows };
}

/** Each member's row count, in member order: one member per file. */
export const memberRows = (parts: readonly TablePart[]): number[] =>
  parts.map(({ file }) => file.rows);

/** Every column of the table with its stored values, columns and rows in reading order.
 *
 * @throws {ContractError} A file's pages cannot be decoded (`unexpected_response`).
 */
export async function decodeStored({ parts, order }: Table): Promise<StoredColumn[]> {
  const stacked = new Map((await decodeStacked(parts)).map((column) => [column.name, column]));
  return order.columns.map((name) => {
    const column = stacked.get(name)!;
    const values = Array.from(order.rows, (row) => column.values[row]);
    return { ...column, values };
  });
}

/** Every column of the stacked table with its stored values, in the order `stackedColumns`
 *  gives, the members' rows one after another. */
async function decodeStacked(parts: readonly TablePart[]): Promise<StoredColumn[]> {
  const decoded = await Promise.all(parts.map(({ file }) => storedRows(file)));
  return stackedColumns(parts).map(({ name, type }) => {
    const isPart = parts.length > 1 && name === PART_COLUMN;
    const values: unknown[] = [];
    for (const [index, { file, label }] of parts.entries()) {
      const at = file.columns.findIndex((column) => column.name === name);
      const own = file.columns[at]?.type ?? NULL;
      for (const row of decoded[index]!) {
        const value: unknown = isPart ? label : at < 0 ? null : (row[at] ?? null);
        values.push(storedValue(value, own, type));
      }
    }
    return { name, type, values };
  });
}

/** The values column `name` holds across the table's files, in file order, without reading
 *  any other column; none from a file that lacks it.
 *
 * @throws {ContractError} A file's pages cannot be decoded (`unexpected_response`).
 */
export async function columnValues({ parts }: Table, name: string): Promise<unknown[]> {
  const values: unknown[] = [];
  for (const { file } of parts) {
    const column = file.columns.find((own) => own.name === name);
    if (column === undefined) continue;
    for (const [value] of await storedRows(file, [column])) {
      values.push(storedValue(value ?? null, column.type, column.type));
    }
  }
  return values;
}

/** A file's rows as stored, each an array of `columns`' values, every column of the file by
 *  default, in the file's column order, so a column named like an `Object.prototype` member
 *  reads as any other. */
async function storedRows(
  file: ParquetFile,
  columns: readonly Column[] = file.columns,
): Promise<unknown[][]> {
  let rows: unknown[][] = [];
  try {
    await parquetRead({
      file: file.buffer,
      metadata: physicalDecimals(file.metadata),
      columns: columns.map((column) => column.name),
      parsers: RAW_PARSERS,
      utf8: false,
      onComplete: (read) => {
        rows = read;
      },
    });
  } catch (error) {
    throw unreadable(error);
  }
  return rows;
}

/** A stored value of a file's column type as the stacked column's type stores it. */
function storedValue(value: unknown, own: ColumnType, type: ColumnType): unknown {
  if (value === null) return null;
  if (type.kind === "string" && value instanceof Uint8Array) return text(value);
  if (type.kind === "decimal") {
    const ownScale = own.kind === "decimal" ? own.scale : 0;
    return unscaledOf(value) * 10n ** BigInt(type.scale - ownScale);
  }
  if (type.kind === "float" && own.kind === "decimal") {
    return decimalNumber(unscaledOf(value), own.scale);
  }
  if (type.kind === "float" && typeof value === "bigint") return Number(value);
  if (type.kind === "timestamp" && own.kind === "timestamp" && own.unit !== type.unit) {
    return (BigInt(value as bigint | number) * TICKS_PER_MS[type.unit]) / TICKS_PER_MS[own.unit];
  }
  return value;
}

/** A stored value as `toRows()` gives it. */
function rowValue(value: unknown, column: Column): Value {
  if (value === null) return null;
  const { type } = column;
  switch (type.kind) {
    case "decimal":
      return decimalNumber(value as bigint, type.scale);
    case "date":
      return new Date((value as number) * DAY_MS);
    case "timestamp":
      return new Date(Number(BigInt(value as bigint | number) / TICKS_PER_MS[type.unit]));
    case "binary":
      return typeof value === "string" ? encoder.encode(value) : (value as Uint8Array);
    default:
      break;
  }
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new RangeError(
        `The column ${column.name} holds ${value}, beyond a JavaScript number's exact range; ` +
          "read it with toArrow(), which keeps it as a bigint.",
      );
    }
    return Number(value);
  }
  // hyparquet decodes every other Parquet type to one of the `Value` types.
  return value as Value;
}

/** Every row of the table, in reading order. */
export async function decodeRows(table: Table): Promise<Row[]> {
  const columns = await decodeStored(table);
  const count = table.order.rows.length;
  const rows: Row[] = [];
  for (let index = 0; index < count; index += 1) {
    // fromEntries defines each column as an own property, `__proto__` included.
    rows.push(
      Object.fromEntries(
        columns.map((column) => [column.name, rowValue(column.values[index], column)]),
      ),
    );
  }
  return rows;
}

/** The Parquet schema element a column type is written as. Every column is nullable, since a
 *  column one member lacks is null in its rows. */
function schemaElement({ name, type }: Column): SchemaElement {
  const optional = { name, repetition_type: "OPTIONAL" } as const;
  switch (type.kind) {
    case "null":
      return { ...optional, type: "INT32", logical_type: { type: "NULL" } };
    case "bool":
      return { ...optional, type: "BOOLEAN" };
    case "int": {
      // The legacy converted type, since hyparquet-writer 0.16.10 writes the INTEGER logical
      // type's bit width as a thrift i32 where the format has an i8, which pyarrow refuses.
      const physical = type.bits === 64 ? "INT64" : "INT32";
      if (type.signed && type.bits >= 32) return { ...optional, type: physical };
      return {
        ...optional,
        type: physical,
        converted_type: `${type.signed ? "" : "U"}INT_${type.bits}`,
      };
    }
    case "float":
      return { ...optional, type: type.bits === 32 ? "FLOAT" : "DOUBLE" };
    case "decimal": {
      const { precision, scale } = type;
      const decimal = {
        ...optional,
        converted_type: "DECIMAL",
        logical_type: { type: "DECIMAL", precision, scale },
        precision,
        scale,
      } as const;
      if (precision <= 9) return { ...decimal, type: "INT32" };
      if (precision <= 18) return { ...decimal, type: "INT64" };
      // The fewest bytes whose two's complement holds every value of `precision` digits.
      const length = Math.ceil((precision * Math.log2(10) + 1) / 8);
      return { ...decimal, type: "FIXED_LEN_BYTE_ARRAY", type_length: length };
    }
    case "date":
      return { ...optional, type: "INT32", converted_type: "DATE", logical_type: { type: "DATE" } };
    case "timestamp":
      return {
        ...optional,
        type: "INT64",
        logical_type: { type: "TIMESTAMP", isAdjustedToUTC: type.utc, unit: type.unit },
      };
    case "string":
      return {
        ...optional,
        type: "BYTE_ARRAY",
        converted_type: "UTF8",
        logical_type: { type: "STRING" },
      };
    case "binary":
      return { ...optional, type: "BYTE_ARRAY" };
  }
}

/** The table in reading order as one snappy Parquet file, with `metadata` as its key-value
 *  metadata. */
export async function encodeStacked(
  table: Table,
  metadata: Readonly<Record<string, string>>,
): Promise<Uint8Array> {
  const columns = await decodeStored(table);
  const schema: SchemaElement[] = [
    { name: "root", num_children: columns.length },
    ...columns.map(schemaElement),
  ];
  const kvMetadata: KeyValue[] = Object.entries(metadata).map(([key, value]) => ({ key, value }));
  const buffer = parquetWriteBuffer({
    columnData: columns.map(({ name, type, values }) => ({
      name,
      // INT64 and timestamp columns hold bigints. A value decoded as a number is written as one.
      // A DECIMAL column holds unscaled bigints, which hyparquet-writer writes unchanged.
      data:
        (type.kind === "int" && type.bits === 64) || type.kind === "timestamp"
          ? values.map((value) => (typeof value === "number" ? BigInt(value) : value))
          : values,
    })),
    schema,
    kvMetadata,
  });
  return new Uint8Array(buffer);
}
