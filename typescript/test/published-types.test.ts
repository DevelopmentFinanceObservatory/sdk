// Builds the package into a scratch node_modules that has its dependencies but no apache-arrow,
// then typechecks a consumer with skipLibCheck off and reads the built declarations. Two tsc runs
// and a program over the declarations make this the suite's slowest test, a few seconds.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import ts from "typescript";

const run = promisify(execFile);
const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const TSC = join(PACKAGE, "node_modules", "typescript", "bin", "tsc");

const CONSUMER = `
import { Client, Dataset, InvalidRequestError, isDfoError } from "@developmentfinance/client";
import type {
  Alternative,
  Answer,
  AnswerKind,
  AnswerStatus,
  Departure,
  GapKind,
  Lookup,
  Match,
  Node,
  Notice,
  Part,
  ProblemIssue,
  Severity,
  Spec,
} from "@developmentfinance/client";

export async function rows(question: string): Promise<number> {
  const client = new Client({ baseUrl: "https://example.org/api", apiKey: false });
  const answer: Answer = await client.search(question);
  const parts: readonly Part[] = answer.parts;
  const spec: Spec = answer.specs[0]!;
  const dataset: Dataset = await client.fetch(spec);
  const bytes: Uint8Array = await dataset.bytes();
  const lookup: Lookup = client.lookup;
  const node: Node = await lookup.node("country/NGA");
  const matches: readonly Match[] = await lookup.resolve("Kenya");
  const near: number = matches[0]?.nearMatches.length ?? 0;
  return parts.length + dataset.rowCount + bytes.length + node.dcid.length + near;
}

// An answer's dataset and a spec's dataset are both a Dataset.
export async function either(answer: Answer, client: Client, whole: boolean): Promise<Dataset> {
  const dataset: Dataset = await answer.fetch({ partial: true });
  return whole ? dataset : client.fetch(answer.specs[0]!);
}

// An answer's kind is closed, and its diagnostics are typed.
export function described(answer: Answer): string {
  const kind: AnswerKind = answer.kind;
  const status: AnswerStatus = answer.status;
  const kinds: readonly GapKind[] = answer.gaps.map((gap) => gap.kind);
  const total: number | undefined = answer.diagnostics.timing_ms?.total;
  const tokens: number | undefined = answer.diagnostics.llm_usage?.["input_tokens"];
  return [kind, status, kinds.join(), total ?? 0, tokens ?? 0].join(" ");
}

export const known = (error: unknown): boolean => isDfoError(error);

// A refusal's issues and alternatives are typed from the package root.
export function remedies(error: InvalidRequestError): number {
  const issues: readonly ProblemIssue[] = error.issues;
  const alternatives: readonly Alternative[] = error.alternatives;
  return issues.length + alternatives.length;
}

// What a client reads is open: a value a newer server sends typechecks, and the known ones
// complete. Answer and dataset warnings are both notices.
export function loud(answer: Answer, dataset: Dataset): boolean {
  const notices: readonly Notice[] = [...answer.warnings, ...dataset.warnings];
  const severe: Severity = "degraded";
  const unseen: Departure["code"] = "a_code_this_release_does_not_list";
  return notices.some((notice) => notice.severity === severe) || unseen === "closest_match";
}

// The mistakes a type check should catch, each of which fails to compile.
export async function mistakes(client: Client, answer: Answer): Promise<void> {
  const spec = answer.specs[0]!;
  // @ts-expect-error A misspelt option.
  await client.fetch(spec, { windw: "all" });
  // @ts-expect-error A layout the client does not have.
  await client.fetch(spec, { layout: "wide" });
  // @ts-expect-error A window that is not a year, a range, "all" or "latest".
  await client.fetch(spec, { window: "recent" });
  // @ts-expect-error A string where a role takes a list of dcids.
  await client.fetch(spec, { entities: { recipient: "country/NGA" } });
  // @ts-expect-error Options as a positional string.
  await client.fetch(spec, "all");
  // @ts-expect-error A spec id where the fetch takes a spec.
  await client.fetch("spec_123");
  // @ts-expect-error A timeout as a string.
  await client.search("x", { timeout: "30" });
  const dataset = await client.fetch(spec);
  // @ts-expect-error A member a dataset does not have.
  console.log(dataset.rows);
  // @ts-expect-error A misspelt gap kind.
  for (const gap of answer.gaps) if (gap.kind === "nodata") console.log(gap);
  // @ts-expect-error A node kind the resolver does not take.
  await client.lookup.resolve(["Nigeria"], { kinds: ["countries"] });
  // @ts-expect-error A retry count as a string.
  new Client({ maxRetries: "3" });
  // @ts-expect-error A Date where a node takes a YYYY-MM-DD date.
  await client.lookup.node("country/NGA", { asOf: new Date() });
  // @ts-expect-error A severity the contract does not list: the named unions are closed.
  const severity: Severity = "fatal";
  console.log(severity);
}
`;

const ARROW_CONSUMER = `
import { toArrow } from "@developmentfinance/client/arrow";
export { toArrow };
`;

