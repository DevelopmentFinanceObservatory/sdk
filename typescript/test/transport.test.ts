import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { envFrom } from "../src/config/env.ts";
import {
  AuthenticationError,
  ContractError,
  DfoError,
  DfoTimeoutError,
  errorClassFor,
  InvalidRequestError,
  NetworkError,
  NotFoundError,
  problemAt200,
  RateLimitError,
  ServerError,
} from "../src/core/errors.ts";
import { PROXY_CODE_STATUSES } from "../src/generated/proxy-codes.ts";
import { ApiKey } from "../src/config/keys.ts";
import { JSON_BODY_MAX_BYTES, Transport } from "../src/http/transport.ts";
import type { TransportOptions } from "../src/http/transport.ts";
import { VERSION } from "../src/version.ts";
import type { DfoWarning } from "../src/core/warnings.ts";
import { contractJson, json, mockFetch, problem, recordingSleep } from "./support.ts";

const KEY = "dfo_k_4f8Kq2ZtR7mWx1NcB9vLp3YhD6sGa0Ue2wanxe";

/** A transport with no environment and no credentials file, so only `apiKey` supplies a key. */
const transport = (options: TransportOptions): Transport =>
  new Transport({ env: envFrom({}), readCredentialsFile: () => null, ...options });

describe("requests to the API", () => {
  test("go under the base URL's path and carry the key and User-Agent", async () => {
    const { fetch, seen } = mockFetch(json({ ok: true }));
    const client = transport({ baseUrl: "https://api.example/api/v1", apiKey: KEY, fetch });
    const response = await client.request({ path: "/search/resolve", json: { q: 1 } });
    assert.deepEqual(response.body, { ok: true });
    const request = seen[0];
    assert.ok(request);
    assert.equal(request.url, "https://api.example/api/v1/search/resolve");
    assert.equal(request.method, "POST");
    assert.equal(request.body, '{"q":1}');
    assert.equal(request.headers.get("authorization"), `Bearer ${KEY}`);
    assert.equal(request.headers.get("user-agent"), `dfo-ts/${VERSION}`);
    assert.equal(request.headers.get("content-type"), "application/json");
  });

  // The Python client's order: the caller's User-Agent replaces the client's, and the key's
  // Authorization replaces the caller's, which goes out only when there is no key.
  for (const [name, apiKey, authorization] of [
    ["with a key", KEY, `Bearer ${KEY}`],
    ["with no key", false, "Bearer token"],
  ] as const) {
    test(`take the caller's User-Agent and, ${name}, the right Authorization`, async () => {
      const { fetch, seen } = mockFetch(json({}));
      const client = transport({
        baseUrl: "https://api.example/api/v1",
        apiKey,
        fetch,
        defaultHeaders: { "User-Agent": "mine/1", Authorization: "Bearer token" },
      });
      await client.request({ path: "/ping" });
      const [request] = seen;
      assert.ok(request);
      assert.equal(request.headers.get("user-agent"), "mine/1");
      assert.equal(request.headers.get("authorization"), authorization);
    });
  }

  test("resolve a root-relative URL against the base URL's origin, not its path", async () => {
    const { fetch, seen } = mockFetch(json({}));
    const client = transport({ baseUrl: "https://api.example/api/v1", fetch });
    await client.request({ url: "/api/datasets/operations/op_1" });
    assert.equal(seen[0]?.url, "https://api.example/api/datasets/operations/op_1");
  });

  /** A `Headers` from another realm or package, such as npm undici's: iterable, and no
   *  instance of this realm's class. */
  class ForeignHeaders {
    readonly #pairs: [string, string][];
    constructor(pairs: [string, string][]) {
      this.#pairs = pairs;
    }
    entries(): IterableIterator<[string, string]> {
      return this.#pairs[Symbol.iterator]();
    }
    [Symbol.iterator](): IterableIterator<[string, string]> {
      return this.entries();
    }
  }

  // Each row gives what the headerProvider returns for one header pair.
  for (const [shape, provide] of [
    ["a record", (name: string, value: string) => ({ [name]: value })],
    ["an array of pairs", (name: string, value: string) => [[name, value]]],
    ["a Headers", (name: string, value: string) => new Headers([[name, value]])],
    [
      "a Headers from another realm",
      (name: string, value: string) => new ForeignHeaders([[name, value]]),
    ],
  ] as const) {
    test(`send default and provided headers, given ${shape}, to the API and never the key elsewhere`, async () => {
      const { fetch, seen } = mockFetch(json({}), json({}));
      const client = transport({
        baseUrl: "https://api.example/api/v1",
        apiKey: KEY,
        fetch,
        defaultHeaders: { "x-first-party": "site" },
        // A foreign Headers stands for an iterable plain JavaScript can return.
        headerProvider: ({ url }) =>
          provide("x-serverless-authorization", `token for ${url.host}`) as HeadersInit,
      });
      await client.request({ path: "/graph/roots" });
      await client.request({ url: "https://elsewhere.example/thing" });
      const [api, elsewhere] = seen;
      assert.ok(api && elsewhere);
      assert.equal(api.headers.get("x-first-party"), "site");
      assert.equal(api.headers.get("x-serverless-authorization"), "token for api.example");
      assert.deepEqual([...elsewhere.headers], []);
    });
  }

  test("send no Authorization header for anonymous use", async () => {
    const { fetch, seen } = mockFetch(json({}));
    await transport({ apiKey: false, fetch }).request({ path: "/search/capabilities" });
    assert.equal(seen[0]?.headers.has("authorization"), false);
  });

  test("raise ContractError for a JSON route that answers with a redirect", async () => {
    const { fetch } = mockFetch(
      () => new Response(null, { status: 302, headers: { location: "https://other.example/" } }),
    );
    await assert.rejects(transport({ fetch }).request({ path: "/search/resolve" }), ContractError);
  });
});

