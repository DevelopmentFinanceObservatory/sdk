import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { Client, clientOver } from "../src/client.ts";
import type { ClientOptions } from "../src/client.ts";
import { envFrom } from "../src/env.ts";
import { NotFoundError } from "../src/errors.ts";
import { Transport } from "../src/transport.ts";
import { json, mockFetch, problem, recordingSleep } from "./support.ts";

const BASE = "https://api.example.org/api";

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
    const { fetch, seen } = mockFetch(json({ kind: "country" }), json({ kind: "country" }));
    const graph = client(fetch).graph;
    await graph.node("country/NGA");
    await graph.node("dc/g/A B", { asOf: "2024-01-01" });
    assert.equal(seen[0]!.url, `${BASE}/graph/node/country/NGA`);
    assert.equal(seen[1]!.url, `${BASE}/graph/node/dc/g/A%20B?as_of=2024-01-01`);
  });

  test("codes.get reads the registry at the origin root, and raises for an unknown code", async () => {
    const { fetch, seen } = mockFetch(
      json({ code: "spec_not_found" }),
      problem({ code: "code_not_found", status: 404 }),
    );
    const codes = client(fetch).codes;
    assert.deepEqual(await codes.get("spec_not_found"), { code: "spec_not_found" });
    assert.equal(seen[0]!.url, "https://api.example.org/codes/spec_not_found");
    await assert.rejects(codes.get("nothing"), NotFoundError);
  });

  test("catalogue scopes to a place when given one", async () => {
    const { fetch, seen } = mockFetch(json({}), json({}));
    const dfo = client(fetch);
    await dfo.catalogue();
    await dfo.catalogue({ place: "country/NGA" });
    assert.equal(seen[0]!.url, `${BASE}/search/catalogue`);
    assert.equal(seen[1]!.url, `${BASE}/search/catalogue?place=country%2FNGA`);
  });
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
});

describe("withOptions", () => {
  test("shares the fetch, headers and key, with its own retry limit", async () => {
    let lookups = 0;
    const { sleep, waits } = recordingSleep();
    const { fetch, seen } = mockFetch(
      json({}),
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