let root: string;
let installed: string;

const tsconfig = (files: string[]) =>
  JSON.stringify({
    compilerOptions: {
      target: "ES2023",
      lib: ["ES2023", "DOM", "DOM.Iterable"],
      module: "NodeNext",
      moduleResolution: "NodeNext",
      types: [],
      strict: true,
      skipLibCheck: false,
      noEmit: true,
    },
    files,
  });

async function typecheck(project: string): Promise<{ ok: boolean; output: string }> {
  try {
    await run(process.execPath, [TSC, "-p", project], { cwd: root });
    return { ok: true, output: "" };
  } catch (error) {
    return { ok: false, output: String((error as { stdout?: string }).stdout ?? error) };
  }
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "dfo-consumer-"));
  installed = join(root, "node_modules", "@developmentfinance", "client");
  await mkdir(installed, { recursive: true });
  await run(
    process.execPath,
    [
      TSC,
      "-p",
      join(PACKAGE, "tsconfig.build.json"),
      "--outDir",
      join(installed, "dist"),
      "--sourceMap",
      "false",
      "--declarationMap",
      "false",
    ],
    { cwd: PACKAGE },
  );
  await copyFile(join(PACKAGE, "package.json"), join(installed, "package.json"));
  // The package's dependencies, as an install gives them; its optional peer stays out.
  for (const dependency of ["hyparquet", "hyparquet-writer"]) {
    const source = await realpath(join(PACKAGE, "node_modules", dependency));
    await symlink(source, join(root, "node_modules", dependency), "dir");
  }
  await writeFile(join(root, "consumer.ts"), CONSUMER);
  await writeFile(join(root, "arrow-consumer.ts"), ARROW_CONSUMER);
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(join(root, "tsconfig.json"), tsconfig(["consumer.ts"]));
  await writeFile(join(root, "tsconfig.arrow.json"), tsconfig(["arrow-consumer.ts"]));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("a consumer without apache-arrow typechecks with skipLibCheck off", async () => {
  const { ok, output } = await typecheck(join(root, "tsconfig.json"));
  assert.ok(ok, output);
});

test("only the arrow entry point needs apache-arrow", async () => {
  // The control: the scratch install lacks apache-arrow, so the entry that needs it fails.
  const { ok, output } = await typecheck(join(root, "tsconfig.arrow.json"));
  assert.equal(ok, false);
  assert.match(output, /Cannot find module 'apache-arrow'/);
});

/** The types the root's exports name in their public declarations that the root does not
 *  export, each with the exports that name it. A member marked `@internal`, a private member and
 *  the generated `components`, `paths` and `operations` maps are not read. */
function unexported(entry: string): Map<string, Set<string>> {
  const program = ts.createProgram([entry], { strict: true, noEmit: true, types: [] });
  const checker = program.getTypeChecker();
  const resolve = (symbol: ts.Symbol): ts.Symbol =>
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const module = checker.getSymbolAtLocation(program.getSourceFile(entry)!)!;
  const exported = new Set(checker.getExportsOfModule(module).map(resolve));
  const opaque = new Set(["components", "paths", "operations"]);
  const missing = new Map<string, Set<string>>();
  const hidden = (node: ts.Node): boolean =>
    ts.getJSDocTags(node).some((tag) => tag.tagName.text === "internal") ||
    (ts.canHaveModifiers(node) &&
      (ts.getModifiers(node) ?? []).some(
        (modifier) =>
          modifier.kind === ts.SyntaxKind.PrivateKeyword ||
          modifier.kind === ts.SyntaxKind.ProtectedKeyword,
      )) ||
    ((ts.isPropertyDeclaration(node) || ts.isMethodDeclaration(node)) &&
      ts.isPrivateIdentifier(node.name));
  const visit = (node: ts.Node, owner: string): void => {
    if (hidden(node)) return;
    const name = ts.isTypeReferenceNode(node)
      ? node.typeName
      : ts.isExpressionWithTypeArguments(node)
        ? node.expression
        : undefined;
    const symbol = name === undefined ? undefined : checker.getSymbolAtLocation(name);
    if (symbol !== undefined) {
      const target = resolve(symbol);
      const own = target.declarations?.[0]?.getSourceFile().fileName.startsWith(installed);
      if (
        own === true &&
        !(target.flags & ts.SymbolFlags.TypeParameter) &&
        !opaque.has(target.name) &&
        !exported.has(target)
      ) {
        missing.set(target.name, (missing.get(target.name) ?? new Set()).add(owner));
      }
    }
    ts.forEachChild(node, (child) => {
      visit(child, owner);
    });
  };
  for (const symbol of exported) {
    for (const declaration of symbol.declarations ?? []) visit(declaration, symbol.name);
  }
  return missing;
}

test("the root exports every type its public members take or return", () => {
  const missing = unexported(join(installed, "dist", "index.d.ts"));
  const named = [...missing].map(
    ([name, owners]) => `${name} (named by ${[...owners].join(", ")})`,
  );
  assert.deepEqual(named, []);
});
