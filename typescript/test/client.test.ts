import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { Client, clientOver } from "../src/client.ts";
import type { ClientOptions } from "../src/client.ts";
import { envFrom } from "../src/config/env.ts";
import { InvalidRequestError, NotFoundError } from "../src/core/errors.ts";
import { Transport } from "../src/http/transport.ts";
import { json, mockFetch, problem, recordingSleep } from "./support.ts";

const BASE = "https://api.example.org/api";

/** The least of each lookup's body its schema requires. */
const CATALOGUE = { catalogue_version: "c1", counts: {}, examples: [] };
const NODE = { kind: "country", ref: "country/NGA" };
const ENTRY = { code: "spec_not_found", mappings: [] };

function client(fetch: typeof globalThis.fetch, options: ClientOptions = {}): Client {
  return new Client({ baseUrl: BASE, apiKey: "dfo_k_test", fetch, ...options });
}

describe("lookups", () => {
  test("graph.resolve posts the names and options under the base URL", async () => {
    const { fetch, seen } = mockFetch(json({ results: [] }));
    await client(fetch).graph.resolve(["Nigeria", "Sahel"], {
      kinds: ["country", "group"],
      codeSystem: "CRSPurposeCodeEnum",
      expandMembers: true,
    });
    assert.equal(seen[0]!.method, "POST");
    assert.equal(seen[0]!.url, `${BASE}/graph/resolve`);
    assert.deepEqual(JSON.parse(seen[0]!.body!), {
      texts: ["Nigeria", "Sahel"],
      kinds: ["country", "group"],
      code_system: "CRSPurposeCodeEnum",
      expand: ["members"],
    });
  });

  test("graph.node keeps the dcid's slashes and sends as_of only when given", async () => {
    const { fetch, seen } = mockFetch(json(NODE), json(NODE));
    const graph = client(fetch).graph;
    await graph.node("country/NGA");
    await graph.node("dc/g/A B", { asOf: "2024-01-01" });
    assert.equal(seen[0]!.url, `${BASE}/graph/node/country/NGA`);
    assert.equal(seen[1]!.url, `${BASE}/graph/node/dc/g/A%20B?as_of=2024-01-01`);
  });

  test("codes.get reads the registry at the origin root, and raises for an unknown code", async () => {
    const { fetch, seen } = mockFetch(
      json(ENTRY),
      problem({ code: "code_not_found", status: 404 }),
    );
    const codes = client(fetch).codes;
    assert.deepEqual(await codes.get("spec_not_found"), ENTRY);
    assert.equal(seen[0]!.url, "https://api.example.org/codes/spec_not_found");
    await assert.rejects(codes.get("nothing"), NotFoundError);
  });

  for (const dcid of [
    "",
    "../../x",
    "%2e%2e/x",
    "country/./NGA",
    "country/..",
    "a?b=1",
    "a#b",
    "a\u0000b",
  ]) {
    test(`graph.node refuses the dcid ${JSON.stringify(dcid)} before any request`, async () => {
      const { fetch, seen } = mockFetch();
      await assert.rejects(client(fetch).graph.node(dcid), {
        name: "InvalidRequestError",
        code: "invalid_argument",
      });
      assert.equal(seen.length, 0);
    });
  }

  for (const code of ["..", "../datasets", "Spec_not_found", ""]) {
    test(`codes.get refuses the code ${JSON.stringify(code)} before any request`, async () => {
      const { fetch, seen } = mockFetch();
      await assert.rejects(client(fetch).codes.get(code), { code: "invalid_argument" });
      assert.equal(seen.length, 0);
    });
  }

  for (const id of [
    "",
    "op_abc",
    `op_${"A".repeat(64)}`,
    "../x",
    "op_a/../../b",
    "op_a?x=1",
    "op_a b",
    "%2e%2e",
    "\u0000",
  ]) {
    test(`operation refuses the id ${JSON.stringify(id)} before any request`, async () => {
      const { fetch, seen } = mockFetch();
      await assert.rejects(client(fetch).operation(id), {
        name: "InvalidRequestError",
        code: "invalid_argument",
      });
      assert.equal(seen.length, 0);
    });
  }

  test("catalogue scopes to a place when given one", async () => {
    const { fetch, seen } = mockFetch(json(CATALOGUE), json(CATALOGUE));
    const dfo = client(fetch);
    await dfo.catalogue();
    await dfo.catalogue({ place: "country/NGA" });
    assert.equal(seen[0]!.url, `${BASE}/search/catalogue`);
    assert.equal(seen[1]!.url, `${BASE}/search/catalogue?place=country%2FNGA`);
  });

  const problem200 = { type: "about:blank", code: "internal_error", status: 500, detail: "down" };
  const unknown200 = { ...problem200, code: "code_from_a_newer_server" };
  const lookups = [
    ["catalogue", (dfo: Client) => dfo.catalogue()],
    ["codes.get", (dfo: Client) => dfo.codes.get("spec_not_found")],
    ["graph.node", (dfo: Client) => dfo.graph.node("country/NGA")],
    ["graph.resolve", (dfo: Client) => dfo.graph.resolve("Kenya")],
  ] as const;
  for (const [name, call] of lookups) {
    for (const [code, errorName] of [
      ["internal_error", "ServerError"],
      ["query_too_long", "InvalidRequestError"],
      ["rate_limited", "RateLimitError"],
    ] as const) {
      test(`${name} raises a 200 problem document with the code ${code} as ${errorName}`, async () => {
        const body = { ...problem200, code };
        const { fetch } = mockFetch(json(body, 200, { "x-dfo-trace-id": "trace-200" }));
        await assert.rejects(call(client(fetch)), {
          name: errorName,
          code,
          status: 200,
          detail: "down",
          traceId: "trace-200",
        });
      });
    }
  }

  for (const [name, call, body, pointer] of [
    ["catalogue", (dfo: Client) => dfo.catalogue(), unknown200, "/code"],
    ["codes.get", (dfo: Client) => dfo.codes.get("spec_not_found"), null, ""],
    ["codes.get", (dfo: Client) => dfo.codes.get("spec_not_found"), unknown200, "/code"],
    ["graph.node", (dfo: Client) => dfo.graph.node("country/NGA"), { code: "x" }, "/code"],
    ["graph.node", (dfo: Client) => dfo.graph.node("country/NGA"), { kind: 1 }, "/kind"],
    ["graph.resolve", (dfo: Client) => dfo.graph.resolve("Kenya"), [], ""],
  ] as const) {
    test(`${name} refuses a 200 body ${JSON.stringify(body).slice(0, 20)} its schema does not fit`, async () => {
      const { fetch } = mockFetch(json(body, 200, { "x-dfo-trace-id": "trace-200" }));
      await assert.rejects(call(client(fetch)), {
        name: "ContractError",
        code: "contract_violation",
        pointer,
        traceId: "trace-200",
      });
    });
  }
});

