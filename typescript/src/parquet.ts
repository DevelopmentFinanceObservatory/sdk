/**
 * Decoding the bare Parquet files a dataset holds, with hyparquet, into rows or an Arrow table.
 * Several files stack into one table: a `part` column first, then every file's columns in
 * file order, with a column one file lacks null in that file's rows.
 */

import { parquetMetadata, parquetReadObjects } from "hyparquet";
import type { FileMetaData, ParquetParsers, SchemaElement } from "hyparquet";
import type * as Arrow from "apache-arrow";

/**
 * One cell of `toRows()`. INT64 columns arrive as numbers, so `JSON.stringify` works on the
 * rows; a value beyond `Number.MAX_SAFE_INTEGER` raises rather than lose precision, and
 * `toArrow()` keeps it as a `bigint`. Timestamps and dates are `Date`s, JSON columns their text.
 */
export type Value = string | number | boolean | Date | Uint8Array | null;

/** One row of `toRows()`, keyed by column name in column order. */
export type Row = Record<string, Value>;

/** A column's type, read from the Parquet schema, independent of any table library. */
export type ColumnType =
  | { readonly kind: "null" }
  | { readonly kind: "bool" }
  | { readonly kind: "int"; readonly bits: 8 | 16 | 32 | 64; readonly signed: boolean }
  | { readonly kind: "float"; readonly bits: 32 | 64 }
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

export const PART_COLUMN = "part";

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

/** Parsers for `toRows()`: hyparquet's defaults, with JSON columns kept as text. */
const ROW_PARSERS: Partial<ParquetParsers> = { jsonFromBytes: text };

/** Parsers for `toArrow()`: timestamps and dates as their stored integers, JSON as text. */
const RAW_PARSERS: Partial<ParquetParsers> = {
  timestampFromMilliseconds: (value) => value,
  timestampFromMicroseconds: (value) => value,
  timestampFromNanoseconds: (value) => value,
  dateFromDays: (days) => days,
  jsonFromBytes: text,
};

/** Reads a Parquet file's footer and column types. */
export function readParquet(bytes: Uint8Array): ParquetFile {
  const buffer = bytes.slice().buffer;
  const metadata = parquetMetadata(buffer);
  const columns = metadata.schema.slice(1).map((element) => ({
    name: element.name,
    type: columnType(element),
  }));
  return { buffer, metadata, columns, rows: Number(metadata.num_rows) };
}

function unsupported(element: SchemaElement, what: string): TypeError {
  return new TypeError(
    `The Parquet column ${element.name} is ${what}, which the client cannot read.`,
  );
}

function intType(bits: number, signed: boolean, element: SchemaElement): ColumnType {
  if (bits !== 8 && bits !== 16 && bits !== 32 && bits !== 64) {
    throw unsupported(element, `a ${bits}-bit integer`);
  }
  return { kind: "int", bits, signed };
}

/** A column's type from its schema element. Nested columns raise: dataset files are flat. */
export function columnType(element: SchemaElement): ColumnType {
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
  if (logical?.type === "DECIMAL" || converted === "DECIMAL") return { kind: "float", bits: 64 };
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

/** The stacked table's columns: `part` first when there are several files, then every
 *  file's columns in file order. A column all null in one file takes another file's type. */
export function stackedColumns(parts: readonly TablePart[]): Column[] {
  const types = new Map<string, ColumnType>();
  if (parts.length > 1) types.set(PART_COLUMN, STRING);
  for (const { file } of parts) {
    for (const { name, type } of file.columns) {
      if (parts.length > 1 && name === PART_COLUMN) {
        throw new TypeError(`A member's file has its own ${PART_COLUMN} column.`);
      }
      const seen = types.get(name);
      if (seen === undefined || seen.kind === "null") {
        types.set(name, type);
      } else if (type.kind !== "null" && !sameType(seen, type)) {
        throw new TypeError(
          `The column ${name} is ${JSON.stringify(seen)} in one member and ` +
            `${JSON.stringify(type)} in another, so the members do not stack.`,
        );
      }
    }
  }
  return [...types].map(([name, type]) => ({ name, type }));
}

function rowValue(value: unknown, column: string): Value {
  if (value === undefined || value === null) return null;
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new RangeError(
        `The column ${column} holds ${value}, beyond a JavaScript number's exact range; ` +
          "read it with toArrow(), which keeps it as a bigint.",
      );
    }
    return Number(value);
  }
  // hyparquet decodes every other Parquet type to one of the `Value` types.
  return value as Value;
}

