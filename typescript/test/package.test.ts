import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

// The node entry point installs the file-system credentials reader the key lookup uses.
import "../src/index.node.ts";
import { envFrom } from "../src/config/env.ts";
import { resolveApiKey } from "../src/config/keys.ts";
import { VERSION } from "../src/version.ts";

const readJson = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8")) as T;

/** The names each entry point exports, split into runtime values and type-only names. The type
 *  checker lists every name over the source, and an import of the module lists the values. One
 *  program over the three entries keeps this under half a second. */
async function surface(): Promise<Record<string, { values: string[]; types: string[] }>> {
  const entries = { ".": "index.node.ts", "./types": "types.ts", "./errors": "errors.ts" };
  const path = (file: string): string => fileURLToPath(new URL(`../src/${file}`, import.meta.url));
  const program = ts.createProgram(Object.values(entries).map(path), {
    allowImportingTsExtensions: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2023,
    types: [],
  });
  const checker = program.getTypeChecker();
  const listed: Record<string, { values: string[]; types: string[] }> = {};
  for (const [entry, file] of Object.entries(entries)) {
    const module = checker.getSymbolAtLocation(program.getSourceFile(path(file))!)!;
    const names = checker.getExportsOfModule(module).map((symbol) => symbol.name);
    const values = Object.keys((await import(`../src/${file}`)) as object);
    listed[entry] = {
      values: values.sort(),
      types: names.filter((name) => !values.includes(name)).sort(),
    };
  }
  return listed;
}

test("each entry point exports these names and no others", async () => {
  const listed = await surface();
  // The root holds what Python's `dfo` holds at its top level.
  assert.deepEqual(listed["."], {
    values: ["Answer", "Client", "Dataset", "DatasetRef", "VERSION", "latestYear", "recipe"],
    types: ["ClientOptions", "Spec"],
  });
  // `./errors` holds what Python's `dfo.errors` holds.
  assert.deepEqual(listed["./errors"], {
    values: [
      "AuthenticationError",
      "ContractError",
      "DataWarning",
      "DeclinedError",
      "DfoDeprecationWarning",
      "DfoError",
      "DfoTimeoutError",
      "DfoWarning",
      "FormatError",
      "IncompleteAnswerError",
      "InvalidRequestError",
      "NetworkError",
      "NotFoundError",
      "PermissionDeniedError",
      "QuotaExceededError",
      "RateLimitError",
      "SearchWarning",
      "SeriesLeftOutWarning",
      "ServerError",
      "VersionUnavailableError",
      "isDfoError",
    ],
    types: [
      "Action",
      "Alternative",
      "ClientErrorCode",
      "DfoErrorCode",
      "DfoErrorOptions",
      "FormatErrorReason",
      "ProblemIssue",
      "ServerErrorCode",
      "WarningHandler",
    ],
  });
  // `./types` holds the rest.
  assert.deepEqual(listed["./types"], {
    values: [
      "Analysis",
      "ApiKey",
      "Card",
      "Cards",
      "Catalogue",
      "Code",
      "Entity",
      "LatestYear",
      "LeftOutSeries",
      "Lookup",
      "Match",
      "Node",
      "PART_STATUSES",
      "RawResponse",
      "Recipe",
      "Served",
      "Share",
      "isDatasetMember",
      "isDerived",
      "isKnownPart",
      "partFacts",
      "specRoles",
    ],
    types: [
      "AggregateOptions",
      "Aggregation",
      "AnswerDiagnostics",
      "AnswerFetchOptions",
      "AnswerJson",
      "AnswerKind",
      "AnswerStatus",
      "ApiKeyOption",
      "Assumption",
      "AssumptionKind",
      "CallOptions",
      "Candidate",
      "CandidatesPart",
      "CardKind",
      "CardOptions",
      "CatalogueOptions",
      "CatalogueResponse",
      "ChoiceKey",
      "ChooseOptions",
      "Citation",
      "CitationSource",
      "CodeRegistryEntry",
      "Columns",
      "DatasetRefJson",
      "DeclinedReason",
      "DefinitePart",
      "Departure",
      "DepartureCode",
      "DerivedMember",
      "DerivedRefMember",
      "DerivedSpec",
      "Diagnostics",
      "EntityChoice",
      "EntityGroup",
      "EntityGroups",
      "EntityRef",
      "FetchOptions",
      "FilterOptions",
      "Gap",
      "GapKind",
      "GraphNode",
      "Groupby",
      "GrowthChange",
      "GrowthOptions",
      "HeaderProvider",
      "KnownPart",
      "Layout",
      "LeftOutStep",
      "LookupOptions",
      "Member",
      "MemberRequest",
      "Narrowing",
      "NoDataPart",
      "NoDataReason",
      "NodeOptions",
      "Notice",
      "Option",
      "PairOptions",
      "Pairing",
      "ParsedInput",
      "Part",
      "PartFacts",
      "PartyTotalsLeftOut",
      "Progress",
      "ProgressEvent",
      "ProgressHandler",
      "RankOptions",
      "RawRequestOptions",
      "RecipeFetchOptions",
      "RefFetchOptions",
      "RefMember",
      "Rendering",
      "RequestedOperation",
      "ResolveKind",
      "ResolveOptions",
      "ResolveResponse",
      "ResolveResult",
      "ResolvedPeriod",
      "ResolvedSpec",
      "Root",
      "Row",
      "RunOptions",
      "SearchOptions",
      "Severity",
      "ShareFetchOptions",
      "ShareOfOptions",
      "ShareOptions",
      "ShareUrl",
      "SpecFetchOptions",
      "Start",
      "StatChange",
      "StatOptions",
      "UnknownPart",
      "UnsupportedPart",
      "Value",
      "Warning",
      "Window",
      "WriteTokenOptions",
      "Year",
    ],
  });
});

