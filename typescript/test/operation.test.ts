import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { envFrom } from "../src/env.ts";
import { ContractError } from "../src/errors.ts";
import type { VersionUnavailableError } from "../src/errors.ts";
import { fetchDataset, mint, resume } from "../src/fetch.ts";
import type { ProgressEvent } from "../src/operation.ts";
import { DatasetRef } from "../src/ref.ts";
import { Transport } from "../src/transport.ts";
import { scenario, scenarioBytes, stepOf } from "./replay.ts";
import { json, mockFetch, problem } from "./support.ts";

const BASE = "https://api.example/api";
const OP = `op_${"a".repeat(64)}`;
const SIGNED = "https://storage.googleapis.com/bucket/object?X-Goog-Signature=redacted";

/** The build of fetch-spec-known-sentence: its spec, manifest, Parquet body and the Search
 *  answer that resolves its identity (from fetch-spec-narrowed, which built the same spec). */
async function built() {
  const record = await scenario("fetch-spec-known-sentence");
  const narrowed = await scenario("fetch-spec-narrowed");
  return {
    spec: stepOf(record, 0, "fetch").spec!,
    manifest: record.exchanges[0]!.response.json as Record<string, unknown>,
    parquet: await scenarioBytes("fetch-spec-known-sentence.parquet"),
    resolved: narrowed.exchanges[1]!.response.json,
  };
}

