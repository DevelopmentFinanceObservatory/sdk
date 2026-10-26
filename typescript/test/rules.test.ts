// Replays the contract's rule vectors for keys, credentials and the column order. The cache
// rules have no TypeScript counterpart: this client keeps no cache on disk.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parquetWriteBuffer } from "hyparquet-writer";

import { credentialsPath, parseCredentialsFile } from "../src/config/credentials.ts";
import type { Platform } from "../src/config/credentials.ts";
import { envFrom } from "../src/config/env.ts";
import { isDfoError } from "../src/core/errors.ts";
import { checkKeyFormat, resolveApiKey } from "../src/config/keys.ts";
import { Transport } from "../src/http/transport.ts";
import { readParquet, stackedColumns } from "../src/datasets/parquet.ts";
import { contractJson } from "./support.ts";

type Suite<T> = { rule: string; vectors: (T & { name: string })[] };

async function vectors<T>(rule: string): Promise<(T & { name: string })[]> {
  const suite = await contractJson<Suite<T>>(`rules/${rule}.json`);
  assert.equal(suite.rule, rule);
  assert.ok(suite.vectors.length > 0, `contract/rules/${rule}.json holds no vectors`);
  return suite.vectors;
}

describe("key-format", async () => {
  for (const vector of await vectors<{ key: string; verdict: string; reason?: string }>(
    "key-format",
  )) {
    test(vector.name, () => {
      const expected =
        vector.verdict === "pass"
          ? { verdict: "pass" }
          : { verdict: "warn", reason: vector.reason };
      assert.deepEqual(checkKeyFormat(vector.key), expected);
    });
  }
});

describe("credentials-path", async () => {
  type Vector = { platform: Platform; home: string; env: Record<string, string>; path: string };
  for (const vector of await vectors<Vector>("credentials-path")) {
    test(vector.name, () => {
      const env = envFrom(vector.env);
      assert.equal(
        credentialsPath({ platform: vector.platform, home: vector.home, env }),
        vector.path,
      );
    });
  }
});

describe("credentials-file", async () => {
  type Vector = {
    text: string;
    profiles?: Record<string, Record<string, string>>;
    error?: { reason: string; line: number };
  };
  for (const vector of await vectors<Vector>("credentials-file")) {
    test(vector.name, () => {
      const parsed = parseCredentialsFile(vector.text);
      if (vector.error === undefined) {
        assert.ok(parsed.ok);
        // Profiles have null prototypes, so a profile named __proto__ stays a profile.
        assert.deepEqual(JSON.parse(JSON.stringify(parsed.profiles)), vector.profiles);
      } else {
        assert.deepEqual(parsed, { ok: false, ...vector.error });
      }
    });
  }
});

describe("key-lookup", async () => {
  type Vector = {
    api_key?: string | false;
    env: Record<string, string>;
    file: string | null;
    source?: string;
    key?: string | null;
    error?: { reason: string };
  };
  for (const vector of await vectors<Vector>("key-lookup")) {
    test(vector.name, async () => {
      let reads = 0;
      const resolution = resolveApiKey({
        apiKey: vector.api_key,
        env: envFrom(vector.env),
        readCredentialsFile: () => {
          reads += 1;
          return vector.file;
        },
      });
      if (vector.error !== undefined) {
        await assert.rejects(
          resolution,
          (error) => isDfoError(error) && error.code === vector.error?.reason,
        );
        return;
      }
      const resolved = await resolution;
      assert.equal(resolved.source, vector.source);
      assert.equal(resolved.key?.reveal() ?? null, vector.key);
      // The file is read only when no earlier source wins.
      const earlier = vector.source === "argument" || vector.source === "environment";
      assert.equal(reads, earlier || vector.api_key === false ? 0 : 1);
    });

    // A client resolves its key when it is built, so a fault raises from the constructor and a
    // key is resolved before any request.
    test(`${vector.name}: resolved when the client is built`, async () => {
      let reads = 0;
      const build = () =>
        new Transport({
          ...(vector.api_key === undefined ? {} : { apiKey: vector.api_key }),
          env: envFrom(vector.env),
          readCredentialsFile: () => {
            reads += 1;
            return vector.file;
          },
          onWarning: () => undefined,
        });
      if (vector.error !== undefined) {
        assert.throws(build, (error) => isDfoError(error) && error.code === vector.error?.reason);
        return;
      }
      const transport = build();
      const read = reads;
      assert.equal((await transport.apiKey()).key?.reveal() ?? null, vector.key);
      assert.equal(reads, read);
    });
  }
});

// The key-lookup vectors pass strings; a function returning an empty key raises as an empty
// string does.
test("an empty key from an apiKey function raises key_empty", async () => {
  await assert.rejects(
    resolveApiKey({
      apiKey: () => "",
      env: envFrom({}),
      readCredentialsFile: () => null,
    }),
    { name: "AuthenticationError", code: "key_empty" },
  );
});

test("a profile named __proto__ is a profile like any other", () => {
  const parsed = parseCredentialsFile('[__proto__]\nkey = "dfo_k_x"\n');
  assert.ok(parsed.ok);
  assert.equal(Object.getPrototypeOf(parsed.profiles), null);
  assert.equal(parsed.profiles["__proto__"]?.["key"], "dfo_k_x");
});

describe("column-order", async () => {
  type Vector = { columns?: string[]; members?: string[][]; ordered: string[] };
  /** A one-row file holding the columns in the order given, as the server writes them. */
  const file = (columns: readonly string[]) =>
    readParquet(
      new Uint8Array(
        parquetWriteBuffer({ columnData: columns.map((name) => ({ name, data: ["x"] })) }),
      ),
    );
  for (const vector of await vectors<Vector>("column-order")) {
    test(vector.name, () => {
      const members = vector.members ?? [vector.columns ?? []];
      const parts = members.map((columns, index) => ({ file: file(columns), label: `${index}` }));
      assert.deepEqual(
        stackedColumns(parts).map((column) => column.name),
        vector.ordered,
      );
    });
  }
});
