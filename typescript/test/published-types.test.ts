// Builds the package into a scratch node_modules that has its dependencies but no apache-arrow,
// then typechecks a consumer with skipLibCheck off. Two tsc runs make this the suite's slowest
// test, a few seconds.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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
  GapKind,
  GraphNode,
  ProblemIssue,
} from "@developmentfinance/client";
import type { Part } from "@developmentfinance/client/wire";

export async function rows(question: string): Promise<number> {
  const client = new Client({ baseUrl: "https://example.org/api", apiKey: false });
  const answer: Answer = await client.search(question);
  const parts: readonly Part[] = answer.parts;
  const dataset: Dataset = await client.fetch(answer.specs[0]!);
  const bytes: Uint8Array = await dataset.bytes();
  const node: GraphNode = await client.graph.node("country/NGA");
  return parts.length + dataset.rows + bytes.length + node.ref.length;
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
`;

const ARROW_CONSUMER = `
import { toArrow } from "@developmentfinance/client/arrow";
export { toArrow };
`;

let root: string;

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
  const installed = join(root, "node_modules", "@developmentfinance", "client");
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