describe("request", () => {
  test("sends the client's key and headers and returns the body", async () => {
    const { fetch, seen } = mockFetch(json({ ok: true }));
    const response = await client(fetch, { headers: { "x-team": "data" } }).request(
      "post",
      "/datasets/capabilities",
      { params: { verbose: true, skip: undefined }, json: { a: 1 } },
    );
    assert.equal(seen[0]!.method, "POST");
    assert.equal(seen[0]!.url, `${BASE}/datasets/capabilities?verbose=true`);
    assert.equal(seen[0]!.headers.get("authorization"), "Bearer dfo_k_test");
    assert.equal(seen[0]!.headers.get("x-team"), "data");
    assert.equal(seen[0]!.body, '{"a":1}');
    assert.equal(response.status, 200);
    assert.deepEqual(response.json(), { ok: true });
  });

  test("returns a redirect without following it", async () => {
    const { fetch, seen } = mockFetch(
      () => new Response(null, { status: 302, headers: { location: "https://storage/x" } }),
    );
    const response = await client(fetch).request("GET", "/datasets/spec_1/cv_1/file");
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "https://storage/x");
    assert.equal(seen.length, 1);
  });

  for (const [baseUrl, path] of [
    [BASE, "datasets"],
    [BASE, "https://evil.example/x"],
    [BASE, "//evil.example/x"],
    ["https://api.example.org", "//evil.example/x"],
    ["https://api.example.org", "/\\evil.example/x"],
    ["https://api.example.org", "/\t/evil.example/x"],
    [BASE, "/../../etc/passwd"],
    [BASE, "/%2e%2e/other"],
    [BASE, "/a b\r\nX-Injected: 1"],
  ] as const) {
    test(`refuses ${JSON.stringify(path)} on ${baseUrl}, which is not a path on it`, async () => {
      const { fetch, seen } = mockFetch();
      await assert.rejects(client(fetch, { baseUrl }).request("GET", path), {
        name: "InvalidRequestError",
        code: "invalid_argument",
      });
      assert.equal(seen.length, 0);
    });
  }

  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  for (const [name, method, options] of [
    ["a GET with a body", "GET", { json: { a: 1 } }],
    ["a HEAD with a body", "HEAD", { json: {} }],
    ["CONNECT", "CONNECT", {}],
    ["TRACE", "TRACE", {}],
    ["an empty method", "", {}],
    ["a method with a line break", "GET /y HTTP/1.1\r\nX: 1", {}],
    ["a BigInt body", "POST", { json: { a: 1n } }],
    ["a cyclic body", "POST", { json: cyclic }],
    ["a NaN in the body", "POST", { json: { b: Number.NaN } }],
    ["an infinity in the body", "POST", { json: [Infinity] }],
    ["a NaN timeout", "GET", { timeout: Number.NaN }],
    ["a timeout of 0", "GET", { timeout: 0 }],
  ] as const) {
    test(`refuses ${name} before any request, with no retry`, async () => {
      const { fetch, seen } = mockFetch();
      await assert.rejects(client(fetch).request(method, "/x", options), {
        name: "InvalidRequestError",
        code: "invalid_argument",
        retryable: false,
      });
      assert.equal(seen.length, 0);
    });
  }

  /** Headers from another fetch implementation, such as npm undici's, which are not instances
   *  of the global Headers. */
  class ForeignHeaders {
    readonly #values = new Map([["content-type", "application/json"]]);
    get(name: string): string | null {
      return this.#values.get(name.toLowerCase()) ?? null;
    }
  }
  const body = new TextEncoder().encode('{"ok":true}');
  for (const [name, read] of [
    ["a body stream", { body: new Blob([body]).stream() }],
    ["arrayBuffer alone", { arrayBuffer: () => Promise.resolve(body.buffer) }],
  ] as const) {
    test(`reads a Response from another fetch implementation, with ${name}`, async () => {
      const fetch = (() =>
        Promise.resolve({
          status: 200,
          headers: new ForeignHeaders(),
          ...read,
        })) as unknown as typeof globalThis.fetch;
      const response = await client(fetch).request("GET", "/x");
      assert.equal(response.status, 200);
      assert.deepEqual(response.json(), { ok: true });
    });
  }

  test("refuses a fetch option's value that is not a Response, with no retry", async () => {
    let calls = 0;
    const fetch = (() => {
      calls += 1;
      return Promise.resolve({ ok: true });
    }) as unknown as typeof globalThis.fetch;
    await assert.rejects(client(fetch).request("GET", "/x"), {
      name: "InvalidRequestError",
      code: "invalid_argument",
    });
    assert.equal(calls, 1);
  });

  test("raises a refused method as the caller's InvalidRequestError, and a wrapped route's as ContractError", async () => {
    const refused = problem({ code: "method_not_allowed", status: 405, trace_id: "trace-405" });
    const { fetch } = mockFetch(refused, refused);
    const dfo = client(fetch);
    const raw = await dfo.request("DELETE", "/search/catalogue").catch((e: unknown) => e);
    assert.ok(raw instanceof InvalidRequestError);
    assert.equal(raw.code, "method_not_allowed");
    assert.equal(raw.status, 405);
    assert.equal(raw.traceId, "trace-405");
    await assert.rejects(dfo.catalogue(), { name: "ContractError", code: "method_not_allowed" });
  });
});

