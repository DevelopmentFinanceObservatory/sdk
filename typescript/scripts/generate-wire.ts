// Generates src/generated/openapi.ts, the wire types, from contract/served/openapi.json with
// openapi-typescript.
//
//   node scripts/generate-wire.ts           rewrite src/generated/openapi.ts
//   node scripts/generate-wire.ts --check   exit 1 when the committed file differs
//
// Three transforms run during generation. Every string `enum` becomes an open union, so a value
// added by the server still typechecks. `const` members stay closed, since they discriminate
// unions, and so does an enum holding any value other than a string or null, such as an integer
// `format_version`, which reads as its literal union, as the Python client's `Literal` does. The enums in `NAMED_ENUMS` are also declared as closed unions of their own, which the
// wire fields name and the client's options take. Every array of parts discriminated on `status`
// gains the hand-written `UnknownPart`, so a part status added by the server narrows to it.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import openapiTS, { astToString, oapiRef, STRING, tsUnion } from "openapi-typescript";
import type { OpenAPI3, SchemaObject } from "openapi-typescript";
import { format, resolveConfig } from "prettier";
import ts from "typescript";

const DOCUMENT = fileURLToPath(new URL("../../contract/served/openapi.json", import.meta.url));
const OUTPUT = fileURLToPath(new URL("../src/generated/openapi.ts", import.meta.url));

const PART_SCHEMAS = ["DefinitePart", "CandidatesPart", "NoDataPart", "UnsupportedPart"];

/** Component schemas whose public alias takes another name. */
const RENAMED: Record<string, string> = { Operation: "RequestedOperation" };

const HEADER = `// Generated from contract/served/openapi.json by \`pnpm generate\`. Do not edit by hand.
import type { UnknownPart } from "../core/unknown-part.ts";

`;

/** The part schemas a union discriminated on `status` maps to, or undefined for any other
 *  schema. */
function partMapping(schema: unknown): string[] | undefined {
  if (schema === null || typeof schema !== "object" || !("discriminator" in schema))
    return undefined;
  const { discriminator } = schema as {
    discriminator: { propertyName?: unknown; mapping?: unknown };
  };
  if (discriminator.propertyName !== "status") return undefined;
  const mapping = discriminator.mapping;
  if (mapping === null || typeof mapping !== "object") return undefined;
  const targets = Object.values(mapping as Record<string, unknown>);
  const known = PART_SCHEMAS.map((name) => `#/components/schemas/${name}`);
  return known.every((ref) => targets.includes(ref)) ? targets.map(String) : undefined;
}

/** An array of parts typed as the known parts or `UnknownPart`, or undefined for any other
 *  schema. */
function openParts(schema: SchemaObject): ts.TypeNode | undefined {
  if (!("items" in schema)) return undefined;
  const mapping = partMapping(schema.items);
  if (mapping === undefined) return undefined;
  const members = mapping.map((ref) => oapiRef(ref));
  return ts.factory.createArrayTypeNode(
    tsUnion([...members, ts.factory.createTypeReferenceNode("UnknownPart")]),
  );
}

/** The enums declared as named closed unions: each one's schema path and the line that documents
 *  it. A wire field reads `Name | (string & {})`; an option the client takes reads `Name`. */
const NAMED_ENUMS: Record<string, { path: readonly string[]; doc: string }> = {
  Severity: {
    path: ["Warning", "properties", "severity"],
    doc: "How much a Search warning matters.",
  },
  AssumptionKind: {
    path: ["Assumption", "properties", "kind"],
    doc: "What Search filled in that the question left open.",
  },
  DepartureCode: {
    path: ["Departure", "properties", "code"],
    doc: "How a reading differs from what the question asked.",
  },
  NoDataReason: { path: ["NoData", "properties", "reason"], doc: "Why a part has no data." },
  DeclinedReason: {
    path: ["DeclinedAnswer", "properties", "reason"],
    doc: "Why Search declined a question.",
  },
  ResolveKind: {
    path: ["graph_api__resolve_models__ResolveRequest", "properties", "kinds", "items"],
    doc: "A kind of graph node a name can resolve to.",
  },
};