describe("refusals", () => {
  test("map a problem document by its code and keep its members", async () => {
    const { fetch } = mockFetch(
      problem({ code: "snapshot_not_found", status: 404, trace_id: "trace-404" }),
    );
    const client = transport({ baseUrl: "https://api.example/api/v1", fetch });
    const error = await client.request({ path: "/datasets/spec_1/cv_1" }).catch((e: unknown) => e);
    assert.ok(error instanceof NotFoundError);
    assert.equal(error.code, "snapshot_not_found");
    assert.equal(error.status, 404);
    assert.equal(error.traceId, "trace-404");
    assert.equal(error.retryable, false);
    assert.equal(error.docsUrl, "https://api.example/codes/snapshot_not_found");
    assert.equal(error.problem?.["title"], "Refused");
  });

  for (const [header, waits] of [
    ["2", [2000]],
    ["0", [0]],
    ["60", [60_000]],
    ["Sun, 06 Nov 1994 08:49:37 GMT", [0]],
    ["-5", [500]],
    ["1.5", [500]],
    ["inf", [500]],
    ["\u00b2", [500]],
    ["5 s", [500]],
    ["Sunday, 06-Nov-94 08:49:37 GMT", [500]],
  ] as const) {
    test(`wait ${waits[0]} ms for a Retry-After of ${JSON.stringify(header)}, then succeed`, async () => {
      const { sleep, waits: waited } = recordingSleep();
      const { fetch } = mockFetch(
        problem(
          { code: "service_unavailable", status: 503, retryable: true },
          { "retry-after": header },
        ),
        json({ ok: true }),
      );
      const response = await transport({ fetch, sleep }).request({ path: "/x" });
      assert.deepEqual(response.body, { ok: true });
      assert.deepEqual(waited, waits);
    });
  }

  for (const header of ["61", "86400", "99999999999999999999", "Fri, 31 Dec 9999 23:59:59 GMT"]) {
    test(`raise a refusal whose Retry-After of ${header} is past 60 s at once`, async () => {
      const { sleep, waits } = recordingSleep();
      const refusal = problem(
        { code: "rate_limited", status: 429, retryable: true },
        { "retry-after": header },
      );
      const { fetch, seen } = mockFetch(refusal);
      const error = await transport({ fetch, sleep })
        .request({ path: "/x" })
        .catch((e: unknown) => e);
      assert.ok(error instanceof RateLimitError);
      assert.ok((error.retryAfterMs ?? 0) > 60_000);
      assert.deepEqual(waits, []);
      assert.equal(seen.length, 1);
    });
  }

  test("back off without Retry-After and give up after maxRetries", async () => {
    const { sleep, waits } = recordingSleep();
    const refusal = problem({ code: "upstream_error", status: 502, retryable: true });
    const { fetch, seen } = mockFetch(refusal, refusal, refusal);
    await assert.rejects(transport({ fetch, sleep }).request({ path: "/x" }), ServerError);
    assert.equal(seen.length, 3);
    assert.deepEqual(waits, [500, 1000]);
  });

  test("let the body's retryable outrank the status", async () => {
    const { fetch, seen } = mockFetch(
      problem({ code: "service_unavailable", status: 503, retryable: false }),
    );
    await assert.rejects(transport({ fetch }).request({ path: "/x" }), ServerError);
    assert.equal(seen.length, 1);
  });

  for (const [status, retried] of [
    [408, true],
    [500, true],
    [503, true],
    [400, false],
    [501, false],
  ] as const) {
    test(`retry a refusal with no problem document at HTTP ${status}: ${retried}`, async () => {
      const { sleep } = recordingSleep();
      const bare = () => new Response("", { status });
      const { fetch, seen } = mockFetch(bare, bare, bare);
      const error = await transport({ fetch, sleep })
        .request({ path: "/x" })
        .catch((e: unknown) => e);
      assert.ok(error instanceof DfoError);
      assert.equal(error.code, "refusal_without_code");
      assert.equal(error.retryable, retried);
      assert.equal(seen.length, retried ? 3 : 1);
    });
  }

  for (const [status, body, retried, traceId] of [
    [503, { retryable: false, trace_id: "body-trace", detail: "d" }, false, "body-trace"],
    [400, { retryable: true }, true, "header-trace"],
  ] as const) {
    test(`keep a codeless problem document's retryable and trace id at HTTP ${status}`, async () => {
      const { sleep } = recordingSleep();
      const refused = () =>
        new Response(JSON.stringify(body), {
          status,
          headers: {
            "content-type": "application/problem+json",
            "x-dfo-trace-id": "header-trace",
          },
        });
      const { fetch, seen } = mockFetch(refused, refused, refused);
      const error = await transport({ fetch, sleep })
        .request({ path: "/x" })
        .catch((e: unknown) => e);
      assert.ok(error instanceof (status === 503 ? ServerError : InvalidRequestError));
      assert.equal(error.code, "refusal_without_code");
      assert.equal(error.retryable, retried);
      assert.equal(error.traceId, traceId);
      assert.equal(seen.length, retried ? 3 : 1);
    });
  }

  for (const [body, text] of [
    [{ code: "x\nInjected", detail: "d" }, "x"],
    [{ code: "Rate_Limited" }, "Rate_Limited"],
  ] as const) {
    test(`read the code ${JSON.stringify(text)}, which is not snake case, as no code`, async () => {
      const { fetch } = mockFetch(json(body, 400));
      const error = await transport({ fetch })
        .request({ path: "/x" })
        .catch((e: unknown) => e);
      assert.ok(error instanceof InvalidRequestError);
      assert.equal(error.code, "refusal_without_code");
      assert.ok(error.detail.startsWith(`HTTP 400 with no refusal code: ${text}`));
    });
  }

  test("expose a role_incompatible refusal's issues and alternatives", async () => {
    const issues = [{ pointer: "/input/parts/0", axis: "recipient", code: "role_incompatible" }];
    const alternatives = [{ ref: "country/KEN", label: "Kenya" }];
    const { fetch } = mockFetch(
      problem({
        code: "role_incompatible",
        status: 422,
        issues: [...issues, 3],
        alternatives: [...alternatives, { ref: "country/UGA" }],
      }),
      problem({ code: "role_incompatible", status: 422 }),
    );
    const t = transport({ fetch });
    const error = await t.request({ path: "/x" }).catch((e: unknown) => e);
    assert.ok(error instanceof InvalidRequestError);
    assert.deepEqual(error.issues, issues);
    assert.deepEqual(error.alternatives, alternatives);
    const bare = await t.request({ path: "/x" }).catch((e: unknown) => e);
    assert.ok(bare instanceof InvalidRequestError);
    assert.deepEqual([bare.issues, bare.alternatives], [[], []]);
  });

  for (const [code, status] of Object.entries(PROXY_CODE_STATUSES)) {
    test(`map the proxy's ${code} problem document by its status ${status}`, async () => {
      const { sleep } = recordingSleep();
      const refused = json({ code, retryable: true, detail: "Down." }, status);
      const { fetch, seen } = mockFetch(refused, refused, refused);
      const error = await transport({ fetch, sleep })
        .request({ path: "/x" })
        .catch((e: unknown) => e);
      assert.ok(error instanceof errorClassFor("code_from_a_newer_server", status));
      assert.equal(error.code, code);
      assert.equal(error.retryable, true);
      assert.equal(seen.length, 3);
    });
  }

  test("read a body with error and retry members as carrying no code", async () => {
    const { sleep } = recordingSleep();
    const refused = json({ error: "upstream_down", retry: "never" }, 502);
    const { fetch, seen } = mockFetch(refused, refused, refused);
    const error = await transport({ fetch, sleep })
      .request({ path: "/x" })
      .catch((e: unknown) => e);
    assert.ok(error instanceof ServerError);
    assert.equal(error.code, "refusal_without_code");
    assert.equal(error.retryable, true);
    assert.equal(seen.length, 3);
  });

  for (const [detail, pointer, message] of [
    [
      "Field required",
      "/input/definition/schema_version",
      "Field required at /input/definition/schema_version (request_invalid)",
    ],
    ["Field required.", "/input", "Field required at /input (request_invalid)"],
    ["/input is required", "/input", "/input is required (request_invalid)"],
    ["Field required", "", "Field required (request_invalid)"],
    ["Field required", 7, "Field required (request_invalid)"],
    [undefined, "/input", "HTTP 422 at /input (request_invalid)"],
  ] as const) {
    test(`name the pointer ${JSON.stringify(pointer)} in the message of ${JSON.stringify(detail)}`, async () => {
      const { fetch } = mockFetch(
        problem({ code: "request_invalid", status: 422, detail, pointer }),
      );
      const error = await transport({ fetch })
        .request({ path: "/x" })
        .catch((e: unknown) => e);
      assert.ok(error instanceof InvalidRequestError);
      assert.equal(error.message, message);
      assert.equal(error.detail, detail ?? "request_invalid");
    });
  }

  for (const [type, code] of [
    ["application/problem+json", "snapshot_not_found"],
    ["application/json; charset=utf-8", "snapshot_not_found"],
    ["text/html", "refusal_without_code"],
  ] as const) {
    test(`read a ${type} refusal body as a problem document: ${code}`, async () => {
      const { fetch } = mockFetch(
        problem({ code: "snapshot_not_found", status: 404 }, { "content-type": type }),
      );
      await assert.rejects(transport({ fetch }).request({ path: "/x" }), {
        name: "NotFoundError",
        code,
      });
    });
  }

  test("type a refusal nested past the depth bound, which redacting it would overflow", async () => {
    const deep = `{"code":"snapshot_not_found","a":${"[".repeat(100_000)}${"]".repeat(100_000)}}`;
    const { fetch } = mockFetch(
      () =>
        new Response(deep, {
          status: 400,
          headers: { "content-type": "application/problem+json" },
        }),
    );
    await assert.rejects(transport({ apiKey: KEY, fetch }).request({ path: "/x" }), {
      name: "InvalidRequestError",
      code: "refusal_without_code",
    });
  });

  test("take the trace id from x-dfo-trace-id when the problem names none", async () => {
    const { fetch } = mockFetch(
      problem(
        { code: "snapshot_not_found", status: 404, trace_id: undefined },
        { "x-dfo-trace-id": "trace-header" },
      ),
    );
    await assert.rejects(transport({ fetch }).request({ path: "/x" }), {
      traceId: "trace-header",
    });
  });

  test("stop retrying when the next wait would pass the deadline", async () => {
    let clock = 0;
    const sleep = (ms: number): Promise<void> => {
      clock += ms;
      return Promise.resolve();
    };
    const refusal = problem(
      { code: "upstream_error", status: 503, retryable: true },
      {
        "retry-after": "30",
      },
    );
    const { fetch, seen } = mockFetch(refusal, refusal);
    const client = transport({ fetch, sleep, now: () => clock });
    await assert.rejects(client.request({ path: "/x", deadline: 45_000 }), ServerError);
    assert.equal(seen.length, 2);
  });
});