function client(fetch: typeof globalThis.fetch, timeout?: number) {
  let clock = 0;
  const waits: number[] = [];
  const transport = new Transport({
    ...(timeout === undefined ? {} : { timeout }),
    baseUrl: BASE,
    apiKey: false,
    env: envFrom({}),
    readCredentialsFile: () => Promise.resolve(null),
    fetch,
    now: () => clock,
    sleep: (ms) => {
      waits.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    onWarning: () => undefined,
  });
  return { transport, waits };
}

const operation = (status: string, extra: Record<string, unknown> = {}) => ({
  operation: { operation_id: OP, status, poll: `/api/datasets/operations/${OP}`, ...extra },
});

/** A response that arrives after `ms` of real time, or rejects when the request aborts first. */
const answerAfter =
  (ms: number, respond: () => Response) =>
  (_request: unknown, init: RequestInit): Promise<Response> =>
    new Promise((resolve, reject) => {
      // AbortSignal.timeout does not hold the event loop open; this timer stands in for the
      // socket a real request holds.
      const socket = setTimeout(() => {
        resolve(respond());
      }, ms);
      init.signal?.addEventListener("abort", () => {
        clearTimeout(socket);
        reject(init.signal?.reason);
      });
    });

const download = (parquet: Uint8Array) => [
  () => new Response(null, { status: 302, headers: { location: SIGNED } }),
  () => new Response(parquet.slice(), { status: 200 }),
];

describe("a long build", () => {
  test("polls at the retry_after_ms every pending or running response carries", async () => {
    const { spec, manifest, parquet } = await built();
    const { fetch, seen } = mockFetch(
      json(operation("pending", { retry_after_ms: 1500 }), 202, { "retry-after": "2" }),
      json(
        operation("running", {
          retry_after_ms: 2500,
          progress: { rows_written: 10, estimate_rows: 100 },
        }),
        200,
        { "retry-after": "3" },
      ),
      json({ ...operation("done"), manifest }),
      ...download(parquet),
    );
    const { transport, waits } = client(fetch);
    const events: ProgressEvent[] = [];
    const op = await mint(transport, spec);
    assert.equal(op.operationId, OP);
    assert.equal(op.status, "pending");
    const dataset = await op.result({ onProgress: (event) => events.push(event) });

    assert.deepEqual(waits, [1500, 2500]);
    assert.equal(dataset.rows, 4);
    assert.equal(dataset.members[0]!.sentence, spec.resolved?.rendered_sentence);
    assert.deepEqual(events, [
      { operationId: OP, progress: { rowsWritten: 10, estimateRows: 100 }, traceId: null },
    ]);
    const posted = JSON.parse(seen[0]!.body!) as { input: Record<string, unknown> };
    assert.equal(posted.input["scope"], undefined);
    assert.equal(seen[1]!.url, `${BASE}/datasets/operations/${OP}`);
    assert.deepEqual([...seen[4]!.headers], []);
  });

  test("falls back to Retry-After, then to a backoff from 1 to 8 seconds", async () => {
    const { spec, manifest, parquet } = await built();
    const running = json(operation("running"));
    const { fetch } = mockFetch(
      // The server today paces only the 202, and in the body.
      json(operation("pending"), 202, { "retry-after": "3" }),
      running,
      running,
      running,
      running,
      running,
      json({ ...operation("done"), manifest }),
      ...download(parquet),
    );
    const { transport, waits } = client(fetch);
    await (await mint(transport, spec)).result();
    assert.deepEqual(waits, [3000, 1000, 2000, 4000, 8000, 8000]);
  });

  test("waits out each 429 on a poll for its Retry-After, spending no retries", async () => {
    const { spec, manifest, parquet } = await built();
    const limited = (wait?: string) =>
      json(
        { error: "rate_limited", retry: "retry_after_delay", detail: "" },
        429,
        wait === undefined ? {} : { "retry-after": wait },
      );
    const { fetch } = mockFetch(
      json(operation("pending", { retry_after_ms: 1000 }), 202),
      limited("5"),
      limited("7"),
      limited(),
      json({ ...operation("done"), manifest }),
      ...download(parquet),
    );
    const { transport, waits } = client(fetch);
    const dataset = await (await mint(transport, spec)).result();
    assert.equal(dataset.rows, 4);
    // A 429 with no Retry-After falls back to the operation's own pacing.
    assert.deepEqual(waits, [1000, 5000, 7000, 1000]);
  });

  test("reads a mint's POST past the client's timeout", async () => {
    const { spec } = await built();
    const { fetch } = mockFetch(
      answerAfter(60, json(operation("pending", { retry_after_ms: 1000 }), 202)),
    );
    const op = await mint(client(fetch, 20).transport, spec);
    assert.equal(op.operationId, OP);
  });

  test("spends a retry on a poll attempt that runs past the client's timeout", async () => {
    const { spec, manifest, parquet } = await built();
    const { fetch, seen } = mockFetch(
      json(operation("pending", { retry_after_ms: 1000 }), 202),
      answerAfter(1_000, json(operation("running"))),
      json({ ...operation("done"), manifest }),
      ...download(parquet),
    );
    const dataset = await (await mint(client(fetch, 20).transport, spec)).result();
    assert.equal(dataset.rows, 4);
    assert.equal(seen.length, 5);
  });

  for (const [header, waits] of [
    [{ "retry-after": "3" }, [3000]],
    [{}, [500]],
  ] as const) {
    test(`waits ${waits[0]} ms before posting a cut-off build again`, async () => {
      const { spec, manifest, parquet } = await built();
      const { fetch } = mockFetch(
        problem({ code: "timeout", status: 504, retryable: true }, header),
        json(manifest),
        ...download(parquet),
      );
      const { transport, waits: waited } = client(fetch);
      await fetchDataset(transport, spec);
      assert.deepEqual(waited, waits);
    });
  }

  test("raises operation_failed for a failed operation with no error, with the header's trace id", async () => {
    const { fetch } = mockFetch(json(operation("failed"), 200, { "x-dfo-trace-id": "trace-op" }));
    const op = await resume(client(fetch).transport, OP);
    await assert.rejects(op.result(), {
      name: "ServerError",
      code: "operation_failed",
      traceId: "trace-op",
    });
  });

  test("waits a refused build's Retry-After before posting it again", async () => {
    const { spec, manifest, parquet } = await built();
    const { fetch, seen } = mockFetch(
      problem({ code: "build_capacity", status: 503, retryable: true }, { "retry-after": "7" }),
      problem({ code: "build_capacity", status: 503, retryable: true }),
      json(manifest),
      ...download(parquet),
    );
    const { transport, waits } = client(fetch);
    const dataset = await fetchDataset(transport, spec);
    assert.equal(dataset.rows, 4);
    assert.deepEqual(waits, [7000, 1000]);
    assert.equal(seen[1]!.body, seen[0]!.body);
  });

  test("names the call that resumes it when the deadline passes", async () => {
    const { spec } = await built();
    const running = json(operation("running", { retry_after_ms: 1000 }));
    const { fetch } = mockFetch(
      json(operation("pending", { retry_after_ms: 1000 }), 202),
      running,
      running,
    );
    const { transport } = client(fetch);
    const op = await mint(transport, spec);
    await assert.rejects(op.result({ timeout: 2500 }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "DfoTimeoutError");
      assert.match(error.message, new RegExp(`client\\.operation\\("${OP}"\\)`));
      return true;
    });
  });

  test("resumes by id in another process, taking the sentence from Search", async () => {
    const { manifest, parquet, resolved } = await built();
    const { fetch, seen } = mockFetch(
      json(operation("running", { retry_after_ms: 2000 })),
      json({ ...operation("done"), manifest }),
      json(resolved),
      ...download(parquet),
    );
    const { transport, waits } = client(fetch);
    const op = await resume(transport, OP);
    assert.equal(op.status, "running");
    const dataset = await op.result();
    assert.deepEqual(waits, [2000]);
    assert.match(dataset.sentence, /2020 to 2023/);
    assert.equal(seen[2]!.url, `${BASE}/search/resolve`);
  });

  test("resubmits a build whose operation failed retryably, once", async () => {
    const { spec, manifest, parquet } = await built();
    const failed = problem({ code: "operation_failed", status: 500, retryable: true });
    const { fetch, seen } = mockFetch(
      json(operation("pending", { retry_after_ms: 1000 }), 202),
      failed,
      json(manifest),
      ...download(parquet),
    );
    const { transport } = client(fetch);
    const dataset = await (await mint(transport, spec)).result();
    assert.equal(dataset.rows, 4);
    assert.equal(seen[2]!.method, "POST");
    assert.equal(seen[2]!.body, seen[0]!.body);
  });

  test("resubmits a failed operation retryable by its status alone", async () => {
    const { spec, manifest, parquet } = await built();
    // The problem document carries no `retryable`, so its status decides.
    const { fetch, seen } = mockFetch(
      json(operation("pending", { retry_after_ms: 1000 }), 202),
      json({ ...operation("failed"), error: { code: "build_failed", status: 503 } }),
      json(manifest),
      ...download(parquet),
    );
    const { transport } = client(fetch);
    const dataset = await (await mint(transport, spec)).result();
    assert.equal(dataset.rows, 4);
    assert.equal(seen[2]!.method, "POST");
  });

  test("raises a failure that is not retryable", async () => {
    const { spec } = await built();
    const { fetch } = mockFetch(
      json(operation("pending", { retry_after_ms: 1000 }), 202),
      problem({ code: "operation_failed", status: 500 }),
    );
    const { transport } = client(fetch);
    await assert.rejects((await mint(transport, spec)).result(), {
      name: "ServerError",
      code: "operation_failed",
    });
  });
});