/** The vendor key on the schema that `openEnums` writes for a named enum's closed union. */
const ENUM_NAME = "x-dfo-enum-name";

/** Each enum in `NAMED_ENUMS` by its schema object, with its name and values, failing when a path
 *  holds no string enum or a name is a schema's. */
function nameEnums(
  schemas: Record<string, unknown>,
): Map<object, { name: string; values: readonly string[] }> {
  const named = new Map<object, { name: string; values: readonly string[] }>();
  for (const [name, { path }] of Object.entries(NAMED_ENUMS)) {
    if (name in schemas) throw new Error(`the enum name ${name} is a schema's`);
    const node = path.reduce<unknown>(
      (at, key) =>
        at !== null && typeof at === "object" ? (at as Record<string, unknown>)[key] : undefined,
      schemas,
    );
    const values: unknown =
      node !== null && typeof node === "object" ? (node as { enum?: unknown }).enum : undefined;
    if (!Array.isArray(values) || !values.every((value) => typeof value === "string")) {
      throw new Error(`${path.join(".")} holds no string enum for ${name}`);
    }
    named.set(node as object, { name, values });
  }
  return named;
}

/** The closed unions `nameEnums` found, one documented type each. */
const namedUnions = (named: Map<object, { name: string; values: readonly string[] }>): string =>
  [...named.values()]
    .map(({ name, values }) => {
      const { path, doc } = NAMED_ENUMS[name]!;
      const field = path.filter((key) => key !== "properties").join(".");
      const union = values.map((value) => JSON.stringify(value)).join(" | ");
      return `/** ${doc} The values of \`${field}\` in the served document. */\nexport type ${name} = ${union};`;
    })
    .join("\n\n");

/** The vendor key on the schema that stands for "any other string". */
const OTHER_STRING = "x-dfo-other-string";

/** Rewrites every string `enum` in the served document as the union of that enum and any other
 *  string, in place, and returns how many it rewrote. openapi-typescript replaces the property a
 *  union discriminates on with an `enum` of its own after this runs, so discriminators stay
 *  closed. An enum in `names` becomes its named union and any other string. An enum holding a
 *  value other than a string or null is left for openapi-typescript to write as its closed
 *  literal union. */
function openEnums(node: unknown, names: ReadonlyMap<object, { name: string }>): number {
  if (Array.isArray(node))
    return node.reduce((count: number, child) => count + openEnums(child, names), 0);
  if (node === null || typeof node !== "object") return 0;
  let count = Object.values(node).reduce(
    (total: number, child) => total + openEnums(child, names),
    0,
  );
  if ("enum" in node && Array.isArray(node.enum)) {
    const values: unknown[] = node.enum;
    const strings = values.filter((value): value is string => typeof value === "string");
    const nullable = values.includes(null);
    if (strings.length + (nullable ? 1 : 0) !== values.length) return count;
    const schema = node as Record<string, unknown>;
    const name = names.get(node)?.name;
    delete schema["enum"];
    delete schema["type"];
    schema["anyOf"] = [
      // openapi-typescript writes an enum before the transform sees it, so a named enum's
      // member carries only its name.
      name === undefined
        ? { type: "string", enum: strings }
        : { type: "string", [ENUM_NAME]: name },
      { type: "string", [OTHER_STRING]: true },
      ...(nullable ? [{ type: "null" }] : []),
    ];
    count += 1;
  }
  return count;
}

const OTHER_STRING_TYPE = ts.factory.createIntersectionTypeNode([
  STRING,
  ts.factory.createTypeLiteralNode([]),
]);

/** A component schema's public alias: its name in PascalCase, with the prefix `Field` on a name
 *  that starts with an underscore, as the Python client's wire types name it, so `_ExportFrame`
 *  is `FieldExportFrame` beside `ExportFrame`. */
