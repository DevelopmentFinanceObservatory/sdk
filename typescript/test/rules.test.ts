// Replays the contract's rule vectors for keys and credentials. The cache rules have no
// TypeScript counterpart: this client keeps no cache on disk.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { credentialsPath, parseCredentialsFile } from "../src/credentials.ts";
import type { Platform } from "../src/credentials.ts";
import { envFrom } from "../src/env.ts";
import { isDfoError } from "../src/errors.ts";
import { checkKeyFormat, resolveApiKey } from "../src/keys.ts";
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
          return Promise.resolve(vector.file);
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
  }
});

describe("an empty key", () => {
  const file = '[default]\nkey = ""\n';
  for (const [name, apiKey, code] of [
    ["argument raises the key-format code", "", "key_empty"],
    ["argument from a function raises the key-format code", () => "", "key_empty"],
    ["in the chosen profile raises profile_without_key", undefined, "profile_without_key"],
  ] as const) {
    test(name, async () => {
      await assert.rejects(
        resolveApiKey({
          apiKey,
          env: envFrom({}),
          readCredentialsFile: () => Promise.resolve(file),
        }),
        { name: "AuthenticationError", code },
      );
    });
  }
});

test("a profile named __proto__ is a profile like any other", () => {
  const parsed = parseCredentialsFile('[__proto__]\nkey = "dfo_k_x"\n');
  assert.ok(parsed.ok);
  assert.equal(Object.getPrototypeOf(parsed.profiles), null);
  assert.equal(parsed.profiles["__proto__"]?.["key"], "dfo_k_x");
});
