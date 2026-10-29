// Generates the client's contract tables from contract/:
//
//   src/generated/strict.ts   from strict-fields.json, checked against served/openapi.json
//   src/generated/actions.ts  from actions.json and the actions it allows in actions.schema.json
//   src/generated/client-codes.ts  from client-codes.json
//   src/generated/warning-codes.ts from warning-codes.json
//   src/generated/proxy-codes.ts   from proxy-codes.json, checked against actions.json
//   src/generated/reading-order.ts from rules/reading-order.json
//   src/generated/role-keys.ts     from rules/role-keys.json
//   src/generated/file-selector.ts from rules/file-selector.json
//
//   node scripts/generate-contract.ts           rewrite every file
//   node scripts/generate-contract.ts --check   exit 1 when a committed file differs
//
// The strict table lists, for every schema that holds a strict field, the strict members it
// requires, each with the JSON type (string, array or object) the served document gives it
// directly or through its `$ref`, and the strict members to descend into, which are those whose
// schema holds strict fields of its own. The check reaches only the members a client reads, so
// a nested schema reached through a member the client never reads, such as a spec under
// `resolved`, is not checked. Generation fails when a strict pointer names a member the served
// document does not require, lets be null, or types as other than a string, array or object,
// or when an enum entry lists a value the served document does not allow.
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

const strictPointer = (schema: string, member: string): string =>
  `/components/schemas/${schema}/properties/${member}`;

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

type JsonType = "string" | "integer" | "array" | "object";
const JSON_TYPES = new Set<unknown>(["string", "integer", "array", "object"]);