describe("keys", () => {
  test("resolve the key again after a 401 and retry once with a new key", async () => {
    let calls = 0;
    const { fetch, seen } = mockFetch(
      problem({ code: "key_revoked", status: 401 }),
      json({ ok: true }),
    );
    const apiKey = (): string => (calls++ === 0 ? "dfo_k_old" : "dfo_k_new");
    const client = transport({ fetch, apiKey, onWarning: () => undefined });
    await client.request({ path: "/x" });
    assert.deepEqual(
      seen.map((request) => request.headers.get("authorization")),
      ["Bearer dfo_k_old", "Bearer dfo_k_new"],
    );
  });

  test("raise AuthenticationError on a 401 when the key stays the same", async () => {
    const { fetch, seen } = mockFetch(problem({ code: "key_invalid", status: 401 }));
    const client = transport({ fetch, apiKey: new ApiKey(KEY) });
    await assert.rejects(client.request({ path: "/x" }), AuthenticationError);
    assert.equal(seen.length, 1);
  });

  test("warn once for a key that fails the format check and send it anyway", async () => {
    const warnings: DfoWarning[] = [];
    const { fetch, seen } = mockFetch(json({}), json({}));
    const client = transport({
      fetch,
      apiKey: "sk-other-vendor",
      onWarning: (w) => warnings.push(w),
    });
    await client.request({ path: "/x" });
    await client.request({ path: "/x" });
    assert.equal(seen[1]?.headers.get("authorization"), "Bearer sk-other-vendor");
    assert.deepEqual(
      warnings.map((warning) => warning.code),
      ["key_unknown_prefix"],
    );
  });

  const importScripts = (): void => undefined;
  // Stand-ins for the scope constructors each kind of worker defines.
  const WorkerGlobalScope = (): void => undefined;
  const Scope = (): void => undefined;
  for (const [scope, globals, browser] of [
    ["a page", { window: { document: {} } }, true],
    [
      "a dedicated worker",
      { WorkerGlobalScope, DedicatedWorkerGlobalScope: Scope, importScripts },
      true,
    ],
    ["a shared worker", { WorkerGlobalScope, SharedWorkerGlobalScope: Scope, importScripts }, true],
    [
      "a service worker",
      { WorkerGlobalScope, ServiceWorkerGlobalScope: Scope, importScripts },
      true,
    ],
    [
      "a server runtime with worker globals",
      { WorkerGlobalScope, ServiceWorkerGlobalScope: Scope },
      false,
    ],
  ] as const) {
    test(`${browser ? "refuse" : "send"} a secret key in ${scope}, with no user-agent in a browser`, async () => {
      const global = globalThis as Record<string, unknown>;
      Object.assign(global, globals);
      try {
        if (browser) {
          assert.throws(() => transport({ apiKey: KEY }), TypeError);
          assert.throws(() => transport({ apiKey: KEY.toUpperCase() }), TypeError);
        } else assert.doesNotThrow(() => transport({ apiKey: KEY }));
        assert.doesNotThrow(() => transport({ apiKey: KEY, dangerouslyAllowBrowser: true }));
        const { fetch, seen } = mockFetch(json({}));
        await transport({ apiKey: "dfo_p_publishable", fetch }).request({ path: "/x" });
        assert.equal(seen[0]?.headers.has("user-agent"), !browser);
      } finally {
        for (const name of Object.keys(globals)) Reflect.deleteProperty(global, name);
      }
    });
  }

  test("mask the key when printed or serialised", () => {
    const key = new ApiKey(KEY);
    assert.equal(String(key), "ApiKey(dfo_k_…anxe)");
    assert.equal(JSON.stringify({ key }), '{"key":"ApiKey(dfo_k_…anxe)"}');
    assert.equal(key.reveal(), KEY);
  });
});

