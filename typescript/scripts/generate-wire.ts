// Generates src/generated/openapi.ts, the wire types, from contract/served/openapi.json with
// openapi-typescript.
//
//   node scripts/generate-wire.ts           rewrite src/generated/openapi.ts
//   node scripts/generate-wire.ts --check   exit 1 when the committed file differs
//
// Two transforms run during generation. Every string `enum` becomes an open union, so a value
// added by the server still typechecks. `const` members stay closed, since they discriminate
// unions. Every array of parts discriminated on `status` gains the hand-written `UnknownPart`, so
// a part status added by the server narrows to it.
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
import type { UnknownPart } from "../unknown-part.ts";

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

/** The vendor key on the schema that stands for "any other string". */
const OTHER_STRING = "x-dfo-other-string";

/** Rewrites every string `enum` in the served document as the union of that enum and any other
 *  string, in place. openapi-typescript replaces the property a union discriminates on with an
 *  `enum` of its own after this runs, so discriminators stay closed. */
function openEnums(node: unknown): number {
  if (Array.isArray(node))
    return node.reduce((count: number, child) => count + openEnums(child), 0);
  if (node === null || typeof node !== "object") return 0;
  let count = Object.values(node).reduce((total: number, child) => total + openEnums(child), 0);
  if ("enum" in node && Array.isArray(node.enum)) {
    const values: unknown[] = node.enum;
    const strings = values.filter((value): value is string => typeof value === "string");
    const nullable = values.includes(null);
    if (strings.length + (nullable ? 1 : 0) !== values.length) {
      throw new Error(
        `an enum holds a value other than a string or null: ${JSON.stringify(values)}`,
      );
    }
    const schema = node as Record<string, unknown>;
    delete schema["enum"];
    delete schema["type"];
    schema["anyOf"] = [
      { type: "string", enum: strings },
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

const aliasName = (schema: string): string =>
  RENAMED[schema] ??
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
  if (openEnums(openapi) === 0) throw new Error("the served document holds no string enum");
  let joined = 0;
  const schemas = openapi.components?.schemas ?? {};
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

  const source = `${HEADER}${astToString(ast)}\n${aliases(Object.keys(schemas), recursive)}\n`;
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
