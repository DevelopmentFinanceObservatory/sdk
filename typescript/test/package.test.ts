import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { envFrom } from "../src/env.ts";
import { resolveApiKey } from "../src/index.node.ts";
import { VERSION } from "../src/version.ts";

test("VERSION matches package.json", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  assert.equal(VERSION, pkg.version);
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
