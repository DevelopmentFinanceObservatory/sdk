import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The node entry point installs the file-system credentials reader the key lookup uses.
import "../src/index.node.ts";
import { envFrom } from "../src/config/env.ts";
import { resolveApiKey } from "../src/config/keys.ts";
import { VERSION } from "../src/version.ts";

const readJson = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8")) as T;

test("the root entry exports these values and no others", async () => {
  const root = await import("../src/index.node.ts");
  assert.deepEqual(Object.keys(root).sort(), [
    "Answer",
    "ApiKey",
    "AuthenticationError",
    "Catalogue",
    "Client",
    "Code",
    "ContractError",
    "DataWarning",
    "Dataset",
    "DatasetRef",
    "DeclinedError",
    "DfoDeprecationWarning",
    "DfoError",
    "DfoTimeoutError",
    "DfoWarning",
    "Entity",
    "FormatError",
    "IncompleteAnswerError",
    "InvalidRequestError",
    "Lookup",
    "Match",
    "NetworkError",
    "Node",
    "NotFoundError",
    "PART_STATUSES",
    "PermissionDeniedError",
    "QuotaExceededError",
    "RateLimitError",
    "RawResponse",
    "SearchWarning",
    "ServerError",
    "VERSION",
    "VersionUnavailableError",
    "isDfoError",
    "isKnownPart",
    "specRoles",
  ]);
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