describe("failures and cancellation", () => {
  test("raise NetworkError with the platform's error as the cause, after retries", async () => {
    const { sleep } = recordingSleep();
    const cause = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    const fail = (): Response => {
      throw cause;
    };
    const { fetch, seen } = mockFetch(fail, fail, fail);
    const error = await transport({ fetch, sleep })
      .request({ path: "/x" })
      .catch((e: unknown) => e);
    assert.ok(error instanceof NetworkError);
    assert.equal(error.cause, cause);
    assert.match(error.message, /\(ECONNREFUSED\)/);
    assert.equal(seen.length, 3);
  });

  test("reject with the caller's abort reason untouched", async () => {
    const controller = new AbortController();
    const reason = { mine: true };
    const { fetch } = mockFetch(
      (_request, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason);
          });
          controller.abort(reason);
        }),
    );
    await assert.rejects(
      transport({ fetch }).request({ path: "/x", signal: controller.signal }),
      (error: unknown) => error === reason,
    );
  });

  test("stops waiting for a header provider with the caller's abort reason", async () => {
    const controller = new AbortController();
    const reason = { mine: true };
    const { fetch, seen } = mockFetch(json({ ok: true }));
    const request = transport({
      fetch,
      headerProvider: () => new Promise<HeadersInit>(() => undefined),
    }).request({ path: "/x", signal: controller.signal });
    controller.abort(reason);
    await assert.rejects(request, (error: unknown) => error === reason);
    assert.deepEqual(seen, []);
  });

  for (const [name, headerProvider] of [
    ["rejects", () => Promise.reject(new Error("identity provider failed"))],
    [
      "throws",
      () => {
        throw new Error("identity provider failed");
      },
    ],
  ] as const) {
    test(`raises header_invalid, naming the provider, when the provider ${name}`, async () => {
      const { fetch, seen } = mockFetch(json({ ok: true }));
      const error = await transport({ fetch, headerProvider })
        .request({ path: "/x" })
        .catch((value: unknown) => value);
      assert.ok(error instanceof InvalidRequestError);
      assert.equal(error.code, "header_invalid");
      assert.match(error.message, /headerProvider/);
      assert.ok(error.cause instanceof Error);
      assert.equal(error.cause.message, "identity provider failed");
      assert.equal(seen.length, 0);
    });
  }
});

/** A response that arrives after `ms`, or rejects with the abort reason when the request's
 *  signal aborts first. */
const answerAfter =
  (ms: number, respond: () => Response = json({ ok: true })) =>
  (_request: unknown, init: RequestInit): Promise<Response> =>
    new Promise((resolve, reject) => {
      // AbortSignal.timeout does not hold the event loop open; a real request's socket does,
      // and this timer stands in for it.
      const socket = setTimeout(() => {
        resolve(respond());
      }, ms);
      init.signal?.addEventListener("abort", () => {
        clearTimeout(socket);
        reject(init.signal?.reason);
      });
    });

/** A 200 whose body sends one chunk and then never ends, until the request aborts. */
const stalledBody = (_request: unknown, init: RequestInit): Response => {
  const socket = setTimeout(() => undefined, 5_000);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([123]));
      init.signal?.addEventListener("abort", () => {
        clearTimeout(socket);
        controller.error(init.signal?.reason);
      });
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
};

describe("timeouts", () => {
  test("bounds a stalled header provider by the whole-call deadline", async () => {
    const { fetch, seen } = mockFetch(json({ ok: true }));
    const client = transport({
      fetch,
      timeout: 60_000,
      headerProvider: () => new Promise<HeadersInit>(() => undefined),
    });
    const error = await client
      .request({ path: "/x", deadline: client.deadlineAfter(20) })
      .catch((value: unknown) => value);
    assert.ok(error instanceof DfoTimeoutError);
    assert.equal(error.code, "deadline_exceeded");
    assert.deepEqual(seen, []);
  });

  test("bounds an initial key provider by the whole-call deadline", async () => {
    const { fetch, seen } = mockFetch(json({ ok: true }));
    const client = transport({
      fetch,
      timeout: 60_000,
      apiKey: () => new Promise<string>(() => undefined),
    });
    const error = await client
      .request({ path: "/x", deadline: client.deadlineAfter(20) })
      .catch((value: unknown) => value);
    assert.ok(error instanceof DfoTimeoutError);
    assert.equal(error.code, "deadline_exceeded");
    assert.deepEqual(seen, []);
  });

  test("bounds a browser followed download's shared key and keeps it for the next caller", async () => {
    let resolveKey: (value: string) => void = () => undefined;
    const key = new Promise<string>((resolve) => {
      resolveKey = resolve;
    });
    const { fetch, seen } = mockFetch(() =>
      Object.defineProperty(new Response(new Uint8Array([80, 65, 82, 49])), "url", {
        value: "https://api.example/api/v1/datasets/files/artifact",
      }),
    );
    const client = transport({
      baseUrl: "https://api.example/api/v1",
      fetch,
      timeout: 60_000,
      apiKey: () => key,
    });
    const url = new URL("https://api.example/api/v1/datasets/files/artifact");
    const controller = new AbortController();
    const reason = { mine: true };
    const cancelled = client.fetchSigned(url, { follow: true, signal: controller.signal });
    const deadline = client.fetchSigned(url, { follow: true, deadline: client.deadlineAfter(20) });

    controller.abort(reason);
    await assert.rejects(cancelled, (error: unknown) => error === reason);
    await assert.rejects(deadline, { name: "DfoTimeoutError", code: "deadline_exceeded" });
    assert.equal(seen.length, 0);

    resolveKey("dfo_k_new");
    assert.deepEqual(
      await client.fetchSigned(url, { follow: true }),
      new Uint8Array([80, 65, 82, 49]),
    );
    assert.equal(seen[0]?.headers.get("authorization"), "Bearer dfo_k_new");
  });

  test("bounds a refresh key provider and lets its shared resolution serve the next request", async () => {
    let resolveRefresh: (value: string) => void = () => undefined;
    const refresh = new Promise<string>((resolve) => {
      resolveRefresh = resolve;
    });
    let calls = 0;
    const { fetch, seen } = mockFetch(
      problem({ code: "key_revoked", status: 401 }),
      json({ ok: true }),
    );
    const client = transport({
      fetch,
      timeout: 60_000,
      apiKey: () => (calls++ === 0 ? "dfo_k_old" : refresh),
    });
    const error = await client
      .request({ path: "/x", deadline: client.deadlineAfter(20) })
      .catch((value: unknown) => value);
    assert.ok(error instanceof DfoTimeoutError);
    assert.equal(error.code, "deadline_exceeded");
    assert.equal(seen.length, 1);

    resolveRefresh("dfo_k_new");
    await client.request({ path: "/x" });
    assert.equal(seen[1]?.headers.get("authorization"), "Bearer dfo_k_new");
  });

  test("retry an attempt that runs past the client's timeout", async () => {
    const { sleep } = recordingSleep();
    const { fetch, seen } = mockFetch(answerAfter(1_000), json({ ok: true }));
    const response = await transport({ fetch, sleep, timeout: 20 }).request({ path: "/x" });
    assert.deepEqual(response.body, { ok: true });
    assert.equal(seen.length, 2);
  });

  test("raise deadline_exceeded with no retry when the deadline passes", async () => {
    const { fetch, seen } = mockFetch(answerAfter(1_000));
    const client = transport({ fetch, timeout: 60_000 });
    const error = await client
      .request({ path: "/x", deadline: client.deadlineAfter(20) })
      .catch((e: unknown) => e);
    assert.ok(error instanceof DfoTimeoutError);
    assert.equal(error.code, "deadline_exceeded");
    assert.equal(seen.length, 1);
  });

  test("raise deadline_exceeded when the deadline passes during the body", async () => {
    const { fetch } = mockFetch(stalledBody);
    const client = transport({ fetch, timeout: 60_000 });
    const error = await client
      .request({ path: "/x", deadline: client.deadlineAfter(20) })
      .catch((e: unknown) => e);
    assert.ok(error instanceof DfoTimeoutError);
    assert.equal(error.code, "deadline_exceeded");
  });

  for (const [name, options] of [
    ["without a header provider", {}],
    ["with a header provider", { headerProvider: () => ({ "x-team": "dfo" }) }],
  ] as const) {
    test(`raise deadline_exceeded for a passed deadline before invalid call headers, ${name}`, async () => {
      const { fetch, seen } = mockFetch(json({ ok: true }));
      const error = await transport({ fetch, now: () => 1_000, ...options })
        .request({ path: "/x", deadline: 1_000, headers: { "x-token": "bad\nvalue" } })
        .catch((value: unknown) => value);
      assert.ok(error instanceof DfoTimeoutError);
      assert.equal(error.code, "deadline_exceeded");
      assert.equal(seen.length, 0);
    });
  }

  for (const [name, options] of [
    ["without a header provider", {}],
    ["with a header provider", { headerProvider: () => ({ "x-team": "dfo" }) }],
  ] as const) {
    test(`raise invalid_argument for a bad timeout before a passed deadline, ${name}`, async () => {
      const { fetch, seen } = mockFetch(json({ ok: true }));
      const error = await transport({ fetch, now: () => 1_000, ...options })
        .request({ path: "/x", deadline: 1_000, timeout: -5 })
        .catch((value: unknown) => value);
      assert.ok(error instanceof InvalidRequestError);
      assert.equal(error.code, "invalid_argument");
      assert.equal(seen.length, 0);
    });

    test(`raise invalid_argument for a bad timeout before invalid call headers, ${name}`, async () => {
      const { fetch, seen } = mockFetch(json({ ok: true }));
      const error = await transport({ fetch, ...options })
        .request({ path: "/x", timeout: -5, headers: { "x-token": "bad\nvalue" } })
        .catch((value: unknown) => value);
      assert.ok(error instanceof InvalidRequestError);
      assert.equal(error.code, "invalid_argument");
      assert.equal(seen.length, 0);
    });
  }

  for (const timeout of [2 ** 31, 30 * 24 * 3_600_000]) {
    test(`take a client timeout of ${timeout} ms as its clamp`, async () => {
      const { fetch } = mockFetch(answerAfter(20));
      const client = transport({ fetch, timeout });
      const response = await client.request({
        path: "/x",
        deadline: client.deadlineAfter(timeout),
      });
      assert.deepEqual(response.body, { ok: true });
    });
  }

  test("arm no timer for an infinite limit", async () => {
    const { fetch } = mockFetch((_request, init) => {
      assert.equal(init.signal, undefined);
      return json({ ok: true })();
    });
    await transport({ fetch }).request({ path: "/x", timeout: Infinity });
  });
});

