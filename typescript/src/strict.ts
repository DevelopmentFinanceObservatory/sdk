import { clientError } from "./errors.ts";
import { STRICT_SCHEMAS } from "./generated/strict.ts";

/** A schema that holds a strict field, or leads to one. */
export type StrictSchema = keyof typeof STRICT_SCHEMAS;

type Shape =
  | { readonly ref: string }
  | { readonly items: Shape }
  | { readonly values: Shape }
  | { readonly discriminator: string; readonly mapping: Readonly<Record<string, string>> };

type Entry = {
  readonly required: readonly string[];
  readonly children: Readonly<Record<string, Shape>>;
};

const TABLE: Readonly<Record<string, Entry>> = STRICT_SCHEMAS;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

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
  const body = isRecord(value) ? value : {};
  for (const member of entry.required) {
    if (body[member] === undefined || body[member] === null) {
      throw clientError("contract_violation", {
        detail:
          `The response has no ${member} at ${pointer || "/"}, which ` +
          `${schema} requires and this client acts on. Upgrade the client, or report the trace id.`,
        pointer: `${pointer}/${escape(member)}`,
      });
    }
  }
  for (const [member, shape] of Object.entries(entry.children)) {
    const child = body[member];
    if (child !== undefined && child !== null)
      checkShape(shape, child, `${pointer}/${escape(member)}`);
  }
}

/**
 * Raises `ContractError` when a response body lacks a member the client acts on, anywhere the
 * schema leads, as `contract/strict-fields.json` lists them. Every other member, and every
 * unknown discriminator value, passes untouched.
 */
export function checkStrict(schema: StrictSchema, body: unknown): void {
  checkSchema(schema, body, "");
}