const aliasName = (schema: string): string =>
  RENAMED[schema] ??
  (schema.startsWith("_") ? "Field" : "") +
    schema
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((word) => word[0]!.toUpperCase() + word.slice(1))
      .join("");

/** The component schemas with no properties of their own that refer to themselves, such as a
 *  JSON-like value. Their `components` entry would refer to itself, which TypeScript refuses, so
 *  each becomes a recursive type alias that the entry names. */
function selfReferring(schemas: Record<string, unknown>): Set<string> {
  return new Set(
    Object.entries(schemas)
      .filter(
        ([name, schema]) =>
          !(schema !== null && typeof schema === "object" && "properties" in schema) &&
          JSON.stringify(schema).includes(`"#/components/schemas/${name}"`),
      )
      .map(([name]) => name),
  );
}

/** One exported alias per component schema, failing when two schemas share an alias. A
 *  self-referring schema's alias is declared with its own type. */
function aliases(schemas: string[], recursive: Map<string, string>): string {
  const seen = new Map<string, string>();
  for (const schema of schemas) {
    const alias = aliasName(schema);
    const other = seen.get(alias);
    if (other !== undefined) throw new Error(`${schema} and ${other} share the alias ${alias}`);
    seen.set(alias, schema);
  }
  return [...seen]
    .map(([alias, schema]) => {
      const own = recursive.get(schema);
      const ref = `components["schemas"][${JSON.stringify(schema)}]`;
      return `export type ${alias} = ${own === undefined ? ref : own.replaceAll(ref, alias)};`;
    })
    .join("\n");
}

export async function renderWire(text: string): Promise<string> {
  const openapi = JSON.parse(text) as OpenAPI3;
  const schemas = openapi.components?.schemas ?? {};
  const named = nameEnums(schemas);
  if (openEnums(openapi, named) === 0) throw new Error("the served document holds no string enum");
  let joined = 0;
  let referenced = 0;
  const selfReferringSchemas = selfReferring(schemas);
  const recursive = new Map<string, string>();

  const ast = await openapiTS(openapi, {
    silent: true,
    defaultNonNullable: false,
    transform(schema) {
      if ("$ref" in schema) return undefined;
      const parts = openParts(schema);
      if (parts !== undefined) {
        joined += 1;
        return parts;
      }
      const name: unknown = (schema as Record<string, unknown>)[ENUM_NAME];
      if (typeof name === "string") {
        referenced += 1;
        return ts.factory.createTypeReferenceNode(name);
      }
      return OTHER_STRING in schema ? OTHER_STRING_TYPE : undefined;
    },
    postTransform(type, options) {
      const name = options.path?.replace("#/components/schemas/", "");
      if (name === undefined || !selfReferringSchemas.has(name)) return undefined;
      if (options.path !== `#/components/schemas/${name}`) return undefined;
      recursive.set(name, astToString(type).trim());
      return ts.factory.createTypeReferenceNode(aliasName(name));
    },
  });
  if (recursive.size !== selfReferringSchemas.size) {
    throw new Error("a self-referring schema was not generated as a recursive alias");
  }
  if (joined === 0) throw new Error("UnknownPart joined no array of parts");
  if (referenced < named.size) throw new Error("a named enum's field was not generated");

  const source =
    `${HEADER}${astToString(ast)}\n${aliases(Object.keys(schemas), recursive)}\n\n` +
    `${namedUnions(named)}\n`;
  return format(source, { ...(await resolveConfig(OUTPUT)), filepath: OUTPUT });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rendered = await renderWire(await readFile(DOCUMENT, "utf8"));
  if (process.argv.includes("--check")) {
    const committed = await readFile(OUTPUT, "utf8").catch(() => "");
    if (committed !== rendered) {
      console.error("src/generated/openapi.ts is stale; run `pnpm generate` and commit the result");
      process.exit(1);
    }
  } else {
    await writeFile(OUTPUT, rendered);
  }
}