describe("downloads", () => {
  type Exchange = {
    request: { method: string; path?: string; origin_path?: string; url?: string; json?: unknown };
    response: { status: number; headers?: Record<string, string>; json?: unknown };
  };
  type Scenario = { origin: { base_url: string }; exchanges: Exchange[] };

  test("replay a recorded build and download: the signed URL is fetched bare", async () => {
    const scenario = await contractJson<Scenario>("scenarios/fetch-spec-known-sentence.json");
    const [mint, files, signed] = scenario.exchanges;
    assert.ok(mint && files && signed);
    const bytes = new Uint8Array([80, 65, 82, 49]);
    const { fetch, seen } = mockFetch(
      json(mint.response.json),
      () =>
        new Response(null, {
          status: files.response.status,
          headers: files.response.headers ?? {},
        }),
      () => new Response(bytes, { status: signed.response.status }),
    );
    const client = transport({ baseUrl: scenario.origin.base_url, apiKey: KEY, fetch });

    const built = await client.request({ path: mint.request.path!, json: mint.request.json });
    const manifest = built.body as { artifacts: { url: string }[] };
    assert.equal(manifest.artifacts[0]?.url, files.request.origin_path);
    const located = await client.locate({ url: manifest.artifacts[0]!.url });
    assert.ok(located.signed);
    assert.deepEqual(await client.fetchSigned(located.signed), bytes);

    const origin = new URL(scenario.origin.base_url).origin;
    assert.deepEqual(
      seen.map((request) => request.url),
      [
        `${scenario.origin.base_url}${mint.request.path!}`,
        `${origin}${files.request.origin_path!}`,
        signed.request.url,
      ],
    );
    assert.equal(seen[1]?.headers.get("authorization"), `Bearer ${KEY}`);
    assert.deepEqual([...(seen[2]?.headers ?? [])], []);
  });

  const SIGNED = "https://storage.googleapis.com/bucket/object?X-Goog-Signature=redacted";
  const redirect = (location: string, url?: string) => () => {
    const response = new Response(null, { status: 302, headers: { location } });
    if (url !== undefined) Object.defineProperty(response, "url", { value: url });
    return response;
  };
  const rows: [string, () => Response, string | undefined, string | undefined][] = [
    ["a signed URL on the storage host", redirect(SIGNED), SIGNED, undefined],
    [
      "a relative Location, against the response's URL",
      redirect("blob/object", "https://api.example/api/datasets/files/"),
      "https://api.example/api/datasets/files/blob/object",
      undefined,
    ],
    [
      "a relative Location, against the route when the response names no URL",
      redirect("../blob/object"),
      "https://api.example/api/datasets/blob/object",
      undefined,
    ],
    ["an empty Location", redirect(""), undefined, "contract_violation"],
    [
      "a Location with a malformed IPv6 host",
      redirect("https://[::1/x"),
      undefined,
      "unexpected_response",
    ],
    [
      "a Location with a port out of range",
      redirect("https://api.example:99999/x"),
      undefined,
      "unexpected_response",
    ],
    [
      "a Location on another host",
      redirect("https://elsewhere.example/object"),
      undefined,
      "contract_violation",
    ],
  ];
  for (const [name, route, signedUrl, code] of rows) {
    test(`read ${name}`, async () => {
      const { fetch } = mockFetch(route);
      const client = transport({ baseUrl: "https://api.example/api/v1", fetch });
      const located = client.locate({ url: "/api/datasets/files/d" });
      if (code === undefined) {
        assert.equal((await located).signed?.href, signedUrl);
      } else {
        await assert.rejects(located, { name: "ContractError", code });
      }
    });
  }

  for (const url of ["https://elsewhere.example/files/d", SIGNED]) {
    test(`refuse a file URL on ${new URL(url).host} before any request`, async () => {
      const client = transport({ fetch: mockFetch().fetch });
      await assert.rejects(client.locate({ url }), {
        name: "ContractError",
        code: "contract_violation",
      });
    });
  }

  test("refuse a redirect with no Location, carrying the route's trace id", async () => {
    const trace = "d".repeat(32);
    const { fetch } = mockFetch(
      () => new Response(null, { status: 302, headers: { "x-dfo-trace-id": trace } }),
    );
    await assert.rejects(transport({ fetch }).locate({ url: "/api/datasets/files/d" }), {
      name: "ContractError",
      code: "contract_violation",
      traceId: trace,
    });
  });

  for (const status of [204, 301, 307]) {
    test(`refuse a files route answering HTTP ${status}, which is neither 200 nor 302`, async () => {
      const { fetch } = mockFetch(
        () => new Response(null, { status, headers: { location: SIGNED } }),
      );
      await assert.rejects(transport({ fetch }).locate({ url: "/api/datasets/files/d" }), {
        name: "ContractError",
        code: "unexpected_response",
        status,
      });
    });
  }

  for (const [ended, code] of [
    ["https://elsewhere.example/object", "contract_violation"],
    [SIGNED, undefined],
    ["https://api.example/api/datasets/files/d", undefined],
  ] as const) {
    test(`read a followed browser redirect that ends on ${new URL(ended).host}`, async () => {
      const { fetch } = mockFetch(() =>
        Object.defineProperty(new Response("PAR1", { status: 200 }), "url", { value: ended }),
      );
      const client = transport({ baseUrl: "https://api.example/api/v1", fetch });
      const fetched = client.fetchSigned(new URL("https://api.example/api/datasets/files/d"), {
        follow: true,
      });
      if (code === undefined) {
        assert.deepEqual(await fetched, new TextEncoder().encode("PAR1"));
      } else {
        await assert.rejects(fetched, { name: "ContractError", code });
      }
    });
  }

  for (const [status, body] of [
    [200, "PAR1"],
    [403, "expired"],
  ] as const) {
    test(`follow a browser's opaque redirect once, with the key alone, at HTTP ${status}`, async () => {
      const opaque = () =>
        Object.defineProperty(new Response(null, { status: 200 }), "type", {
          value: "opaqueredirect",
        });
      const warnings: DfoWarning[] = [];
      const { fetch, seen } = mockFetch(
        opaque,
        () => new Response(body, { status, headers: { "x-dfo-warning": `followed ${status}` } }),
      );
      const { sleep, waits } = recordingSleep();
      const client = transport({
        baseUrl: "https://api.example/api/v1",
        apiKey: KEY,
        fetch,
        sleep,
        defaultHeaders: { "x-first-party": "site" },
        headerProvider: () => ({ "x-identity": "token" }),
        onWarning: (warning) => warnings.push(warning),
      });
      const located = await client.locate({ url: "/api/datasets/files/d" });
      assert.equal(located.follow, true);
      assert.ok(located.signed);
      const fetched = await client
        .fetchSigned(located.signed, { follow: true })
        .catch((e: unknown) => e);
      if (status === 200) {
        assert.deepEqual(fetched, new TextEncoder().encode(body));
      } else {
        assert.ok(fetched instanceof ServerError);
        assert.equal(fetched.code, "download_failed");
        assert.equal(fetched.retryable, true);
      }
      assert.equal(seen.length, 2);
      assert.deepEqual(waits, []);
      assert.deepEqual(warnings, []);
      assert.equal(seen[0]?.headers.get("x-identity"), "token");
      assert.deepEqual([...(seen[1]?.headers ?? [])], [["authorization", `Bearer ${KEY}`]]);
    });
  }

  test("retry the files route as any API request", async () => {
    const { sleep, waits } = recordingSleep();
    const refusal = problem({ code: "upstream_error", status: 503, retryable: true });
    const { fetch, seen } = mockFetch(refusal, refusal, refusal);
    await assert.rejects(transport({ fetch, sleep }).locate({ url: "/api/datasets/files/d" }), {
      code: "upstream_error",
    });
    assert.equal(seen.length, 3);
    assert.deepEqual(waits, [500, 1000]);
  });

  for (const status of [403, 206]) {
    test(`fetch a signed URL once, raising a retryable download_failed at HTTP ${status}`, async () => {
      const { fetch, seen } = mockFetch(() => new Response("expired", { status }));
      const error = await transport({ fetch })
        .fetchSigned(new URL(SIGNED))
        .catch((e: unknown) => e);
      assert.ok(error instanceof ServerError);
      assert.equal(error.code, "download_failed");
      assert.equal(error.retryable, true);
      assert.equal(seen.length, 1);
    });
  }

  for (const [name, url, onApi] of [
    ["bare on the storage host", SIGNED, false],
    ["as an API request on the API's origin", "https://api.example/api/blob/object", true],
  ] as const) {
    test(`fetch a file URL ${name}`, async () => {
      const warnings: DfoWarning[] = [];
      const { fetch, seen } = mockFetch(
        () => new Response("PAR1", { headers: { "x-dfo-warning": `file fetch ${name}` } }),
      );
      const client = transport({
        baseUrl: "https://api.example/api/v1",
        apiKey: KEY,
        fetch,
        onWarning: (warning) => warnings.push(warning),
      });
      await client.fetchSigned(new URL(url));
      const headers = seen[0]?.headers;
      assert.equal(headers?.get("authorization") ?? null, onApi ? `Bearer ${KEY}` : null);
      if (!onApi) assert.deepEqual([...(headers ?? [])], []);
      assert.deepEqual(
        warnings.map((warning) => warning.code),
        onApi ? ["server_warning"] : [],
      );
    });
  }
});