describe("limits", () => {
  for (const [name, options] of [
    ["timeout NaN", { timeout: Number.NaN }],
    ["timeout Infinity", { timeout: Infinity }],
    ["timeout 0", { timeout: 0 }],
    ["timeout -1", { timeout: -1 }],
    ["timeout as a string", { timeout: "500" }],
    ["timeout null", { timeout: null }],
    ["timeout true", { timeout: true }],
    ["maxRetries NaN", { maxRetries: Number.NaN }],
    ["maxRetries Infinity", { maxRetries: Infinity }],
    ["maxRetries 1.5", { maxRetries: 1.5 }],
    ["maxRetries -1", { maxRetries: -1 }],
    ["maxRetries 11", { maxRetries: 11 }],
    ["maxRetries true", { maxRetries: true }],
  ] as const) {
    test(`refuse ${name} when the client is built and in withOptions`, () => {
      const given = options as unknown as ClientOptions;
      const { fetch } = mockFetch();
      const refused = { name: "InvalidRequestError", code: "invalid_argument" };
      assert.throws(() => client(fetch, given), refused);
      assert.throws(() => client(fetch).withOptions(given), refused);
    });
  }

  test("take timeouts and retry counts in range", () => {
    const { fetch } = mockFetch();
    const dfo = client(fetch, { timeout: 0.5, maxRetries: 0 }).withOptions({
      timeout: 2 ** 40,
      maxRetries: 10,
    });
    assert.ok(dfo instanceof Client);
  });

  for (const timeout of [Number.NaN, 0, -5, "60000"]) {
    test(`refuse a search timeout of ${JSON.stringify(timeout)} before any request`, async () => {
      const { fetch, seen } = mockFetch();
      await assert.rejects(client(fetch).search("aid to Kenya", { timeout: timeout as number }), {
        name: "InvalidRequestError",
        code: "invalid_argument",
      });
      assert.equal(seen.length, 0);
    });
  }

  for (const question of ["", "   ", "\t\n", "\u00a0\u3000", "aid \ud800", "\udc00 aid", null, 5]) {
    test(`refuse a search question of ${JSON.stringify(question)} before any request`, async () => {
      const { fetch, seen } = mockFetch();
      await assert.rejects(client(fetch).search(question as string), {
        name: "InvalidRequestError",
        code: "invalid_argument",
      });
      assert.equal(seen.length, 0);
    });
  }
});

describe("withOptions", () => {
  test("shares the fetch, headers and key, with its own retry limit", async () => {
    let lookups = 0;
    const { sleep, waits } = recordingSleep();
    const { fetch, seen } = mockFetch(
      json(CATALOGUE),
      problem({ code: "upstream_unavailable", status: 503, retryable: true }),
      problem({ code: "upstream_unavailable", status: 503, retryable: true }),
    );
    // A transport built by hand injects the sleep, which the client's options do not offer.
    const transport = new Transport({
      baseUrl: BASE,
      apiKey: () => {
        lookups += 1;
        return "dfo_k_shared";
      },
      fetch,
      sleep,
      env: envFrom({}),
      headerProvider: () => ({ "x-token": "t" }),
    });
    const original = clientOver(transport);
    await original.catalogue();
    const copy = original.withOptions({ maxRetries: 1 });
    await assert.rejects(copy.catalogue());
    assert.equal(lookups, 1);
    assert.equal(seen.length, 3);
    assert.equal(waits.length, 1);
    for (const request of seen) {
      assert.equal(request.headers.get("authorization"), "Bearer dfo_k_shared");
      assert.equal(request.headers.get("x-token"), "t");
    }
    assert.equal(copy.baseUrl, original.baseUrl);
  });
});
