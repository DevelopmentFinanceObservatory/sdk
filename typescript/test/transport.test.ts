import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { envFrom } from "../src/env.ts";
import {
  AuthenticationError,
  ContractError,
  DfoError,
  DfoTimeoutError,
  errorClassFor,
  InvalidRequestError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  ServerError,
} from "../src/errors.ts";
import { PROXY_CODE_STATUSES } from "../src/generated/proxy-codes.ts";
import { ApiKey } from "../src/keys.ts";
import { Transport } from "../src/transport.ts";
import type { TransportOptions } from "../src/transport.ts";
import { VERSION } from "../src/version.ts";
import type { DfoWarning } from "../src/warnings.ts";
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

  test("resolve a root-relative URL against the base URL's origin, not its path", async () => {
    const { fetch, seen } = mockFetch(json({}));
    const client = transport({ baseUrl: "https://api.example/api/v1", fetch });
    await client.request({ url: "/api/datasets/operations/op_1" });
    assert.equal(seen[0]?.url, "https://api.example/api/datasets/operations/op_1");
  });

  test("send default and provided headers to the API and never the key elsewhere", async () => {
    const { fetch, seen } = mockFetch(json({}), json({}));
    const client = transport({
      baseUrl: "https://api.example/api/v1",
      apiKey: KEY,
      fetch,
      defaultHeaders: { "x-first-party": "site" },
      headerProvider: ({ url }) => ({ "x-serverless-authorization": `token for ${url.host}` }),
    });
    await client.request({ path: "/graph/roots" });
    await client.request({ url: "https://elsewhere.example/thing" });
    const [api, elsewhere] = seen;
    assert.ok(api && elsewhere);
    assert.equal(api.headers.get("x-first-party"), "site");
    assert.equal(api.headers.get("x-serverless-authorization"), "token for api.example");
    assert.deepEqual([...elsewhere.headers], []);
  });

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

  test("retry a retryable refusal after Retry-After, then succeed", async () => {
    const { sleep, waits } = recordingSleep();
    const { fetch, seen } = mockFetch(
      problem(
        { code: "service_unavailable", status: 503, retryable: true },
        { "retry-after": "2" },
      ),
      json({ ok: true }),
    );
    const response = await transport({ fetch, sleep }).request({ path: "/search/resolve" });
    assert.deepEqual(response.body, { ok: true });
    assert.equal(seen.length, 2);
    assert.deepEqual(waits, [2000]);
  });

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

  test("map the proxy's 429 body and retry it after Retry-After", async () => {
    const { sleep, waits } = recordingSleep();
    const limited = json(
      { error: "rate_limited", retry: "retry_after_delay", detail: "Too many requests." },
      429,
      { "retry-after": "1" },
    );
    const { fetch } = mockFetch(limited, limited, limited);
    const error = await transport({ fetch, sleep })
      .request({ path: "/x" })
      .catch((e: unknown) => e);
    assert.ok(error instanceof RateLimitError);
    assert.equal(error.code, "rate_limited");
    assert.equal(error.retryable, true);
    assert.equal(error.detail, "Too many requests.");
    assert.deepEqual(waits, [1000, 1000]);
  });

  for (const [code, status] of Object.entries(PROXY_CODE_STATUSES)) {
    test(`map the proxy's ${code} body by its status ${status}, keeping its code`, async () => {
      const { sleep } = recordingSleep();
      const refused = json({ error: code, retry: "retry_after_delay", detail: "Down." }, status);
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

  test("map a refusal with no problem document by its status", async () => {
    const { fetch } = mockFetch(() => new Response("<html>bad gateway</html>", { status: 400 }));
    const error = await transport({ fetch })
      .request({ path: "/x" })
      .catch((e: unknown) => e);
    assert.ok(error instanceof InvalidRequestError);
    assert.equal(error.code, "refusal_without_code");
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

  test("refuse a secret key in a browser page unless the caller allows it", () => {
    const global = globalThis as { window?: unknown };
    global.window = { document: {} };
    try {
      assert.throws(() => transport({ apiKey: KEY }), TypeError);
      assert.doesNotThrow(() => transport({ apiKey: KEY, dangerouslyAllowBrowser: true }));
      assert.doesNotThrow(() => transport({ apiKey: "dfo_p_publishable" }));
    } finally {
      delete global.window;
    }
  });

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
    const cause = new TypeError("fetch failed");
    const fail = (): Response => {
      throw cause;
    };
    const { fetch, seen } = mockFetch(fail, fail, fail);
    const error = await transport({ fetch, sleep })
      .request({ path: "/x" })
      .catch((e: unknown) => e);
    assert.ok(error instanceof NetworkError);
    assert.equal(error.cause, cause);
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
  test("retry an attempt that runs past the client's timeout", async () => {
    const { sleep } = recordingSleep();
    const { fetch, seen } = mockFetch(answerAfter(1_000), json({ ok: true }));
    const response = await transport({ fetch, sleep, timeout: 20 }).request({ path: "/x" });
    assert.deepEqual(response.body, { ok: true });
    assert.equal(seen.length, 2);
  });

  test("raise deadline_exceeded with no retry when the deadline passes", async () => {
    const { fetch, seen } = mockFetch(answerAfter(1_000));
    const client = transport({ fetch, timeout: Infinity });
    const error = await client
      .request({ path: "/x", deadline: client.deadlineAfter(20) })
      .catch((e: unknown) => e);
    assert.ok(error instanceof DfoTimeoutError);
    assert.equal(error.code, "deadline_exceeded");
    assert.equal(seen.length, 1);
  });

  test("raise deadline_exceeded when the deadline passes during the body", async () => {
    const { fetch } = mockFetch(stalledBody);
    const client = transport({ fetch, timeout: Infinity });
    const error = await client
      .request({ path: "/x", deadline: client.deadlineAfter(20) })
      .catch((e: unknown) => e);
    assert.ok(error instanceof DfoTimeoutError);
    assert.equal(error.code, "deadline_exceeded");
  });

  for (const timeout of [Infinity, 2 ** 31, 30 * 24 * 3_600_000]) {
    test(`take a client timeout of ${timeout} ms as no limit or its clamp`, async () => {
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
    await transport({ fetch, timeout: Infinity }).request({ path: "/x" });
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

  test("refuse a files route answering a 2xx other than 200", async () => {
    const { fetch } = mockFetch(() => new Response(null, { status: 204 }));
    await assert.rejects(transport({ fetch }).locate({ url: "/api/datasets/files/d" }), {
      name: "ContractError",
      code: "unexpected_response",
    });
  });

  test("follow a browser's opaque redirect carrying the key alone", async () => {
    const opaque = () => {
      const response = new Response(null, { status: 200 });
      Object.defineProperty(response, "type", { value: "opaqueredirect" });
      return response;
    };
    const { fetch, seen } = mockFetch(opaque, () => new Response("PAR1"));
    const client = transport({
      baseUrl: "https://api.example/api/v1",
      apiKey: KEY,
      fetch,
      defaultHeaders: { "x-first-party": "site" },
      headerProvider: () => ({ "x-identity": "token" }),
    });
    const located = await client.locate({ url: "/api/datasets/files/d" });
    assert.deepEqual(located.data, new TextEncoder().encode("PAR1"));
    assert.equal(seen[0]?.headers.get("x-identity"), "token");
    assert.deepEqual([...(seen[1]?.headers ?? [])], [["authorization", `Bearer ${KEY}`]]);
  });

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