describe("body limits", () => {
  const SIGNED = "https://storage.googleapis.com/bucket/object";

  /** A body of `chunk`-byte pieces with no end, counting how many pieces were pulled from it
   *  and whether its reader was cancelled. */
  function endless(chunk: number, status = 200) {
    const counts = { pulls: 0, cancelled: false };
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          counts.pulls += 1;
          controller.enqueue(new Uint8Array(chunk));
        },
        cancel() {
          counts.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const response = () =>
      new Response(body, { status, headers: { "content-type": "application/json" } });
    return { counts, response };
  }

  for (const [name, call, status, chunk, limit] of [
    [
      "a JSON body, by JSON_BODY_MAX_BYTES",
      (client: Transport) => client.request({ path: "/x" }),
      200,
      2 ** 20,
      JSON_BODY_MAX_BYTES,
    ],
    [
      "a refusal's body, by JSON_BODY_MAX_BYTES",
      (client: Transport) => client.request({ path: "/x" }),
      503,
      2 ** 20,
      JSON_BODY_MAX_BYTES,
    ],
    [
      "a files route's body, by the call's maxBytes",
      (client: Transport) => client.locate({ url: "/api/datasets/files/d", maxBytes: 1_000 }),
      200,
      100,
      1_000,
    ],
    [
      "a signed download, by the call's maxBytes",
      (client: Transport) => client.fetchSigned(new URL(SIGNED), { maxBytes: 1_000 }),
      200,
      100,
      1_000,
    ],
  ] as const) {
    // A read with no cap never ends on this body, so the timeout turns that into a failure.
    test(`stop reading ${name}, pulling nothing past it`, { timeout: 5_000 }, async () => {
      const { counts, response } = endless(chunk, status);
      const { fetch, seen } = mockFetch(response);
      const error = await call(transport({ fetch }))
        .then(() => undefined)
        .catch((e: unknown) => e);
      assert.ok(error instanceof ServerError);
      assert.equal(error.code, "response_too_large");
      assert.equal(error.retryable, false);
      assert.equal(counts.pulls, limit / chunk + 1);
      assert.equal(counts.cancelled, true);
      assert.equal(seen.length, 1);
    });
  }

  test("read a body of exactly its limit", async () => {
    const { fetch } = mockFetch(() => new Response(new Uint8Array(1_000)));
    const body = await transport({ fetch }).fetchSigned(new URL(SIGNED), { maxBytes: 1_000 });
    assert.equal(body.byteLength, 1_000);
  });
});

