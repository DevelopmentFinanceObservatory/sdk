// Replays the contract's rule vectors for keys, credentials, the reading order, role keys and the
// client's identity. The cache rules have no TypeScript counterpart: this client keeps no cache on disk.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parquetWriteBuffer } from "hyparquet-writer";

import { credentialsPath, parseCredentialsFile } from "../src/config/credentials.ts";
import type { Platform } from "../src/config/credentials.ts";
import { envFrom } from "../src/config/env.ts";
import { isDfoError } from "../src/core/errors.ts";
import { checkKeyFormat, resolveApiKey } from "../src/config/keys.ts";
import { clientOver } from "../src/client.ts";
import { Transport } from "../src/http/transport.ts";
import {
  CLIENT_HEADER,
  clientIdentity,
  currentRuntime,
  ownIdentity,
} from "../src/http/client-identity.ts";
import type { Runtime } from "../src/http/client-identity.ts";
import { VERSION } from "../src/version.ts";
import { Dataset } from "../src/datasets/dataset.ts";
import type { FetchedMember } from "../src/datasets/dataset.ts";
import { readingOrder } from "../src/datasets/reading-order.ts";
import { fetchDataset } from "../src/datasets/resolve.ts";
import { specRoles } from "../src/core/roles.ts";
import { FLOW_KEYS, ROLE_KEYS } from "../src/generated/role-keys.ts";
import { contractJson, json, mockFetch, problem } from "./support.ts";

type Suite<T> = { rule: string; vectors: (T & { name: string })[] };

async function vectors<T>(rule: string): Promise<(T & { name: string })[]> {
  const suite = await contractJson<Suite<T>>(`rules/${rule}.json`);
  assert.equal(suite.rule, rule);
  assert.ok(suite.vectors.length > 0, `contract/rules/${rule}.json holds no vectors`);
  return suite.vectors;
}

describe("base-url", async () => {
  type Vector = {
    base_url?: string;
    env: Record<string, string>;
    source?: "argument" | "environment" | "default";
    url?: string;
    error?: { reason: string };
  };
  const sources = { argument: "argument", environment: "DFO_BASE_URL", default: "default" };
  for (const vector of await vectors<Vector>("base-url")) {
    test(vector.name, () => {
      const build = () =>
        new Transport({
          apiKey: false,
          env: envFrom(vector.env),
          ...(vector.base_url === undefined ? {} : { baseUrl: vector.base_url }),
        });
      if (vector.error !== undefined) {
        assert.throws(build, (error) => isDfoError(error) && error.code === vector.error?.reason);
        return;
      }
      const transport = build();
      assert.equal(transport.baseUrlSource, sources[vector.source!]);
      assert.equal(clientOver(transport).baseUrl, vector.url);
    });
  }
});

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

describe("reading-order", async () => {
  type Cell = string | number | null;
  type Member = { part?: string; columns: string[]; rows: Cell[][] };
  type Vector = { members: Member[]; columns: string[]; rows: Cell[][] };
  /** A member's file as the server writes it: a number column as doubles, every other as
   *  strings. */
  const file = ({ columns, rows }: Member): Uint8Array =>
    new Uint8Array(
      parquetWriteBuffer({
        columnData: columns.map((name, at) => {
          const data = rows.map((row) => row[at] ?? null);
          const numbers = data.some((value) => typeof value === "number");
          return { name, data, type: numbers ? "DOUBLE" : "STRING" };
        }),
      }),
    );
  for (const vector of await vectors<Vector>("reading-order")) {
    test(vector.name, async () => {
      const members = vector.members.map((member) => {
        const data = file(member);
        return {
          parts: member.part === undefined ? [] : [member.part],
          spec: { spec_id: "spec", definition: {} },
          sentence: "A sentence.",
          contentVersion: "cv",
          manifest: {},
          digest: "sha256:unchecked",
          rendering: { format: "parquet", bundle: false },
          data,
        } satisfies FetchedMember;
      });
      const dataset = await Dataset.create(members, { layout: "long" });
      assert.deepEqual(dataset.columns, vector.columns);
      const rows = await dataset.toRows();
      assert.deepEqual(
        rows.map((row) => dataset.columns.map((name) => row[name])),
        vector.rows,
      );
    });
  }
});