describe("a stored version's lookup order", () => {
  const stored = async () => {
    const record = await scenario("fetch-ref");
    const ref = DatasetRef.fromJSON(stepOf(record, 0, "fetch").ref);
    const member = ref.members[0]!;
    return {
      ref,
      member,
      manifest: record.exchanges[0]!.response.json as Record<string, unknown>,
      parquet: await scenarioBytes("fetch-ref.parquet"),
      version: `${BASE}/datasets/${member.spec.spec_id}/${member.contentVersion}`,
    };
  };
  const expired = problem({ code: "artifact_expired", status: 410 });

  test("builds again when the snapshot has expired, keeping the ref's member", async () => {
    const { ref, member, manifest, parquet } = await stored();
    const { fetch, seen } = mockFetch(expired, json(manifest), ...download(parquet));
    const dataset = await fetchDataset(client(fetch).transport, ref);
    assert.equal(seen[1]!.method, "POST");
    const posted = JSON.parse(seen[1]!.body!) as { input: { definition: unknown } };
    assert.deepEqual(posted.input.definition, member.spec.definition);
    assert.deepEqual(dataset.members[0]!.parts, member.parts);
    assert.equal(dataset.members[0]!.sentence, member.sentence);
    assert.equal(dataset.members[0]!.digest, member.digest);
  });

  test("asks the file selector when the stored file has expired", async () => {
    const { ref, manifest, parquet, version } = await stored();
    const { fetch, seen } = mockFetch(json(manifest), expired, ...download(parquet));
    const dataset = await fetchDataset(client(fetch).transport, ref);
    assert.equal(seen[2]!.url, `${version}/file?format=parquet&bundle=false`);
    assert.equal(dataset.rows, 30);
  });

  test("names the newest version when a build returns another one", async () => {
    const { ref, manifest, version } = await stored();
    const newer = { ...manifest, content_version: `cv_${"1".repeat(32)}` };
    const { fetch, seen } = mockFetch(json(manifest), expired, expired, json(newer));
    await assert.rejects(fetchDataset(client(fetch).transport, ref), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "VersionUnavailableError");
      assert.match(error.message, new RegExp(`newest version is cv_${"1".repeat(32)}`));
      return true;
    });
    assert.equal(seen[2]!.url, `${version}/file?format=parquet&bundle=false`);
  });

  const page = (versions: unknown) => ({
    schema_version: 1,
    spec_id: "spec_x",
    versions,
    next_cursor: null,
    complete: true,
  });
  for (const [name, body, outcome] of [
    ["lists none", page([]), null],
    ["holds no versions list", { spec_id: "spec_x" }, "/versions"],
    [
      "lists a version with no content_version",
      page([{ rendering: "plain" }]),
      "/versions/0/content_version",
    ],
  ] as const) {
    test(`reads a versions page that ${name}`, async () => {
      const { ref } = await stored();
      const { fetch } = mockFetch(
        expired,
        problem({ code: "spec_not_found", status: 404 }),
        json(body),
      );
      const error = await fetchDataset(client(fetch).transport, ref).catch((e: unknown) => e);
      if (outcome === null) {
        assert.ok(error instanceof Error && error.name === "VersionUnavailableError");
        assert.equal((error as VersionUnavailableError).newestVersion, null);
      } else {
        assert.ok(error instanceof ContractError);
        assert.equal(error.code, "contract_violation");
        assert.equal(error.pointer, outcome);
      }
    });
  }

  test("names the newest version from the versions route when the build is refused", async () => {
    const { ref, member } = await stored();
    const newest = `cv_${"2".repeat(32)}`;
    const { fetch, seen } = mockFetch(
      expired,
      problem({ code: "spec_not_found", status: 404 }),
      json({
        schema_version: 1,
        spec_id: member.spec.spec_id,
        versions: [{ content_version: newest, base_content_version: null, rendering: "plain" }],
        next_cursor: null,
        complete: true,
      }),
    );
    await assert.rejects(fetchDataset(client(fetch).transport, ref), (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error);
      assert.equal(error.name, "VersionUnavailableError");
      assert.equal(error.code, "artifact_expired");
      assert.equal((error as VersionUnavailableError).newestVersion, newest);
      assert.match(error.message, new RegExp(`newest version is ${newest}`));
      return true;
    });
    assert.equal(seen[2]!.url, `${BASE}/datasets/${member.spec.spec_id}/versions?limit=1`);
  });
});