describe("server warnings", () => {
  // `warnOnce` holds its keys for the process, so each test uses header values of its own.
  test("warn once per header value for Deprecation and once per message for x-dfo-warning", async () => {
    const warnings: DfoWarning[] = [];
    const headers = {
      deprecation: "@1767225600",
      sunset: "Wed, 30 Jun 2027 00:00:00 GMT",
      "x-dfo-warning": "Anonymous builds are limited; create a free key.",
    };
    const { fetch } = mockFetch(json({}, 200, headers), json({}, 200, headers));
    const client = transport({ fetch, onWarning: (warning) => warnings.push(warning) });
    await client.request({ path: "/deprecated-route/spec_1" });
    await client.request({ path: "/deprecated-route/spec_2" });
    assert.deepEqual(
      warnings.map((warning) => [warning.name, warning.code]),
      [
        ["DfoDeprecationWarning", "route_deprecated"],
        ["DfoWarning", "server_warning"],
      ],
    );
  });

  for (const [name, headers] of [
    ["Sunset alone", { sunset: "Thu, 01 Jul 2027 00:00:00 GMT" }],
    ["Deprecation alone", { deprecation: "@1767312000" }],
  ] as const) {
    test(`warn for ${name}`, async () => {
      const warnings: DfoWarning[] = [];
      const { fetch } = mockFetch(json({}, 200, headers));
      await transport({ fetch, onWarning: (warning) => warnings.push(warning) }).request({
        path: "/x",
      });
      assert.deepEqual(
        warnings.map((warning) => warning.code),
        ["route_deprecated"],
      );
    });
  }
});

describe("base URLs", () => {
  for (const baseUrl of [
    "",
    " ",
    "javascript:alert(1)",
    "data:text/plain,x",
    "file:///etc/passwd",
    "ftp://api.example/api",
    "https://alice:s3cret@api.example/api",
    "https://api.example/api?x=1",
    "https://api.example/api#top",
    "https:// spaces/api",
    "https://api.example/api ",
    "https://api.example/v1/../api",
    "http://127.1/api",
    "http://0x7f.1:8080/api",
    "http://2130706433/api",
    "https://127.1/api",
    "https://0x7f.1/api",
    "https://2130706433:8443/api",
    "https://127.000.0.1/api",
    "http:\\\\0177.0.0.1\\api",
  ]) {
    test(`refuse ${JSON.stringify(baseUrl)} without quoting it`, () => {
      assert.throws(
        () => transport({ baseUrl, apiKey: false }),
        (error: unknown) =>
          error instanceof InvalidRequestError &&
          error.code === "base_url_invalid" &&
          !error.message.includes("s3cret"),
      );
    });
  }

  test("drop every trailing slash of the base path", async () => {
    const { fetch, seen } = mockFetch(json({}));
    await transport({ baseUrl: "https://api.example/api//", fetch }).request({ path: "/x" });
    assert.equal(seen[0]?.url, "https://api.example/api/x");
  });

  for (const path of ["/../../etc/passwd", "/%2e%2e/x", "/a/../b", "/a\r\nX-Injected: 1"]) {
    test(`refuse the path ${JSON.stringify(path)}, which leaves the base path or holds a control`, async () => {
      const { fetch, seen } = mockFetch();
      await assert.rejects(
        transport({ baseUrl: "https://api.example/api", fetch }).request({ path }),
        {
          name: "InvalidRequestError",
          code: "invalid_argument",
        },
      );
      assert.equal(seen.length, 0);
    });
  }

  for (const [baseUrl, allowed] of [
    ["http://api.example/api", false],
    ["http://localhost:8080/api", true],
    ["http://dev.localhost/api", true],
    ["http://127.0.0.2:9/api", true],
    ["http://[::1]:9/api", true],
    ["http://localhost./api", true],
    ["http://127.0.0.1.:9/api", true],
    ["http://127.0.0.1.example/api", false],
  ] as const) {
    test(`${allowed ? "send" : "refuse"} a key over plain http to ${baseUrl}`, async () => {
      const build = () => transport({ baseUrl, apiKey: KEY });
      if (allowed) assert.doesNotThrow(build);
      else assert.throws(build, { name: "InvalidRequestError", code: "insecure_transport" });
      // A key a function resolves later is refused before the first request; anonymous use is
      // fine anywhere.
      const { fetch, seen } = mockFetch(json({}), json({}));
      const later = transport({ baseUrl, apiKey: () => Promise.resolve(KEY), fetch });
      const sent = later.request({ path: "/x" });
      if (allowed) await sent;
      else await assert.rejects(sent, { code: "insecure_transport" });
      await transport({ baseUrl, apiKey: false, fetch }).request({ path: "/x" });
      assert.equal(seen.length, allowed ? 2 : 1);
    });
  }
});

describe("key and header characters", () => {
  for (const [key, position] of [
    [` ${KEY}`, 1],
    [`${KEY}\n`, KEY.length + 1],
    [`${KEY}\r\nX-Evil: 1`, KEY.length + 1],
    ["dfo_k_é", 7],
    ["\u200bdfo_k_abc", 1],
  ] as const) {
    for (const [source, options] of [
      ["the apiKey argument", { apiKey: key }],
      ["DFO_API_KEY", { env: envFrom({ DFO_API_KEY: key }) }],
      [
        "the credentials file's profile [default]",
        { readCredentialsFile: () => `[default]\nkey = "${key.replace(/[\n\r]/g, "")}"\n` },
      ],
    ] as const) {
      if (source.startsWith("the credentials") && /[\n\r]/.test(key)) continue;
      test(`refuse ${JSON.stringify(key.slice(0, 12))}… from ${source}, naming character ${position}`, () => {
        assert.throws(
          () => transport(options),
          (error: unknown) =>
            error instanceof AuthenticationError &&
            error.code === "key_invalid" &&
            error.message.includes(source) &&
            error.message.includes(`character ${position}`) &&
            !error.message.includes(key.trim()),
        );
      });
    }
  }

  test("refuse a key function's value that is not a string", async () => {
    // Plain JavaScript can return undefined from a key function.
    const apiKey = (() => Promise.resolve(undefined)) as unknown as () => Promise<string>;
    const { fetch, seen } = mockFetch();
    await assert.rejects(transport({ apiKey, fetch }).request({ path: "/x" }), {
      name: "AuthenticationError",
      code: "key_invalid",
    });
    assert.equal(seen.length, 0);
  });

  test("refuse a default header with a control character when the client is built", () => {
    assert.throws(
      () => transport({ defaultHeaders: { "x-token": "secret\nvalue" } }),
      (error: unknown) =>
        error instanceof InvalidRequestError &&
        error.code === "header_invalid" &&
        error.message.includes("a line break at character 7") &&
        !error.message.includes("secret"),
    );
  });

  for (const [value, code] of [
    ["secret\r\nX-Evil: 1", "header_invalid"],
    ["secret\u007f", "header_invalid"],
    ["日本", "header_invalid"],
    ["café", "header_invalid"],
    [42, "header_invalid"],
    ["tab\tand space", null],
  ] as const) {
    test(`${code === null ? "send" : "refuse"} a provided header ${JSON.stringify(value)}`, async () => {
      const { fetch, seen } = mockFetch(json({}));
      // A number stands for a value plain JavaScript can pass.
      const provided = { "x-token": value } as Record<string, string>;
      const sent = transport({ fetch, headerProvider: () => provided }).request({
        path: "/x",
      });
      if (code === null) {
        await sent;
        assert.equal(seen[0]?.headers.get("x-token"), value);
        return;
      }
      await assert.rejects(
        sent,
        (error: unknown) =>
          error instanceof InvalidRequestError &&
          error.code === code &&
          !error.message.includes("secret") &&
          !error.message.includes("日本") &&
          !error.message.includes("caf"),
      );
      assert.equal(seen.length, 0);
    });
  }
});