/** Every row of the stacked table. */
export async function decodeRows(parts: readonly TablePart[]): Promise<Row[]> {
  const columns = stackedColumns(parts).map(({ name }) => name);
  const rows: Row[] = [];
  for (const { file, label } of parts) {
    const decoded = await parquetReadObjects({
      file: file.buffer,
      metadata: file.metadata,
      parsers: ROW_PARSERS,
    });
    for (const source of decoded) {
      const row: Row = {};
      for (const column of columns) {
        row[column] =
          parts.length > 1 && column === PART_COLUMN ? label : rowValue(source[column], column);
      }
      rows.push(row);
    }
  }
  return rows;
}

type ArrowModule = typeof Arrow;

async function loadArrow(): Promise<ArrowModule> {
  try {
    return await import("apache-arrow");
  } catch (error) {
    throw new Error("toArrow() needs the apache-arrow package; install it beside this client.", {
      cause: error,
    });
  }
}

const TIME_UNITS = { MILLIS: "MILLISECOND", MICROS: "MICROSECOND", NANOS: "NANOSECOND" } as const;

function arrowType(arrow: ArrowModule, type: ColumnType): Arrow.DataType {
  switch (type.kind) {
    case "null":
      return new arrow.Null();
    case "bool":
      return new arrow.Bool();
    case "string":
      return new arrow.Utf8();
    case "binary":
      return new arrow.Binary();
    case "date":
      return new arrow.DateDay();
    case "timestamp":
      return new arrow.Timestamp(arrow.TimeUnit[TIME_UNITS[type.unit]], type.utc ? "UTC" : null);
    case "float":
      return type.bits === 32 ? new arrow.Float32() : new arrow.Float64();
    case "int":
      return new arrow.Int(type.signed, type.bits);
  }
}

type FixedArray =
  | Int8Array
  | Int16Array
  | Int32Array
  | Uint8Array
  | Uint16Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array;

function fixedArray(type: ColumnType, length: number): FixedArray {
  if (type.kind === "float")
    return type.bits === 32 ? new Float32Array(length) : new Float64Array(length);
  if (type.kind === "date") return new Int32Array(length);
  if (type.kind === "timestamp") return new BigInt64Array(length);
  if (type.kind !== "int") throw new TypeError(`${type.kind} is not a fixed-width type.`);
  const arrays = type.signed
    ? { 8: Int8Array, 16: Int16Array, 32: Int32Array, 64: BigInt64Array }
    : { 8: Uint8Array, 16: Uint16Array, 32: Uint32Array, 64: BigUint64Array };
  return new arrays[type.bits](length);
}

function arrowVector(arrow: ArrowModule, type: ColumnType, values: readonly unknown[]) {
  const dataType = arrowType(arrow, type);
  const length = values.length;
  if (type.kind === "null") return arrow.makeVector(arrow.makeData({ type: dataType, length }));
  if (type.kind === "string") {
    const strings = values.map((value) => (value instanceof Uint8Array ? text(value) : value));
    return arrow.vectorFromArray(strings, dataType);
  }
  if (type.kind === "bool" || type.kind === "binary")
    return arrow.vectorFromArray(values, dataType);

  // Fixed-width values are written straight into the column buffer with a validity bitmap,
  // so int64 and timestamp values keep every bit.
  const data = fixedArray(type, length);
  const validity = new Uint8Array(Math.ceil(length / 8));
  let nullCount = 0;
  for (const [index, value] of values.entries()) {
    if (value === null || value === undefined) {
      nullCount += 1;
      continue;
    }
    if (data instanceof BigInt64Array || data instanceof BigUint64Array) {
      data[index] = BigInt(value as bigint | number);
    } else {
      data[index] = Number(value);
    }
    validity[index >> 3]! |= 1 << (index & 7);
  }
  return arrow.makeVector(
    // makeData has one overload per concrete type; `data` is the typed array `type` stores.
    arrow.makeData({ type: dataType, length, nullCount, nullBitmap: validity, data } as never),
  );
}

/** The stacked table as an Arrow table, built column by column from hyparquet's decoding. */
export async function decodeArrow(parts: readonly TablePart[]): Promise<Arrow.Table> {
  const arrow = await loadArrow();
  const decoded = await Promise.all(
    parts.map(({ file }) =>
      parquetReadObjects({
        file: file.buffer,
        metadata: file.metadata,
        parsers: RAW_PARSERS,
        utf8: false,
      }),
    ),
  );
  const vectors: Record<string, Arrow.Vector> = {};
  for (const { name, type } of stackedColumns(parts)) {
    const values: unknown[] = [];
    for (const [index, { label }] of parts.entries()) {
      const isPart = parts.length > 1 && name === PART_COLUMN;
      for (const row of decoded[index]!) values.push(isPart ? label : (row[name] ?? null));
    }
    vectors[name] = arrowVector(arrow, type, values);
  }
  return new arrow.Table(vectors);
}