type StrictEntry = { required: Record<string, JsonType>; children: Record<string, Shape> };

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

  /** The JSON type a property must have, through its `$ref`, or undefined when it has no
   *  string, integer, array or object type. */
  const jsonType = (node: Schema): JsonType | undefined => {
    const typed = "$ref" in node ? schemas[refName(node["$ref"])] : node;
    const type = typed?.["type"];
    return JSON_TYPES.has(type) ? (type as JsonType) : undefined;
  };

  const required = new Map<string, Record<string, JsonType>>();
  for (const { pointer } of strict.required) {
    const target = property(pointer);
    const listed = schemas[target.schema]!["required"];
    if (!Array.isArray(listed) || !listed.includes(target.property)) {
      throw new Error(`${pointer} is strict but served/openapi.json does not require it`);
    }
    if (isNullable(target.node)) {
      throw new Error(`${pointer} is strict but served/openapi.json lets it be null`);
    }
    const type = jsonType(target.node);
    if (type === undefined) {
      throw new Error(`${pointer} is strict but has no string, integer, array or object type`);
    }
    required.set(target.schema, { ...required.get(target.schema), [target.property]: type });
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

  // The check descends only through strict members, into the schemas that hold strict fields.
  const relevant = new Set(required.keys());
  const table: Record<string, StrictEntry> = {};
  for (const name of [...relevant].toSorted()) {
    const members = required.get(name)!;
    const children = Object.fromEntries(
      Object.keys(members)
        .map((member) => [member, shapeOf(property(strictPointer(name, member)).node, relevant)])
        .filter((entry): entry is [string, Shape] => entry[1] !== undefined),
    );
    table[name] = { required: members, children };
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
  const { codes } = JSON.parse(codesText) as {
    codes: { code: string; class: string; retryable: unknown }[];
  };
  if (codes.length === 0) throw new Error("client-codes.json lists no codes");
  const classes = new Map<string, string>();
  const retryable = new Map<string, boolean | "by_status">();
  for (const row of codes) {
    if (classes.has(row.code)) throw new Error(`client-codes.json lists ${row.code} twice`);
    if (typeof row.retryable !== "boolean" && row.retryable !== "by_status") {
      throw new Error(`client-codes.json gives ${row.code} no retryable flag`);
    }
    classes.set(row.code, row.class);
    retryable.set(row.code, row.retryable);
  }
  return {
    CLIENT_CODE_CLASSES: Object.fromEntries(classes),
    CLIENT_CODE_RETRYABLE: Object.fromEntries(retryable),
  };
}

export function renderWarningCodes(codesText: string): Record<string, unknown> {
  const { codes } = JSON.parse(codesText) as { codes: { code: string; class: string }[] };
  if (codes.length === 0) throw new Error("warning-codes.json lists no codes");
  const classes = new Map<string, string>();
  for (const row of codes) {
    if (classes.has(row.code)) throw new Error(`warning-codes.json lists ${row.code} twice`);
    classes.set(row.code, row.class);
  }
  return { CLIENT_WARNING_CODES: Object.fromEntries(classes) };
}

/** The proxy's codes with their statuses. A proxy code with a row in `actions.json` would take
 *  that row's class in place of its status's, so generation refuses one. */
export function renderProxyCodes(codesText: string, actionsText: string): Record<string, unknown> {
  const { codes } = JSON.parse(codesText) as { codes: { code: string; status: number }[] };
  const actions = new Set(
    (JSON.parse(actionsText) as { codes: { code: string }[] }).codes.map((row) => row.code),
  );
  if (codes.length === 0) throw new Error("proxy-codes.json lists no codes");
  const statuses = new Map<string, number>();
  for (const row of codes) {
    if (statuses.has(row.code)) throw new Error(`proxy-codes.json lists ${row.code} twice`);
    if (actions.has(row.code)) throw new Error(`proxy code ${row.code} has a row in actions.json`);
    statuses.set(row.code, row.status);
  }
  return { PROXY_CODE_STATUSES: Object.fromEntries(statuses) };
}

/** The reading slots of the reading-order rule, each the names that fill it in order. */
export function renderReadingOrder(ruleText: string): Record<string, unknown> {
  const rule = JSON.parse(ruleText) as {
    format_version?: unknown;
    rule?: unknown;
    reading_columns?: unknown;
  };
  if (rule.format_version !== 1 || rule.rule !== "reading-order") {
    throw new Error("rules/reading-order.json is not format version 1 of the reading-order rule");
  }
  const slots = rule.reading_columns;
  const isSlot = (slot: unknown): slot is string[] =>
    Array.isArray(slot) &&
    slot.length > 0 &&
    slot.every((name) => typeof name === "string" && name !== "");
  if (!Array.isArray(slots) || slots.length === 0 || !slots.every(isSlot)) {
    throw new Error("rules/reading-order.json lists no reading_columns slots of names");
  }
  const names = slots.flat();
  if (
    new Set(names).size !== names.length ||
    names.includes("stat_var") ||
    names.includes("part")
  ) {
    throw new Error(
      "rules/reading-order.json names a column twice, or names stat_var or part in a slot",
    );
  }
  return { READING_COLUMNS: slots };
}

/** The caller key of each entity role, to the wire role a client posts it as, and the flow
 *  keys among them. */
export function renderRoleKeys(ruleText: string): Record<string, unknown> {
  const rule = JSON.parse(ruleText) as {
    format_version?: unknown;
    rule?: unknown;
    keys?: unknown;
    flow_keys?: unknown;
  };
  if (rule.format_version !== 1 || rule.rule !== "role-keys") {
    throw new Error("rules/role-keys.json is not format version 1 of the role-keys rule");
  }
  const { keys, flow_keys: flowKeys } = rule;
  const isName = (name: unknown): name is string => typeof name === "string" && name !== "";
  if (
    !isRecord(keys) ||
    Object.keys(keys).length === 0 ||
    !Object.entries(keys).every(([key, wire]) => isName(key) && isName(wire))
  ) {
    throw new Error("rules/role-keys.json maps no caller keys to wire roles");
  }
  const wires = Object.values(keys);
  if (new Set(wires).size !== wires.length) {
    throw new Error("rules/role-keys.json maps two caller keys to one wire role");
  }
  if (
    !Array.isArray(flowKeys) ||
    flowKeys.length === 0 ||
    new Set(flowKeys).size !== flowKeys.length ||
    !flowKeys.every((key) => isName(key) && keys[key] === key)
  ) {
    throw new Error(
      "rules/role-keys.json lists no flow_keys, lists one twice, or lists one that is not a " +
        "caller key posted as itself",
    );
  }
  return { ROLE_KEYS: keys, FLOW_KEYS: flowKeys };
}

/** The query keys a version's file selector reads, in the order a query lists them. */
export function renderFileSelector(ruleText: string): Record<string, unknown> {
  const rule = JSON.parse(ruleText) as {
    format_version?: unknown;
    rule?: unknown;
    query_keys?: unknown;
  };
  if (rule.format_version !== 1 || rule.rule !== "file-selector") {
    throw new Error("rules/file-selector.json is not format version 1 of the file-selector rule");
  }
  const keys = rule.query_keys;
  if (
    !Array.isArray(keys) ||
    keys.length === 0 ||
    new Set(keys).size !== keys.length ||
    !keys.every((key) => typeof key === "string" && key !== "")
  ) {
    throw new Error("rules/file-selector.json lists no query_keys, or one twice or not a name");
  }
  return { SELECTOR_QUERY_KEYS: keys };
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
    [
      output("warning-codes.ts"),
      await module(
        "contract/warning-codes.json",
        renderWarningCodes(await read("warning-codes.json")),
        output("warning-codes.ts"),
      ),
    ],
    [
      output("proxy-codes.ts"),
      await module(
        "contract/proxy-codes.json and contract/actions.json",
        renderProxyCodes(await read("proxy-codes.json"), await read("actions.json")),
        output("proxy-codes.ts"),
      ),
    ],
    [
      output("reading-order.ts"),
      await module(
        "contract/rules/reading-order.json",
        renderReadingOrder(await read("rules/reading-order.json")),
        output("reading-order.ts"),
      ),
    ],
    [
      output("role-keys.ts"),
      await module(
        "contract/rules/role-keys.json",
        renderRoleKeys(await read("rules/role-keys.json")),
        output("role-keys.ts"),
      ),
    ],
    [
      output("file-selector.ts"),
      await module(
        "contract/rules/file-selector.json",
        renderFileSelector(await read("rules/file-selector.json")),
        output("file-selector.ts"),
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
