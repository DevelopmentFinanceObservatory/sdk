// Generates the client's contract tables from contract/:
//
//   src/generated/strict.ts   from strict-fields.json, checked against served/openapi.json
//   src/generated/actions.ts  from actions.json and the actions it allows in actions.schema.json
//   src/generated/client-codes.ts  from client-codes.json
//
//   node scripts/generate-contract.ts           rewrite every file
//   node scripts/generate-contract.ts --check   exit 1 when a committed file differs
//
// The strict table lists, for every schema that holds a strict field or leads to one, the strict
// members it requires and the members to descend into. Generation fails when a strict pointer
// names a member the served document does not require, or lets be null, or when an enum entry
// lists a value the served document does not allow.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { format, resolveConfig } from "prettier";

const contract = (name: string): string =>
  fileURLToPath(new URL(`../../contract/${name}`, import.meta.url));
const output = (name: string): string =>
  fileURLToPath(new URL(`../src/generated/${name}`, import.meta.url));

type Schema = Record<string, unknown>;
type Shape =
  | { ref: string }
  | { items: Shape }
  | { values: Shape }
  | { discriminator: string; mapping: Record<string, string> };

const isRecord = (value: unknown): value is Schema =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const REF_PREFIX = "#/components/schemas/";

function parsePointer(pointer: string): { schema: string; property: string } {
  const match = /^\/components\/schemas\/([^/]+)\/properties\/([^/]+)$/.exec(pointer);
  if (match === null) throw new Error(`${pointer} names no property of a component schema`);
  return { schema: match[1]!, property: match[2]! };
}

function refName(ref: unknown): string {
  if (typeof ref !== "string" || !ref.startsWith(REF_PREFIX)) {
    throw new Error(`unsupported $ref ${String(ref)}`);
  }
  return ref.slice(REF_PREFIX.length);
}

/** The members of a union, without the null member a nullable property adds. */
const nonNullMembers = (schema: Schema): unknown[] =>
  [schema["anyOf"], schema["oneOf"]]
    .flatMap((members): unknown[] => (Array.isArray(members) ? members : []))
    .filter((member) => !(isRecord(member) && member["type"] === "null"));

function isNullable(schema: Schema): boolean {
  const type = schema["type"];
  if (type === "null" || (Array.isArray(type) && type.includes("null"))) return true;
  return [schema["anyOf"], schema["oneOf"]].some(
    (members) =>
      Array.isArray(members) &&
      members.some(
        (member) => isRecord(member) && (member["type"] === "null" || isNullable(member)),
      ),
  );
}

/** The shape a property schema takes towards the schemas in `relevant`, or undefined when it
 *  leads to none of them. */
function shapeOf(schema: unknown, relevant: Set<string>): Shape | undefined {
  if (!isRecord(schema)) return undefined;
  if ("$ref" in schema) {
    const name = refName(schema["$ref"]);
    return relevant.has(name) ? { ref: name } : undefined;
  }
  const discriminator = schema["discriminator"];
  if (isRecord(discriminator)) {
    const mapping = Object.fromEntries(
      Object.entries(isRecord(discriminator["mapping"]) ? discriminator["mapping"] : {})
        .map(([value, ref]) => [value, refName(ref)] as const)
        .filter(([, name]) => relevant.has(name))
        .toSorted(([a], [b]) => (a < b ? -1 : 1)),
    );
    if (Object.keys(mapping).length === 0) return undefined;
    return { discriminator: String(discriminator["propertyName"]), mapping };
  }
  const members = nonNullMembers(schema)
    .map((member) => shapeOf(member, relevant))
    .filter((shape) => shape !== undefined);
  if (members.length > 1) {
    throw new Error(
      `a union without a discriminator leads to strict fields: ${JSON.stringify(schema)}`,
    );
  }
  if (members.length === 1) return members[0];
  if (schema["type"] === "array") {
    const items = shapeOf(schema["items"], relevant);
    return items === undefined ? undefined : { items };
  }
  if (isRecord(schema["additionalProperties"])) {
    const values = shapeOf(schema["additionalProperties"], relevant);
    return values === undefined ? undefined : { values };
  }
  return undefined;
}

type StrictEntry = { required: string[]; children: Record<string, Shape> };