test("reading-order sorts strings by code point and NaN after every number", () => {
  // UTF-16 code units put U+1F600's surrogates before U+FF5E; code points put it after.
  const order = readingOrder(
    [
      { name: "label", values: ["\u{1F600}", "\uFF5E", null, "\u{1F600}", "\u{1F600}"] },
      { name: "share", values: [1, 2, 3, Number.NaN, 0] },
    ],
    [5],
  );
  assert.deepEqual(order.columns, ["label", "share"]);
  assert.deepEqual([...order.rows], [1, 4, 0, 3, 2]);
});

describe("role-keys", async () => {
  type Roles = Record<string, string[] | null>;
  type Vector = {
    identity: Record<string, unknown>;
    roles: Roles;
    entities?: Roles;
    posted?: Record<string, string[]>;
    error?: { reason: string; names: string[] };
  };
  const rule = await contractJson<{ keys: unknown; flow_keys: unknown }>("rules/role-keys.json");

  test("the generated key map is the rule's", () => {
    assert.deepEqual(ROLE_KEYS, rule.keys);
    assert.deepEqual(FLOW_KEYS, rule.flow_keys);
  });

  for (const vector of await vectors<Vector>("role-keys")) {
    test(vector.name, async () => {
      const spec = {
        spec_id: "spec_1",
        definition: { spec_id: "spec_1", identity: vector.identity },
      };
      assert.deepEqual(specRoles(spec), vector.roles);
      if (vector.entities === undefined) return;
      // The build is refused, so the request the client posted is the one to read.
      const { fetch, seen } = mockFetch(problem({ code: "request_invalid", status: 400 }));
      const transport = new Transport({
        baseUrl: "https://api.example/api",
        apiKey: false,
        env: envFrom({}),
        readCredentialsFile: () => null,
        fetch,
        onWarning: () => undefined,
      });
      const fetching = fetchDataset(transport, spec, { entities: vector.entities });
      if (vector.error !== undefined) {
        const { reason, names } = vector.error;
        let detail = "";
        await assert.rejects(fetching, (error) => {
          assert.ok(isDfoError(error) && error.code === reason);
          detail = error.detail;
          return true;
        });
        assert.equal(seen.length, 0);
        const at = names.map((name) => detail.indexOf(name));
        assert.ok(
          at.every((index) => index >= 0),
          `${detail} names each of ${names.join(", ")}`,
        );
        assert.ok(
          at.slice(1).every((index) => index > at[0]!),
          `${detail} names ${names[0]} first`,
        );
        return;
      }
      await assert.rejects(fetching, { code: "request_invalid" });
      const body = JSON.parse(seen[0]!.body!) as { input: { scope: { entities: unknown } } };
      assert.deepEqual(body.input.scope.entities, vector.posted);
    });
  }
});

describe("client-identity", async () => {
  type Vector = {
    client?: string;
    version?: string;
    runtime?: Runtime | { name: string; version: string };
    value?: string;
    via?: "argument" | "provider";
    headers?: Record<string, string>;
    verdict?: "accept" | "refuse";
    reason?: string;
  };
  const rule = await contractJson<{ header: string; pattern: string }>(
    "rules/client-identity.json",
  );
  const all = await vectors<Vector>("client-identity");

  test("the header is the rule's, and this runtime's value matches its pattern", () => {
    assert.equal(CLIENT_HEADER, rule.header);
    assert.match(ownIdentity(), new RegExp(rule.pattern));
    assert.equal(ownIdentity(), clientIdentity(VERSION, currentRuntime()));
    assert.equal(currentRuntime().name, "Node");
  });

  for (const vector of all.filter(({ client }) => client === "dfo-ts")) {
    test(vector.name, () => {
      const value = clientIdentity(vector.version!, vector.runtime as Runtime);
      assert.equal(value, vector.value);
      assert.match(value, new RegExp(rule.pattern));
    });
  }

  for (const vector of all.filter(({ via }) => via !== undefined)) {
    test(vector.name, async () => {
      const { fetch, seen } = mockFetch(json({}));
      const headers = vector.headers!;
      const send = async () =>
        new Transport({
          apiKey: false,
          env: envFrom({}),
          readCredentialsFile: () => null,
          fetch,
          ...(vector.via === "argument"
            ? { defaultHeaders: headers }
            : { headerProvider: () => headers }),
        }).request({ path: "/x" });
      if (vector.verdict === "refuse") {
        await assert.rejects(send, { name: "InvalidRequestError", code: vector.reason });
        assert.equal(seen.length, 0);
      } else {
        await send();
        assert.equal(seen[0]?.headers.get(CLIENT_HEADER), ownIdentity());
      }
    });
  }
});
