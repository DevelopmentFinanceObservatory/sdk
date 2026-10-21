/**
 * Reading the bare Parquet files a dataset holds with hyparquet, and writing a stacked dataset
 * as one Parquet file with hyparquet-writer. Several files stack into one table: a `part`
 * column first, then every file's columns in file order, with a column one file lacks null in
 * that file's rows. A column whose type differs between files widens as pyarrow's permissive
 * promotion widens it, so a table either client stacks has the same types. A DECIMAL column
 * keeps its precision and scale, and its values read as 64-bit floats.
 */

import { parquetMetadata, parquetReadObjects } from "hyparquet";
import type { FileMetaData, KeyValue, ParquetParsers, SchemaElement } from "hyparquet";
import { parquetWriteBuffer } from "hyparquet-writer";

import { clientError } from "./errors.ts";
import type { ContractError } from "./errors.ts";

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
  /** A DECIMAL column, whose values read as 64-bit floats. */
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
 * @throws {ContractError} A column is nested or of a type the client cannot read
 *   (`contract_violation`).
 */
export function readParquet(bytes: Uint8Array): ParquetFile {
  const buffer = bytes.slice().buffer;
  const metadata = parquetMetadata(buffer);
  const columns = metadata.schema.slice(1).map((element) => ({
    name: element.name,
    type: columnType(element),
  }));
  return { buffer, metadata, columns, rows: Number(metadata.num_rows) };
}

function unsupported(element: SchemaElement, what: string): ContractError {
  return clientError("contract_violation", {
    detail: `The Parquet column ${element.name} is ${what}, which the client cannot read.`,
  });
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
    const bits = Math.min(64, Math.max(signed.bits, unsigned.bits * 2)) as Bits;
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
 *  file's columns in file order, each of the type `widen` gives its files' types.
 *
 * @throws {ContractError} A member's file has its own `part` column, or a column's types in two
 *   files do not widen to one (`contract_violation`).
 */
export function stackedColumns(parts: readonly TablePart[]): Column[] {
  const types = new Map<string, ColumnType>();
  if (parts.length > 1) types.set(PART_COLUMN, STRING);
  for (const { file } of parts) {
    for (const { name, type } of file.columns) {
      if (parts.length > 1 && name === PART_COLUMN) {
        throw clientError("contract_violation", {
          detail: `A member's file has its own ${PART_COLUMN} column, so the members do not stack.`,
        });
      }
      const seen = types.get(name);
      const stacked = seen === undefined ? type : widen(seen, type);
      if (stacked === undefined) {
        throw clientError("contract_violation", {
          detail:
            `The column ${name} is ${JSON.stringify(seen)} in one member and ` +
            `${JSON.stringify(type)} in another, so the members do not stack.`,
        });
      }
      types.set(name, stacked);
    }
  }
  return [...types].map(([name, type]) => ({ name, type }));
}

const encoder = new TextEncoder();

/** Whether a column's values are numbers with a fraction: a float's, or a decimal's. */
const isFloating = (type: ColumnType): boolean => type.kind === "float" || type.kind === "decimal";

function rowValue(value: unknown, column: Column): Value {
  if (value === undefined || value === null) return null;
  if (isFloating(column.type) && typeof value === "bigint") return Number(value);
  if (column.type.kind === "binary" && typeof value === "string") return encoder.encode(value);
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

/** Every row of the stacked table. */
export async function decodeRows(parts: readonly TablePart[]): Promise<Row[]> {
  const columns = stackedColumns(parts);
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
        row[column.name] =
          parts.length > 1 && column.name === PART_COLUMN
            ? label
            : rowValue(source[column.name], column);
      }
      rows.push(row);
    }
  }
  return rows;
}

/** A stacked table's columns, each with its values as stored: integers for dates and
 *  timestamps, in the column's unit, `bigint` for INT64, a number for a float, text for strings,
 *  null where a file lacks the column. */
export type StoredColumn = Column & { readonly values: unknown[] };

/** Every column of the stacked table with its stored values, in row order. */
export async function decodeStored(parts: readonly TablePart[]): Promise<StoredColumn[]> {
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
  return stackedColumns(parts).map(({ name, type }) => {
    const values: unknown[] = [];
    for (const [index, { file, label }] of parts.entries()) {
      const isPart = parts.length > 1 && name === PART_COLUMN;
      const own = file.columns.find((column) => column.name === name)?.type ?? NULL;
      for (const row of decoded[index]!) {
        const value: unknown = isPart ? label : (row[name] ?? null);
        values.push(storedValue(value, own, type));
      }
    }
    return { name, type, values };
  });
}

/** A stored value of a file's column type as the stacked column's type stores it. */
function storedValue(value: unknown, own: ColumnType, type: ColumnType): unknown {
  if (value === null) return null;
  if (type.kind === "string" && value instanceof Uint8Array) return text(value);
  if (isFloating(type) && typeof value === "bigint") return Number(value);
  if (type.kind === "timestamp" && own.kind === "timestamp" && own.unit !== type.unit) {
    return (BigInt(value as bigint | number) * TICKS_PER_MS[type.unit]) / TICKS_PER_MS[own.unit];
  }
  return value;
}

/** The Parquet schema element a column type is written as; every column is nullable, since a
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

/** The stacked table as one snappy Parquet file, with `metadata` as its key-value metadata. */
export async function encodeStacked(
  parts: readonly TablePart[],
  metadata: Readonly<Record<string, string>>,
): Promise<Uint8Array> {
  const columns = await decodeStored(parts);
  const schema: SchemaElement[] = [
    { name: "root", num_children: columns.length },
    ...columns.map(schemaElement),
  ];
  const kvMetadata: KeyValue[] = Object.entries(metadata).map(([key, value]) => ({ key, value }));
  const buffer = parquetWriteBuffer({
    columnData: columns.map(({ name, type, values }) => ({
      name,
      // INT64 and timestamp columns hold bigints; a value decoded as a number is written as one.
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
