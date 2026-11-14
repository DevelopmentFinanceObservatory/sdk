import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { inspect } from "node:util";

import { Client, clientOver } from "../src/client.ts";
import type { ClientOptions } from "../src/client.ts";
import { envFrom } from "../src/config/env.ts";
import { InvalidRequestError, NotFoundError } from "../src/core/errors.ts";
import { Transport } from "../src/http/transport.ts";
import { json, mockFetch, problem, recordingSleep } from "./support.ts";

const BASE = "https://api.example.org/api";

/** The least of each lookup's body its schema requires. */
const CATALOGUE = { catalogue_version: "c1", counts: {}, examples: [] };
const NODE = { kind: "country", ref: "country/NGA", types: [] };
const ENTRY = { code: "spec_not_found", mappings: [] };
const KENYA = {
  input: "Kenya",
  status: "resolved",
  entity: { ref: "country/KEN", label: "Kenya", kind: "country" },
  candidates: null,
  near_matches: null,
};

function client(fetch: typeof globalThis.fetch, options: ClientOptions = {}): Client {
  return new Client({ baseUrl: BASE, apiKey: "dfo_k_test", fetch, ...options });
}

describe("lookups", () => {
  test("lookup.resolve posts the names and options under the base URL", async () => {
    const { fetch, seen } = mockFetch(json({ results: [] }));
    await client(fetch).lookup.resolve(["Nigeria", "Sahel"], {
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

  test("lookup.resolve gives one match per name, in order, with the result as raw", async () => {
    const germny = {
      ...KENYA,
      input: "Germny",
      status: "not_found",
      entity: null,
      near_matches: [{ ref: "country/DEU", label: "Germany", kind: "country" }],
    };
    const { fetch } = mockFetch(json({ results: [KENYA, germny] }));
    const [kenya, nearest] = await client(fetch).lookup.resolve(["Kenya", "Germny"]);
    assert.deepEqual(
      [kenya!.text, kenya!.status, kenya!.entity?.dcid, kenya!.entity?.name, kenya!.entity?.kind],
      ["Kenya", "resolved", "country/KEN", "Kenya", "country"],
    );
    assert.deepEqual([kenya!.candidates, kenya!.nearMatches], [[], []]);
    assert.equal(nearest!.entity, null);
    assert.deepEqual(
      nearest!.nearMatches.map((entity) => entity.dcid),
      ["country/DEU"],
    );
    assert.deepEqual(nearest!.raw, germny);
    assert.ok(
      Object.isFrozen(kenya) &&
        Object.isFrozen(kenya!.entity) &&
        Object.isFrozen(kenya!.nearMatches),
    );
  });

  test("lookup.node, code and catalogue read their fields and keep the body as raw", async () => {
    const node = { ...NODE, label: "Nigeria", types: ["Country"], country: {} };
    const entry = { ...ENTRY, definition: "No spec." };
    const catalogue = { ...CATALOGUE, examples: [{ text: "GDP of Kenya", place: "country/KEN" }] };
    const { fetch } = mockFetch(json(node), json(entry), json(catalogue));
    const lookup = client(fetch).lookup;
    const read = await lookup.node("country/NGA");
    assert.deepEqual(
      [read.dcid, read.name, read.kind, read.types],
      ["country/NGA", "Nigeria", "country", ["Country"]],
    );
    assert.deepEqual(read.raw, node);
    const code = await lookup.code("spec_not_found");
    assert.deepEqual([code.code, code.definition], ["spec_not_found", "No spec."]);
    const held = await lookup.catalogue();
    assert.deepEqual([held.version, held.counts, held.examples], ["c1", {}, ["GDP of Kenya"]]);
    assert.deepEqual(held.raw, catalogue);
  });

  test("lookup.node keeps the dcid's slashes and sends as_of only when given", async () => {
    const { fetch, seen } = mockFetch(json(NODE), json(NODE));
    const lookup = client(fetch).lookup;
    await lookup.node("country/NGA");
    await lookup.node("dc/g/A B", { asOf: "2024-01-01" });
    assert.equal(seen[0]!.url, `${BASE}/graph/node/country/NGA`);
    assert.equal(seen[1]!.url, `${BASE}/graph/node/dc/g/A%20B?as_of=2024-01-01`);
  });

  test("lookup.code reads the registry at the origin root, and raises for an unknown code", async () => {
    const { fetch, seen } = mockFetch(
      json(ENTRY),
      problem({ code: "code_not_found", status: 404 }),
    );
    const lookup = client(fetch).lookup;
    assert.deepEqual((await lookup.code("spec_not_found")).raw, ENTRY);
    assert.equal(seen[0]!.url, "https://api.example.org/codes/spec_not_found");
    await assert.rejects(lookup.code("nothing"), NotFoundError);
  });

  for (const dcid of [
    "",
    "../../x",
    "%2e%2e/x",
    "..%2fx",
    "a/.%5Cb",
    "country/./NGA",
    "country/..",
    "a?b=1",
    "a#b",
    "a\u0000b",
  ]) {
    test(`lookup.node refuses the dcid ${JSON.stringify(dcid)} before any request`, async () => {
      const { fetch, seen } = mockFetch();
      await assert.rejects(client(fetch).lookup.node(dcid), {
        name: "InvalidRequestError",
        code: "invalid_argument",
      });
      assert.equal(seen.length, 0);
    });
  }

  for (const code of ["..", "../datasets", "Spec_not_found", ""]) {
    test(`lookup.code refuses the code ${JSON.stringify(code)} before any request`, async () => {
      const { fetch, seen } = mockFetch();
      await assert.rejects(client(fetch).lookup.code(code), { code: "invalid_argument" });
      assert.equal(seen.length, 0);
    });
  }

  test("lookup.catalogue scopes to a place when given one", async () => {
    const { fetch, seen } = mockFetch(json(CATALOGUE), json(CATALOGUE));
    const dfo = client(fetch);
    await dfo.lookup.catalogue();
    await dfo.lookup.catalogue({ place: "country/NGA" });
    assert.equal(seen[0]!.url, `${BASE}/search/catalogue`);
    assert.equal(seen[1]!.url, `${BASE}/search/catalogue?place=country%2FNGA`);
  });

  const problem200 = { type: "about:blank", code: "internal_error", status: 500, detail: "down" };
  const unknown200 = { ...problem200, code: "code_from_a_newer_server" };
  const lookups = [
    ["lookup.catalogue", (dfo: Client) => dfo.lookup.catalogue()],
    ["lookup.code", (dfo: Client) => dfo.lookup.code("spec_not_found")],
    ["lookup.node", (dfo: Client) => dfo.lookup.node("country/NGA")],
    ["lookup.resolve", (dfo: Client) => dfo.lookup.resolve("Kenya")],
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

  // The rows after the problem-document ones are those of
  // `test_a_lookup_refuses_a_body_its_schema_does_not_fit` in Python's test_client.py: each
  // member the wire schema requires and admits no null for, missing or of another type.
  for (const [name, call, body, pointer] of [
    ["lookup.catalogue", (dfo: Client) => dfo.lookup.catalogue(), unknown200, "/code"],
    ["lookup.code", (dfo: Client) => dfo.lookup.code("spec_not_found"), null, ""],
    ["lookup.code", (dfo: Client) => dfo.lookup.code("spec_not_found"), unknown200, "/code"],
    ["lookup.node", (dfo: Client) => dfo.lookup.node("country/NGA"), { code: "x" }, "/code"],
    ["lookup.node", (dfo: Client) => dfo.lookup.node("country/NGA"), { ...NODE, kind: 1 }, "/kind"],
    ["lookup.node", (dfo: Client) => dfo.lookup.node("country/NGA"), { kind: "country" }, "/ref"],
    [
      "lookup.node",
      (dfo: Client) => dfo.lookup.node("country/NGA"),
      { ...NODE, types: null },
      "/types",
    ],
    ["lookup.code", (dfo: Client) => dfo.lookup.code("spec_not_found"), { mappings: [] }, "/code"],
    ["lookup.resolve", (dfo: Client) => dfo.lookup.resolve("Kenya"), [], ""],
    ["lookup.resolve", (dfo: Client) => dfo.lookup.resolve("Kenya"), { results: {} }, "/results"],
    [
      "lookup.resolve",
      (dfo: Client) => dfo.lookup.resolve("Kenya"),
      { results: [{ status: "resolved" }] },
      "/results/0/input",
    ],
    [
      "lookup.resolve",
      (dfo: Client) => dfo.lookup.resolve("Kenya"),
      { results: [{ input: "Kenya" }] },
      "/results/0/status",
    ],
    [
      "lookup.resolve",
      (dfo: Client) => dfo.lookup.resolve("Kenya"),
      { results: [{ ...KENYA, entity: {} }] },
      "/results/0/entity/ref",
    ],
    [
      "lookup.resolve",
      (dfo: Client) => dfo.lookup.resolve("Kenya"),
      { results: [{ ...KENYA, entity: { ref: "country/KEN" } }] },
      "/results/0/entity/label",
    ],
    [
      "lookup.resolve",
      (dfo: Client) => dfo.lookup.resolve("Kenya"),
      { results: [{ ...KENYA, candidates: [{ label: "Kenya" }] }] },
      "/results/0/candidates/0/ref",
    ],
    [
      "lookup.resolve",
      (dfo: Client) => dfo.lookup.resolve("Kenya"),
      { results: [{ ...KENYA, near_matches: [1] }] },
      "/results/0/near_matches/0",
    ],
    [
      "lookup.resolve",
      (dfo: Client) => dfo.lookup.resolve("Kenya"),
      { results: [{ ...KENYA, near_matches: [{ ref: "x" }] }] },
      "/results/0/near_matches/0/label",
    ],
    [
      "lookup.catalogue",
      (dfo: Client) => dfo.lookup.catalogue(),
      { counts: {}, examples: [] },
      "/catalogue_version",
    ],
    [
      "lookup.catalogue",
      (dfo: Client) => dfo.lookup.catalogue(),
      { ...CATALOGUE, counts: [] },
      "/counts",
    ],
    [
      "lookup.catalogue",
      (dfo: Client) => dfo.lookup.catalogue(),
      { ...CATALOGUE, examples: null },
      "/examples",
    ],
    [
      "lookup.catalogue",
      (dfo: Client) => dfo.lookup.catalogue(),
      { ...CATALOGUE, examples: [1] },
      "/examples/0",
    ],
    [
      "lookup.catalogue",
      (dfo: Client) => dfo.lookup.catalogue(),
      { ...CATALOGUE, examples: [{}] },
      "/examples/0/text",
    ],
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

describe("lookups read tolerantly", () => {
  // The same body as `test_a_lookup_reads_a_nullable_member_of_another_type_as_absent` in
  // Python's test_client.py.
  test("lookups read a nullable member of another type as absent", async () => {
    const unclassified = { ref: "country/KEN", label: "Kenya" };
    const malformed = { entity: "x", candidates: "x", near_matches: {} };
    const { fetch } = mockFetch(
      json({
        results: [
          { ...KENYA, ...malformed },
          { ...KENYA, entity: unclassified },
        ],
      }),
      json({ ...NODE, types: ["Country", 1] }),
    );
    const dfo = client(fetch);
    const [malformedMatch, unclassifiedMatch] = await dfo.lookup.resolve("Kenya");
    const node = await dfo.lookup.node("country/NGA");
    assert.deepEqual(
      [malformedMatch!.entity, malformedMatch!.candidates, malformedMatch!.nearMatches],
      [null, [], []],
    );
    assert.equal(String(unclassifiedMatch!.entity), "Kenya  country/KEN");
    assert.equal(unclassifiedMatch!.entity!.kind, null);
    assert.deepEqual(node.types, ["Country"]);
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
    await assert.rejects(dfo.lookup.catalogue(), {
      name: "ContractError",
      code: "method_not_allowed",
    });
  });
});

describe("limits", () => {
  for (const [name, options] of [
    ["timeout NaN", { timeout: Number.NaN }],
    ["timeout 0", { timeout: 0 }],
    ["timeout -1", { timeout: -1 }],
    ["timeout as a string", { timeout: "500" }],
    ["timeout true", { timeout: true }],
    ["attemptTimeout Infinity", { attemptTimeout: Infinity }],
    ["attemptTimeout 0", { attemptTimeout: 0 }],
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

  test("refuse timeout null when the client is built; withOptions reads it as clearing", () => {
    const { fetch } = mockFetch();
    assert.throws(() => client(fetch, { timeout: null } as unknown as ClientOptions), {
      name: "InvalidRequestError",
      code: "invalid_argument",
    });
    assert.ok(client(fetch).withOptions({ timeout: null }) instanceof Client);
  });

  test("take timeouts and retry counts in range", () => {
    const { fetch } = mockFetch();
    const dfo = client(fetch, { timeout: 0.5, attemptTimeout: 0.5, maxRetries: 0 }).withOptions({
      timeout: Infinity,
      attemptTimeout: 2 ** 40,
      maxRetries: 10,
    });
    assert.ok(dfo instanceof Client);
  });

  /** A request that answers nothing until its signal aborts. The timer stands in for the socket
   *  a real hung request holds open. */
  const hang = (_request: unknown, init: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      const socket = setTimeout(() => undefined, 5_000);
      init.signal?.addEventListener("abort", () => {
        clearTimeout(socket);
        reject(init.signal?.reason);
      });
    });

  for (const [name, options, call] of [
    ["the client's timeout", { timeout: 30 }, {}],
    ["a call's timeout over the client's", { timeout: 60_000 }, { timeout: 30 }],
  ] as const) {
    test(`bound a whole call, retries included, by ${name}`, async () => {
      // Each attempt would wait 60 s, and the call has two retries, so only a bound on the whole
      // call ends it after one attempt.
      const { fetch, seen } = mockFetch(hang, hang, hang);
      const dfo = client(fetch, { ...options, attemptTimeout: 60_000 });
      await assert.rejects(dfo.lookup.code("spec_not_found", call), {
        name: "DfoTimeoutError",
        code: "deadline_exceeded",
      });
      assert.equal(seen.length, 1);
    });
  }

  test("bound one attempt by attemptTimeout and retry it", async () => {
    const { fetch, seen } = mockFetch(hang, json(ENTRY));
    const { sleep } = recordingSleep();
    const dfo = clientOver(
      new Transport({ baseUrl: BASE, apiKey: false, fetch, sleep, attemptTimeout: 20 }),
    );
    assert.equal((await dfo.lookup.code("spec_not_found")).code, "spec_not_found");
    assert.equal(seen.length, 2);
  });

  for (const [name, limits, settles] of [
    ["clears the client's timeout with timeout: null", { timeout: null }, true],
    ["keeps the client's timeout when timeout is left out", { maxRetries: 2 }, false],
  ] as const) {
    test(`withOptions ${name}`, async () => {
      // The client's 10 ms bound ends the call during its first 20 ms attempt. Without it, the
      // attempt times out on its own and the retry answers.
      const { fetch, seen } = mockFetch(hang, json(ENTRY));
      const { sleep } = recordingSleep();
      const dfo = clientOver(
        new Transport({
          baseUrl: BASE,
          apiKey: false,
          fetch,
          sleep,
          timeout: 10,
          attemptTimeout: 20,
        }),
      ).withOptions(limits);
      const call = dfo.lookup.code("spec_not_found");
      if (settles) {
        assert.equal((await call).code, "spec_not_found");
        assert.equal(seen.length, 2);
      } else {
        await assert.rejects(call, { name: "DfoTimeoutError", code: "deadline_exceeded" });
        assert.equal(seen.length, 1);
      }
    });
  }

  test("bound a search by the client's timeout in place of its own 60 s", async () => {
    const { fetch, seen } = mockFetch(hang);
    await assert.rejects(client(fetch, { timeout: 30 }).search("aid to Kenya"), {
      name: "DfoTimeoutError",
      code: "deadline_exceeded",
    });
    assert.equal(seen.length, 1);
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
    await original.lookup.catalogue();
    const copy = original.withOptions({ maxRetries: 1 });
    await assert.rejects(copy.lookup.catalogue());
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

describe("DFO_BASE_URL", () => {
  const ENV_BASE = "https://env.example.org/api";
  const over = (options: ConstructorParameters<typeof Transport>[0]) =>
    clientOver(new Transport({ apiKey: false, ...options }));

  test("sets the base URL when baseUrl is left out, and String(client) names it", async () => {
    const { fetch, seen } = mockFetch(json(CATALOGUE));
    const dfo = over({ fetch, env: envFrom({ DFO_BASE_URL: ENV_BASE }) });
    await dfo.lookup.catalogue();
    assert.equal(seen[0]!.url, `${ENV_BASE}/search/catalogue`);
    assert.equal(String(dfo), `<Client ${ENV_BASE} (from DFO_BASE_URL)>`);
    assert.equal(inspect(dfo), String(dfo));
  });

  test("yields to the baseUrl argument", () => {
    const dfo = over({ baseUrl: BASE, env: envFrom({ DFO_BASE_URL: ENV_BASE }) });
    assert.equal(dfo.baseUrl, BASE);
    assert.equal(String(dfo), `<Client ${BASE}>`);
  });

  test("leaves the public API, which String(client) names, when unset", () => {
    const dfo = over({ env: envFrom({}) });
    assert.equal(dfo.baseUrl, "https://developmentfinance.org/api/v1");
    assert.equal(String(dfo), "<Client https://developmentfinance.org/api/v1>");
  });

  test("is read from process.env by default", () => {
    const before = process.env["DFO_BASE_URL"];
    process.env["DFO_BASE_URL"] = ENV_BASE;
    try {
      assert.equal(new Client({ apiKey: false }).baseUrl, ENV_BASE);
    } finally {
      if (before === undefined) delete process.env["DFO_BASE_URL"];
      else process.env["DFO_BASE_URL"] = before;
    }
  });

  for (const value of ["ftp://env.example.org/api", "env.example.org/api", " "]) {
    test(`refuses ${JSON.stringify(value)} with base_url_invalid naming the variable`, () => {
      assert.throws(
        () => over({ env: envFrom({ DFO_BASE_URL: value }) }),
        (error: unknown) =>
          error instanceof InvalidRequestError &&
          error.code === "base_url_invalid" &&
          error.message.includes("DFO_BASE_URL"),
      );
    });
  }

  test("refuses a key over plain http to a host that is not loopback", () => {
    assert.throws(
      () =>
        over({
          apiKey: "dfo_k_test",
          env: envFrom({ DFO_BASE_URL: "http://env.example.org/api" }),
        }),
      { name: "InvalidRequestError", code: "insecure_transport" },
    );
  });

  test("is read once: a withOptions copy keeps the base URL and where it came from", () => {
    let value = ENV_BASE;
    const dfo = over({ env: (name) => (name === "DFO_BASE_URL" ? value : undefined) });
    value = "https://other.example.org/api";
    const copy = dfo.withOptions({ maxRetries: 0 });
    assert.equal(copy.baseUrl, ENV_BASE);
    assert.equal(String(copy), String(dfo));
  });
});
