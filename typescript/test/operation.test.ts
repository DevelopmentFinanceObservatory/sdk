import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";

import { envFrom } from "../src/config/env.ts";
import { ContractError, VersionUnavailableError } from "../src/core/errors.ts";
import { mint, resume } from "../src/datasets/fetch.ts";
import { fetchDataset, VERSIONS_PAGE_BUDGET } from "../src/datasets/resolve.ts";
import type { ProgressEvent } from "../src/datasets/operation.ts";
import { DatasetRef } from "../src/core/ref.ts";
import { DfoWarning } from "../src/core/warnings.ts";
import type { DatasetRefJson } from "../src/core/ref.ts";
import { Transport } from "../src/http/transport.ts";
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
  const warnings: DfoWarning[] = [];
  const transport = new Transport({
    ...(timeout === undefined ? {} : { timeout }),
    baseUrl: BASE,
    apiKey: false,
    env: envFrom({}),
    readCredentialsFile: () => null,
    fetch,
    now: () => clock,
    sleep: (ms) => {
      waits.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    onWarning: (warning) => warnings.push(warning),
  });
  return { transport, waits, warnings };
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

  for (const [pacing, headers, wait] of [
    [{ retry_after_ms: 0 }, {}, 1_000],
    [{ retry_after_ms: 3_600_000 }, {}, 60_000],
    [{}, { "retry-after": "0" }, 1_000],
    [{}, { "retry-after": "86400" }, 60_000],
  ] as const) {
    test(`clamps the server's poll interval ${JSON.stringify({ ...pacing, ...headers })} to ${wait} ms`, async () => {
      const { spec, manifest, parquet } = await built();
      const { fetch } = mockFetch(
        json(operation("pending", pacing), 202, headers),
        json({ ...operation("done"), manifest }),
        ...download(parquet),
      );
      const { transport, waits } = client(fetch);
      await (await mint(transport, spec)).result();
      assert.deepEqual(waits, [wait]);
    });
  }

  test("raises a refused poll whose Retry-After is past 60 seconds at once", async () => {
    const { spec } = await built();
    const { fetch, seen } = mockFetch(
      json(operation("pending"), 202),
      problem({ code: "build_capacity", status: 503, retryable: true }, { "retry-after": "61" }),
    );
    const { transport, waits } = client(fetch);
    await assert.rejects((await mint(transport, spec)).result(), {
      name: "ServerError",
      code: "build_capacity",
      retryAfterMs: 61_000,
    });
    assert.deepEqual(waits, [1_000]);
    assert.equal(seen.length, 2);
  });

  for (const header of ["86400", "Fri, 31 Dec 2099 23:59:59 GMT"]) {
    test(`raises a refused build whose Retry-After is ${header} at once`, async () => {
      const { spec } = await built();
      const { fetch, seen } = mockFetch(
        problem({ code: "rate_limited", status: 429, retryable: true }, { "retry-after": header }),
      );
      const { transport, waits } = client(fetch);
      await assert.rejects(mint(transport, spec), { name: "RateLimitError" });
      assert.deepEqual(waits, []);
      assert.equal(seen.length, 1);
    });
  }

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

  test("refuses a poll whose operation id is not one path segment, before requesting it", async () => {
    const { spec } = await built();
    const { fetch, seen } = mockFetch(
      json(operation("pending", { retry_after_ms: 10 }), 202),
      json(operation("running", { operation_id: "../../../admin/x?y=1" })),
    );
    const op = await mint(client(fetch).transport, spec);
    await assert.rejects(op.result(), { name: "ContractError", code: "contract_violation" });
    assert.deepEqual(
      seen.map((request) => new URL(request.url).pathname),
      ["/api/datasets", `/api/datasets/operations/${OP}`],
    );
  });

  test("raises a 429 poll that is not retryable at once", async () => {
    const { spec } = await built();
    const { fetch, seen } = mockFetch(
      json(operation("pending", { retry_after_ms: 1000 }), 202),
      problem({ code: "quota_exceeded", status: 429, retryable: false }, { "retry-after": "5" }),
    );
    const op = await mint(client(fetch).transport, spec);
    await assert.rejects(op.result(), { name: "RateLimitError", code: "quota_exceeded" });
    assert.equal(seen.length, 2);
  });

  for (const [header, expected] of [
    [{ "retry-after": "7" }, [1000, 7000, 2000]],
    [{}, [1000, 2000, 4000]],
  ] as const) {
    test(`waits ${expected[1]} ms after a refused 503 poll, spending a retry`, async () => {
      const { spec, manifest, parquet } = await built();
      const refused = problem({ code: "build_capacity", status: 503, retryable: true }, header);
      const { fetch } = mockFetch(
        json(operation("pending"), 202),
        refused,
        json(operation("running")),
        json({ ...operation("done"), manifest }),
        ...download(parquet),
      );
      const { transport, waits } = client(fetch);
      await (await mint(transport, spec)).result();
      assert.deepEqual(waits, expected);
    });
  }

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

  test("strips controls from a failed operation's detail", async () => {
    const { fetch } = mockFetch(
      json({
        ...operation("failed"),
        error: { code: "build_failed", status: 500, detail: "\u001b[31mfailed\u0007\nhere" },
      }),
    );
    const op = await resume(client(fetch).transport, OP);
    await assert.rejects(op.result(), {
      code: "build_failed",
      message: "[31mfailed\nhere (build_failed)",
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

  // Each row gives a mint's options, the options its build posts, and the arguments of the
  // call the timeout names to resume it.
  for (const [options, posted, call] of [
    [{}, {}, `"${OP}"`],
    [{ layout: "frame" }, { layout: "frame" }, `"${OP}", { layout: "frame" }`],
    [
      { withoutPartyTotals: true },
      { without_party_totals: true },
      `"${OP}", { withoutPartyTotals: true }`,
    ],
  ] as const) {
    test(`names the call that resumes it when the deadline passes: ${call}`, async () => {
      const { spec } = await built();
      const running = json(operation("running", { retry_after_ms: 1000 }));
      const { fetch, seen } = mockFetch(
        json(operation("pending", { retry_after_ms: 1000 }), 202),
        running,
        running,
      );
      const { transport } = client(fetch);
      const op = await mint(transport, spec, options);
      const body = JSON.parse(seen[0]!.body!) as { options: Record<string, unknown> };
      assert.deepEqual(body.options, { format: "parquet", bundle: false, ...posted });
      await assert.rejects(op.result({ timeout: 2500 }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "DfoTimeoutError");
        assert.ok(error.message.includes(`client.operation(${call}).`), error.message);
        return true;
      });
    });
  }

  for (const isCut of [false, true]) {
    test(`resumes by id in another process, taking the sentence from Search${isCut ? ", a cut" : ""}`, async () => {
      const { manifest, parquet, resolved } = await built();
      // A cut build's manifest lists its files as cuts, so only the cut's options read them.
      const artifacts = (manifest["artifacts"] as Record<string, unknown>[]).map((artifact) =>
        isCut
          ? {
              ...artifact,
              rendering: {
                ...(artifact["rendering"] as Record<string, unknown>),
                without_party_totals: true,
              },
            }
          : artifact,
      );
      const { fetch, seen } = mockFetch(
        json(operation("running", { retry_after_ms: 2000 })),
        json({ ...operation("done"), manifest: { ...manifest, artifacts } }),
        json(resolved),
        ...download(parquet),
      );
      const { transport, waits } = client(fetch);
      const op = await resume(transport, OP, isCut ? { withoutPartyTotals: true } : {});
      assert.equal(op.status, "running");
      const dataset = await op.result();
      assert.deepEqual(waits, [2000]);
      assert.match(dataset.sentence, /2020 to 2023/);
      assert.equal(seen[2]!.url, `${BASE}/search/resolve`);
      assert.equal(dataset.ref.members[0]!.rendering.without_party_totals, isCut || undefined);
    });
  }

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
  /** The fetch-ref scenario's ref, or its member's party-totals cut. */
  const stored = async (isCut = false) => {
    const record = await scenario("fetch-ref");
    const saved = structuredClone(stepOf(record, 0, "fetch").ref) as DatasetRefJson;
    if (isCut) saved.members[0]!.artifact.rendering.without_party_totals = true;
    const ref = DatasetRef.fromJSON(saved);
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

  /** The manifest with the member's artifact listed second, in the member's rendering, after a
   *  decoy in the other one, as the server lists a party-totals cut that leaves nothing out
   *  beside the plain file under one version. */
  const withDecoy = (manifest: Record<string, unknown>, isCut: boolean) => {
    const [artifact, ...rest] = manifest["artifacts"] as Record<string, unknown>[];
    const rendering = artifact!["rendering"] as Record<string, unknown>;
    const asCut = (cut: boolean) =>
      cut ? { ...rendering, without_party_totals: true } : rendering;
    const decoy = `sha256:${"f".repeat(64)}`;
    return {
      ...manifest,
      artifacts: [
        {
          ...artifact,
          artifact_digest: decoy,
          rendering: asCut(!isCut),
          url: String(artifact!["url"]).replace(String(artifact!["artifact_digest"]), decoy),
        },
        { ...artifact, rendering: asCut(isCut) },
        ...rest,
      ],
    };
  };

  for (const isCut of [false, true]) {
    test(`builds again when the snapshot has expired, keeping the ref's member${isCut ? ", a cut" : ""}`, async () => {
      const { ref, member, manifest, parquet, version } = await stored(isCut);
      const { fetch, seen } = mockFetch(
        expired,
        json(withDecoy(manifest, isCut)),
        ...download(parquet),
      );
      const { transport, warnings } = client(fetch);
      const dataset = await fetchDataset(transport, ref);
      assert.equal(seen[1]!.method, "POST");
      const posted = JSON.parse(seen[1]!.body!) as {
        input: { definition: unknown };
        options: Record<string, unknown>;
      };
      assert.deepEqual(posted.input.definition, member.spec.definition);
      assert.deepEqual(posted.options, {
        format: "parquet",
        bundle: false,
        ...(isCut ? { without_party_totals: true } : {}),
      });
      assert.equal(seen[2]!.url, `${version}/files/${member.digest}`);
      assert.deepEqual(dataset.members[0]!.parts, member.parts);
      assert.equal(dataset.members[0]!.sentence, member.sentence);
      assert.equal(dataset.members[0]!.digest, member.digest);
      assert.equal(JSON.stringify(dataset.ref), JSON.stringify(ref));
      assert.deepEqual(warnings, []);
    });

    test(`asks the file selector when the stored file has expired${isCut ? ", a cut" : ""}`, async () => {
      const { ref, manifest, parquet, version } = await stored(isCut);
      const { fetch, seen } = mockFetch(json(manifest), expired, ...download(parquet));
      const dataset = await fetchDataset(client(fetch).transport, ref);
      // The selector renders the version with the options it was minted with.
      assert.equal(seen[2]!.url, `${version}/file?format=parquet&bundle=false`);
      assert.equal(dataset.rows, 30);
    });
  }

  test("builds again when the file selector renders a larger file than the stored one", async () => {
    const { ref, member, manifest, parquet } = await stored();
    // The selector renders the version again, here one byte past the stored file's size.
    const rerendered = Uint8Array.from([...parquet, 0]);
    // The rebuild's file: the same rows under another writer stamp, so another digest.
    const rebuilt = Uint8Array.from(parquet);
    const stamp = new TextEncoder().encode("version 24.0.0");
    const at = Buffer.from(rebuilt).indexOf(stamp);
    assert.ok(at > 0);
    rebuilt[at + stamp.length - 1] = "1".charCodeAt(0);
    const digest = `sha256:${createHash("sha256").update(rebuilt).digest("hex")}`;
    const [artifact, ...rest] = manifest["artifacts"] as Record<string, unknown>[];
    const rebuiltManifest = {
      ...manifest,
      artifacts: [
        {
          ...artifact,
          artifact_digest: digest,
          url: String(artifact!["url"]).replace(member.digest, digest),
        },
        ...rest,
      ],
    };
    const signed = (body: Uint8Array) => [
      () => new Response(null, { status: 302, headers: { location: SIGNED } }),
      () => new Response(body.slice(), { status: 200 }),
    ];
    const { fetch, seen } = mockFetch(
      json(manifest),
      expired,
      ...signed(rerendered),
      ...signed(rerendered),
      json(rebuiltManifest),
      ...download(rebuilt),
    );
    const { transport, warnings } = client(fetch);
    const dataset = await fetchDataset(transport, ref);
    assert.equal(seen[6]!.method, "POST");
    assert.equal(dataset.ref.members[0]!.digest, digest);
    assert.equal(dataset.rows, 30);
    assert.deepEqual(
      warnings.map((warning) => warning.code),
      ["ref_digest_changed"],
    );
  });

  for (const strict of [false, true]) {
    test(`warns that a rebuilt file has another digest, naming both, and returns it${strict ? " under strict" : ""}`, async () => {
      const { ref, manifest, parquet } = await stored();
      const saved = ref.toJSON();
      const held = `sha256:${"0".repeat(64)}`;
      saved.members[0]!.artifact.digest = held;
      const served = String(
        (manifest["artifacts"] as Record<string, unknown>[])[0]!["artifact_digest"],
      );
      const { fetch } = mockFetch(expired, json(manifest), ...download(parquet));
      const { transport, warnings } = client(fetch);
      const dataset = await fetchDataset(transport, DatasetRef.fromJSON(saved), { strict });
      assert.equal(dataset.ref.members[0]!.digest, served);
      assert.equal(warnings.length, 1);
      const [warning] = warnings;
      // The client's own warning: the server attached nothing to the manifest.
      assert.equal(warning!.constructor, DfoWarning);
      assert.equal(warning!.code, "ref_digest_changed");
      assert.ok(warning!.message.includes(held) && warning!.message.includes(served));
    });
  }

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

  test("refuses a build whose content_version is not a version id", async () => {
    const { ref, manifest } = await stored();
    const odd = { ...manifest, content_version: "<script>" };
    const { fetch } = mockFetch(json(manifest), expired, expired, json(odd));
    await assert.rejects(fetchDataset(client(fetch).transport, ref), {
      name: "ContractError",
      code: "contract_violation",
      pointer: "/content_version",
    });
  });

  const plain = (content_version: string) => ({
    content_version,
    base_content_version: null,
    rendering: "plain",
  });
  const derived = (content_version: string, base: string) => ({
    content_version,
    base_content_version: base,
    rendering: "groupby",
  });
  const cut = (content_version: string, base: string) => ({
    content_version,
    base_content_version: base,
    rendering: "without_party_totals",
    without_party_totals: true,
  });
  const page = (versions: unknown, next_cursor: unknown = null) =>
    json({
      schema_version: 1,
      spec_id: "spec_x",
      versions,
      next_cursor,
      complete: next_cursor === null,
    });
  const [older, newer] = [`cv_${"1".repeat(32)}`, `cv_${"2".repeat(32)}`];
  // Pages that list only groupby versions, each naming the next page.
  const endless = Array.from({ length: VERSIONS_PAGE_BUDGET }, (_, index) =>
    page([derived(newer, older)], `c${index}`),
  );
  // Each row gives whether the ref member is a party-totals cut, the responses the versions
  // route answers in turn, the cursor each page after the first is asked with, and the newest
  // version or the pointer of the field the client refuses. The page-budget row reads
  // `VERSIONS_PAGE_BUDGET` pages.
  for (const [name, isCut, pages, cursors, outcome] of [
    ["lists a plain version first", false, [page([plain(newer)], "c1")], [], { newest: newer }],
    ["lists none", false, [page([])], [], { newest: null }],
    ["is not found", false, [problem({ code: "not_found", status: 404 })], [], { newest: null }],
    [
      "lists a derived version first",
      false,
      [page([derived(newer, older), plain(older)])],
      [],
      { newest: older },
    ],
    [
      "lists a cut first, for a plain ref",
      false,
      [page([cut(newer, older), plain(older)])],
      [],
      { newest: older },
    ],
    [
      "lists a plain version first, for a cut ref",
      true,
      [page([plain(newer), cut(older, newer)])],
      [],
      { newest: older },
    ],
    [
      "lists no cut, for a cut ref",
      true,
      [page([plain(newer), derived(older, newer)])],
      [],
      { newest: null },
    ],
    [
      "lists the plain version on its second page",
      false,
      [page([derived(newer, older)], "c/2"), page([plain(older)])],
      ["c%2F2"],
      { newest: older },
    ],
    ["ends without a plain version", false, [page([derived(newer, older)])], [], { newest: null }],
    [
      "never lists a plain version within the page budget",
      false,
      endless,
      endless.slice(1).map((_, index) => `c${index}`),
      { newest: null },
    ],
    ["holds no versions list", false, [json({ spec_id: "spec_x" })], [], { pointer: "/versions" }],
    [
      "lists a version with no content_version",
      false,
      [page([{ rendering: "plain" }])],
      [],
      { pointer: "/versions/0/content_version" },
    ],
    [
      "lists a version whose content_version is not a version id",
      false,
      [page([plain("<script>")])],
      [],
      { pointer: "/versions/0/content_version" },
    ],
    [
      "lists a version with no rendering",
      false,
      [page([{ content_version: older, base_content_version: null }])],
      [],
      { pointer: "/versions/0/rendering" },
    ],
    [
      "lists a version whose rendering is not a string",
      false,
      [page([derived(newer, older), { ...plain(older), rendering: null }])],
      [],
      { pointer: "/versions/1/rendering" },
    ],
    [
      "has a next_cursor that is not a string",
      false,
      [page([derived(newer, older)], 2)],
      [],
      { pointer: "/next_cursor" },
    ],
    [
      "names a page already read",
      false,
      [
        page([derived(newer, older)], "c1"),
        page([derived(newer, older)], "c2"),
        page([derived(newer, older)], "c1"),
      ],
      ["c1", "c2"],
      { pointer: "/next_cursor" },
    ],
  ] as const) {
    test(`reads a versions page that ${name}`, async () => {
      const { ref, member } = await stored(isCut);
      const { fetch, seen } = mockFetch(
        expired,
        problem({ code: "spec_not_found", status: 404 }),
        ...pages,
      );
      const error = await fetchDataset(client(fetch).transport, ref).catch((e: unknown) => e);
      const versions = `${BASE}/datasets/${member.spec.spec_id}/versions?limit=100`;
      assert.deepEqual(
        seen.slice(2).map((request) => request.url),
        [versions, ...cursors.map((cursor) => `${versions}&cursor=${cursor}`)],
      );
      if ("newest" in outcome) {
        assert.ok(error instanceof VersionUnavailableError);
        assert.equal(error.newestVersion, outcome.newest);
      } else {
        assert.ok(error instanceof ContractError);
        assert.equal(error.code, "contract_violation");
        assert.equal(error.pointer, outcome.pointer);
      }
    });
  }

  test("says so when the versions route lists the ref's own version first", async () => {
    const { ref, member } = await stored();
    const { fetch } = mockFetch(
      expired,
      problem({ code: "spec_not_found", status: 404 }),
      json({
        schema_version: 1,
        spec_id: member.spec.spec_id,
        versions: [plain(member.contentVersion)],
        next_cursor: null,
        complete: true,
      }),
    );
    const error = await fetchDataset(client(fetch).transport, ref).catch((e: unknown) => e);
    assert.ok(error instanceof VersionUnavailableError);
    assert.equal(error.newestVersion, member.contentVersion);
    assert.ok(!error.message.includes("fetching the spec returns"));
  });

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
    assert.equal(seen[2]!.url, `${BASE}/datasets/${member.spec.spec_id}/versions?limit=100`);
  });
});