export function renderStrict(openapiText: string, strictText: string): Record<string, unknown> {
  const schemas = (JSON.parse(openapiText) as { components: { schemas: Record<string, Schema> } })
    .components.schemas;
  const strict = JSON.parse(strictText) as {
    required: { pointer: string }[];
    enums: { pointer: string; values: string[] }[];
  };

  const property = (pointer: string): { schema: string; property: string; node: Schema } => {
    const target = parsePointer(pointer);
    const properties = schemas[target.schema]?.["properties"];
    const node = isRecord(properties) ? properties[target.property] : undefined;
    if (!isRecord(node)) throw new Error(`${pointer} is not in served/openapi.json`);
    return { ...target, node };
  };

  const required = new Map<string, string[]>();
  for (const { pointer } of strict.required) {
    const target = property(pointer);
    const listed = schemas[target.schema]!["required"];
    if (!Array.isArray(listed) || !listed.includes(target.property)) {
      throw new Error(`${pointer} is strict but served/openapi.json does not require it`);
    }
    if (isNullable(target.node)) {
      throw new Error(`${pointer} is strict but served/openapi.json lets it be null`);
    }
    required.set(target.schema, [...(required.get(target.schema) ?? []), target.property]);
  }

  const enums: Record<string, Record<string, string[]>> = {};
  for (const { pointer, values } of strict.enums) {
    const target = property(pointer);
    const allowed =
      "const" in target.node ? [target.node["const"]] : (target.node["enum"] as unknown[]);
    const missing = values.filter((value) => !Array.isArray(allowed) || !allowed.includes(value));
    if (missing.length > 0) {
      throw new Error(`${pointer} does not allow ${missing.join(", ")} in served/openapi.json`);
    }
    (enums[target.schema] ??= {})[target.property] = values;
  }

  // The schemas that hold a strict field or lead to one, grown to a fixed point.
  const relevant = new Set(required.keys());
  for (let grown = true; grown;) {
    grown = false;
    for (const [name, schema] of Object.entries(schemas)) {
      if (relevant.has(name) || !isRecord(schema["properties"])) continue;
      const leads = Object.values(schema["properties"]).some(
        (node) => shapeOf(node, relevant) !== undefined,
      );
      if (leads) {
        relevant.add(name);
        grown = true;
      }
    }
  }

  const table: Record<string, StrictEntry> = {};
  for (const name of [...relevant].toSorted()) {
    const properties = schemas[name]!["properties"];
    const children = Object.fromEntries(
      Object.entries(isRecord(properties) ? properties : {})
        .map(([member, node]) => [member, shapeOf(node, relevant)] as const)
        .filter((entry): entry is readonly [string, Shape] => entry[1] !== undefined),
    );
    table[name] = { required: required.get(name) ?? [], children };
  }
  return { STRICT_SCHEMAS: table, STRICT_ENUMS: enums };
}

export function renderActions(actionsText: string, schemaText: string): Record<string, unknown> {
  const actions = JSON.parse(actionsText) as {
    codes: { code: string; action: string; gap_kind?: string }[];
  };
  const schema = JSON.parse(schemaText) as {
    properties: {
      codes: {
        items: { properties: { action: { enum: string[] }; gap_kind: { enum: string[] } } };
      };
    };
  };
  const { action, gap_kind } = schema.properties.codes.items.properties;
  if (actions.codes.length === 0) throw new Error("actions.json lists no codes");
  return {
    ACTIONS: action.enum,
    GAP_KINDS: gap_kind.enum,
    CODE_ACTIONS: Object.fromEntries(actions.codes.map((row) => [row.code, row.action])),
    CODE_GAP_KINDS: Object.fromEntries(
      actions.codes.flatMap((row) =>
        row.gap_kind === undefined ? [] : [[row.code, row.gap_kind]],
      ),
    ),
  };
}

export function renderClientCodes(codesText: string): Record<string, unknown> {
  const { codes } = JSON.parse(codesText) as { codes: { code: string; class: string }[] };
  if (codes.length === 0) throw new Error("client-codes.json lists no codes");
  const classes = new Map<string, string>();
  for (const row of codes) {
    if (classes.has(row.code)) throw new Error(`client-codes.json lists ${row.code} twice`);
    classes.set(row.code, row.class);
  }
  return { CLIENT_CODE_CLASSES: Object.fromEntries(classes) };
}

async function module(
  source: string,
  tables: Record<string, unknown>,
  file: string,
): Promise<string> {
  const body = Object.entries(tables)
    .map(([name, value]) => `export const ${name} = ${JSON.stringify(value)} as const;`)
    .join("\n\n");
  const text = `// Generated from ${source} by \`pnpm generate\`. Do not edit by hand.\n\n${body}\n`;
  return format(text, { ...(await resolveConfig(file)), filepath: file });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const read = (name: string): Promise<string> => readFile(contract(name), "utf8");
  const files: [string, string][] = [
    [
      output("strict.ts"),
      await module(
        "contract/strict-fields.json and contract/served/openapi.json",
        renderStrict(await read("served/openapi.json"), await read("strict-fields.json")),
        output("strict.ts"),
      ),
    ],
    [
      output("actions.ts"),
      await module(
        "contract/actions.json and contract/actions.schema.json",
        renderActions(await read("actions.json"), await read("actions.schema.json")),
        output("actions.ts"),
      ),
    ],
    [
      output("client-codes.ts"),
      await module(
        "contract/client-codes.json",
        renderClientCodes(await read("client-codes.json")),
        output("client-codes.ts"),
      ),
    ],
  ];
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const [file, rendered] of files) {
    if (!check) {
      await writeFile(file, rendered);
    } else if ((await readFile(file, "utf8").catch(() => "")) !== rendered) {
      console.error(`${file} is stale; run \`pnpm generate\` and commit the result`);
      stale += 1;
    }
  }
  if (stale > 0) process.exit(1);
}
