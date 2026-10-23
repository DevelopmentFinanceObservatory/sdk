import { clientError } from "./errors.ts";
import { STRICT_SCHEMAS } from "../generated/strict.ts";
import { isRecord } from "./json.ts";

/** A schema that holds a strict field. */
export type StrictSchema = keyof typeof STRICT_SCHEMAS;

type Shape =
  | { readonly ref: string }
  | { readonly items: Shape }
  | { readonly values: Shape }
  | { readonly discriminator: string; readonly mapping: Readonly<Record<string, string>> };

type JsonType = "string" | "array" | "object";

type Entry = {
  readonly required: Readonly<Record<string, JsonType>>;
  readonly children: Readonly<Record<string, Shape>>;
};

const TABLE: Readonly<Record<string, Entry>> = STRICT_SCHEMAS;

const IS_TYPE: Readonly<Record<JsonType, (value: unknown) => boolean>> = {
  string: (value) => typeof value === "string",
  array: Array.isArray,
  object: isRecord,
};

const violation = (detail: string, pointer: string) =>
  clientError("contract_violation", { detail, pointer });

const escape = (member: string): string => member.replaceAll("~", "~0").replaceAll("/", "~1");

function checkShape(shape: Shape, value: unknown, pointer: string): void {
  if ("ref" in shape) {
    checkSchema(shape.ref, value, pointer);
  } else if ("items" in shape) {
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        checkShape(shape.items, item, `${pointer}/${index}`);
      }
    }
  } else if ("values" in shape) {
    if (isRecord(value)) {
      for (const [member, child] of Object.entries(value)) {
        checkShape(shape.values, child, `${pointer}/${escape(member)}`);
      }
    }
  } else if (isRecord(value)) {
    // A discriminator value this release does not know passes untouched.
    const tag = value[shape.discriminator];
    if (typeof tag === "string" && Object.hasOwn(shape.mapping, tag)) {
      checkSchema(shape.mapping[tag]!, value, pointer);
    }
  }
}

function checkSchema(schema: string, value: unknown, pointer: string): void {
  const entry = TABLE[schema]!;
  if (!isRecord(value)) {
    throw violation(`The ${schema} at ${pointer || "/"} is not an object.`, pointer);
  }
  const body = value;
  for (const [member, type] of Object.entries(entry.required)) {
    const at = `${pointer}/${escape(member)}`;
    if (body[member] === undefined || body[member] === null) {
      throw violation(
        `The response has no ${member} at ${pointer || "/"}, which ` +
          `${schema} requires and this client acts on. Upgrade the client, or report the trace id.`,
        at,
      );
    }
    if (!IS_TYPE[type](body[member])) {
      throw violation(
        `The ${member} at ${at} is not a JSON ${type}, which ${schema} requires and this ` +
          "client acts on. Upgrade the client, or report the trace id.",
        at,
      );
    }
  }
  for (const [member, shape] of Object.entries(entry.children)) {
    const child = body[member];
    if (child !== undefined && child !== null)
      checkShape(shape, child, `${pointer}/${escape(member)}`);
  }
}

/**
 * Raises `ContractError` when a response body lacks a member the client acts on, or holds it as
 * another JSON type than the served document gives it, as
 * `contract/strict-fields.json` lists them. The check descends only through those members, so a
 * nested spec the client never reads, such as one under a spec's `resolved`, is not checked.
 * Every other member, and every unknown discriminator value, passes untouched.
 */
export function checkStrict(schema: StrictSchema, body: unknown): void {
  checkSchema(schema, body, "");
}