test("VERSION matches package.json", async () => {
  const pkg = await readJson<{ version: string }>("../package.json");
  assert.equal(VERSION, pkg.version);
});

test("hyparquet is the version hyparquet-writer pins, so one copy installs", async () => {
  type Manifest = { dependencies: Record<string, string> };
  const own = await readJson<Manifest>("../package.json");
  const writer = await readJson<Manifest>("../node_modules/hyparquet-writer/package.json");
  assert.equal(own.dependencies["hyparquet"], writer.dependencies["hyparquet"]);
});

test("the node entry point reads the credentials file from the file system", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dfo-credentials-"));
  try {
    const file = join(directory, "credentials.toml");
    await writeFile(file, '[ci]\nkey = "dfo_k_from_file"\n');
    const resolved = await resolveApiKey({
      env: envFrom({ DFO_CREDENTIALS_FILE: file, DFO_PROFILE: "ci" }),
    });
    assert.equal(resolved.source, "credentials_file");
    assert.equal(resolved.key?.reveal(), "dfo_k_from_file");

    const missing = await resolveApiKey({
      env: envFrom({ DFO_CREDENTIALS_FILE: join(directory, "absent.toml") }),
    });
    assert.equal(missing.source, "anonymous");
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("an unreadable credentials file raises credentials_file_unreadable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dfo-credentials-"));
  try {
    const loop = join(directory, "loop.toml");
    await symlink(loop, loop);
    const file = join(directory, "file");
    await writeFile(file, "");
    // A directory, a symlink to itself, and a path through a regular file.
    for (const path of [directory, loop, join(file, "credentials.toml")]) {
      await assert.rejects(resolveApiKey({ env: envFrom({ DFO_CREDENTIALS_FILE: path }) }), {
        name: "AuthenticationError",
        code: "credentials_file_unreadable",
      });
    }
    // Anonymous use reads no file.
    const anonymous = await resolveApiKey({
      apiKey: false,
      env: envFrom({ DFO_CREDENTIALS_FILE: directory }),
    });
    assert.equal(anonymous.source, "anonymous");
  } finally {
    await rm(directory, { recursive: true });
  }
});
