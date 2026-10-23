/**
 * `toArrow(dataset)` returns a dataset as an apache-arrow table, decoded with hyparquet and built
 * column by column. It is the one module that needs the optional apache-arrow package, and only
 * the `@developmentfinance/client/arrow` entry point, `src/arrow.ts`, imports it.
 */

import * as arrow from "apache-arrow";

import type { Gap } from "../search/answer.ts";
import { tableParts } from "./dataset.ts";
import type { Dataset } from "./dataset.ts";
import { decimalNumber, decodeStored } from "./parquet.ts";
import type { ColumnType } from "./parquet.ts";

const TIME_UNITS = { MILLIS: "MILLISECOND", MICROS: "MICROSECOND", NANOS: "NANOSECOND" } as const;

function arrowType(type: ColumnType): arrow.DataType {
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
    case "decimal":
      return new arrow.Float64();
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
  if (type.kind === "decimal") return new Float64Array(length);
  if (type.kind === "date") return new Int32Array(length);
  if (type.kind === "timestamp") return new BigInt64Array(length);
  if (type.kind !== "int") throw new TypeError(`${type.kind} is not a fixed-width type.`);
  const arrays = type.signed
    ? { 8: Int8Array, 16: Int16Array, 32: Int32Array, 64: BigInt64Array }
    : { 8: Uint8Array, 16: Uint16Array, 32: Uint32Array, 64: BigUint64Array };
  return new arrays[type.bits](length);
}

function arrowVector(type: ColumnType, values: readonly unknown[]): arrow.Vector {
  const dataType = arrowType(type);
  const length = values.length;
  if (type.kind === "null") return arrow.makeVector(arrow.makeData({ type: dataType, length }));
  if (type.kind === "string" || type.kind === "bool" || type.kind === "binary") {
    return arrow.vectorFromArray(values, dataType);
  }

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
    } else if (type.kind === "decimal") {
      data[index] = decimalNumber(value as bigint, type.scale);
    } else {
      data[index] = Number(value);
    }
    validity[index >> 3]! |= 1 << (index & 7);
  }
  return arrow.makeVector(
    // makeData has one overload per concrete type, and `data` is the typed array `type` stores.
    arrow.makeData({ type: dataType, length, nullCount, nullBitmap: validity, data } as never),
  );
}

/**
 * The dataset's table as an apache-arrow `Table`, `part` first when several members stack.
 * INT64 columns keep their `bigint` values, and timestamps their stored unit. A DECIMAL column
 * reads as `Float64`, each value the float nearest the stored decimal. It decodes every member
 * and builds the whole table in memory.
 */
export async function toArrow(dataset: Dataset<Gap>): Promise<arrow.Table> {
  const vectors: Record<string, arrow.Vector> = {};
  for (const { name, type, values } of await decodeStored(tableParts(dataset))) {
    vectors[name] = arrowVector(type, values);
  }
  return new arrow.Table(vectors);
}