describe("key providers", () => {
  for (const [name, options] of [
    ["header provider", { headerProvider: () => new Promise<HeadersInit>(() => undefined) }],
    ["key function", { apiKey: () => new Promise<string>(() => undefined) }],
  ] as const) {
    test(`bound a stalled ${name} by the attempt's timeout`, async () => {
      const { fetch, seen } = mockFetch(json({ ok: true }));
      const error = await transport({ fetch, timeout: 20, ...options })
        .request({ path: "/x" })
        .catch((value: unknown) => value);
      assert.ok(error instanceof DfoTimeoutError);
      assert.equal(error.code, "deadline_exceeded");
      assert.deepEqual(seen, []);
    });
  }

  for (const [name, refresh] of [
    [
      "throws",
      (): string => {
        throw new Error("keychain locked");
      },
    ],
    ["rejects", (): Promise<string> => Promise.reject(new Error("token service down"))],
  ] as const) {
    test(`raise the server's 401 when the key function ${name} after it`, async () => {
      let calls = 0;
      const { fetch, seen } = mockFetch(
        problem({ code: "key_revoked", status: 401 }),
        problem({ code: "key_revoked", status: 401 }),
      );
      const client = transport({
        fetch,
        apiKey: () => (calls++ === 0 ? KEY : refresh()),
      });
      const error = await client.request({ path: "/x" }).catch((value: unknown) => value);
      assert.ok(error instanceof AuthenticationError);
      assert.equal(error.code, "key_revoked");
      assert.ok(error.cause instanceof Error);
      assert.match(error.cause.message, /keychain locked|token service down/);
      // The earlier key stays in use.
      await assert.rejects(client.request({ path: "/x" }), { code: "key_revoked" });
      assert.equal(seen[1]?.headers.get("authorization"), `Bearer ${KEY}`);
    });
  }
});

describe("server text", () => {
  for (const [type, docsUrl] of [
    ["/codes/x", "https://api.example/codes/x"],
    ["javascript:alert(1)", null],
    ["http://evil.example/doc", null],
    ["https://evil.example/doc", null],
    ["data:text/html,x", null],
  ] as const) {
    test(`give docsUrl ${String(docsUrl)} for a type ${type}`, async () => {
      const { fetch } = mockFetch(problem({ code: "x", status: 400, type }));
      const error = await transport({ baseUrl: "https://api.example/api", fetch })
        .request({ path: "/x" })
        .catch((value: unknown) => value);
      assert.ok(error instanceof DfoError);
      assert.equal(error.docsUrl, docsUrl);
    });
  }

  // A problem document under HTTP 200, as Search and the lookups send one, raises through
  // problemAt200 from the parsed body.
  for (const status of [400, 200]) {
    test(`strip controls from a refusal's detail and mask the key it echoes, at HTTP ${status}`, async () => {
      const { fetch } = mockFetch(
        problem({
          code: "request_invalid",
          status,
          detail: `\u001b[31mred\u001b[0m\n\u202eevil, sent ${KEY}`,
        }),
      );
      const sent = transport({ apiKey: KEY, fetch }).request({ path: "/x" });
      const error =
        status === 200
          ? await sent.then((response) => problemAt200(response.body, response.traceId))
          : await sent.catch((value: unknown) => value);
      assert.ok(error instanceof DfoError);
      assert.equal(error.message, "[31mred[0m\nevil, sent [redacted] (request_invalid)");
      assert.ok(!error.detail.includes(KEY));
      assert.ok(!JSON.stringify(error.problem).includes(KEY));
    });
  }

  test("redact the key a server warning echoes", async () => {
    const warnings: DfoWarning[] = [];
    const { fetch } = mockFetch(json({}, 200, { "x-dfo-warning": `key ${KEY} is anonymous-tier` }));
    await transport({ apiKey: KEY, fetch, onWarning: (warning) => warnings.push(warning) }).request(
      { path: "/x" },
    );
    assert.deepEqual(
      warnings.map((warning) => warning.message),
      ["key [redacted] is anonymous-tier"],
    );
  });

  test("strip controls from a server warning", async () => {
    const warnings: DfoWarning[] = [];
    const { fetch } = mockFetch(json({}, 200, { "x-dfo-warning": "stripped \u009b31mwarning" }));
    await transport({ fetch, onWarning: (warning) => warnings.push(warning) }).request({
      path: "/x",
    });
    assert.deepEqual(
      warnings.map((warning) => warning.message),
      ["stripped 31mwarning"],
    );
  });

  const noRoute = "No route exists for the requested path.";
  for (const [code, answer, message, detail] of [
    [
      "not_found",
      problem({ code: "not_found", status: 404, detail: noRoute }),
      `${noRoute} POST https://api.example/search/resolve matched no route; check baseUrl ` +
        "(not_found)",
      noRoute,
    ],
    [
      "spec_not_found",
      problem({ code: "spec_not_found", status: 404, detail: noRoute }),
      `${noRoute} (spec_not_found)`,
      noRoute,
    ],
    [
      "refusal_without_code",
      () => new Response("Not Found", { status: 404 }),
      "HTTP 404 with no refusal code. POST https://api.example/search/resolve matched no " +
        "route; check baseUrl",
      "HTTP 404 with no refusal code.",
    ],
  ] as const) {
    test(`name the request in the message of a 404 ${code} only when no route matched`, async () => {
      const { fetch } = mockFetch(answer);
      const error = await transport({ baseUrl: "https://api.example", fetch })
        .request({ path: "/search/resolve", json: {} })
        .catch((value: unknown) => value);
      assert.ok(error instanceof NotFoundError);
      assert.equal(error.code, code);
      assert.equal(error.message, message);
      assert.equal(error.detail, detail);
    });
  }
});
