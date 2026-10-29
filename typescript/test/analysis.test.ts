// DFO's operations: running a recipe, reading derived frames, and pins. The replies are the
// ones python/tests/_async/datasets/test_analysis.py replays, recorded from dfo-apis' analysis
// runner over its test doubles: a chain of quotient_of then growth that drops three series over
// two inputs, and a rolling rank that settles on 2022.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";

import { clientOver } from "../src/client.ts";
import { envFrom } from "../src/config/env.ts";
import { Dataset } from "../src/datasets/dataset.ts";
import type { FetchedMember } from "../src/datasets/dataset.ts";
import { derivedDataset } from "../src/datasets/derived.ts";
import { pin } from "../src/datasets/pin.ts";
import { recipe } from "../src/datasets/recipe.ts";
import { fetchDataset } from "../src/datasets/resolve.ts";
import { latestYear } from "../src/core/periods.ts";
import { DatasetRef, isDerived } from "../src/core/ref.ts";
import type { DerivedRefMember, Spec } from "../src/core/ref.ts";
import { Transport } from "../src/http/transport.ts";
import { SeriesLeftOutWarning } from "../src/core/warnings.ts";
import type { DfoWarning } from "../src/core/warnings.ts";
import { scenarioBytes } from "./replay.ts";
import { json, mockFetch, problem, recordedBytes, recordedJson } from "./support.ts";
import type { Seen } from "./support.ts";

const BASE = "https://api.example/api";
const AID: Spec = { spec_id: `spec_${"a".repeat(32)}`, definition: {} };
const FILE_QUERY = "format=parquet&bundle=false&layout=frame";

type Handler = Parameters<typeof mockFetch>[number];

/** A transport over `handlers` whose clock moves only by its sleeps, which it records. */
function make(...handlers: Handler[]) {
  const { fetch, seen } = mockFetch(...handlers);
  const warnings: DfoWarning[] = [];
  const sleeps: number[] = [];
  let now = 1_000_000;
  const transport = new Transport({
    baseUrl: BASE,
    apiKey: false,
    env: envFrom({}),
    readCredentialsFile: () => null,
    fetch,
    onWarning: (warning) => warnings.push(warning),
    now: () => now,
    sleep: (ms) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
  });
  return { transport, seen, warnings, sleeps };
}

const ready = async (name = "chain") => json(await recordedJson(`analysis-${name}-ready.json`));
const manifest = async (name = "chain") =>
  json(await recordedJson(`analysis-${name}-manifest.json`));
const frame = async (name = "chain") => {
  const data = await recordedBytes(`analysis-${name}-frame.parquet`);
  return () =>
    new Response(data, {
      status: 200,
      headers: { "content-type": "application/vnd.apache.parquet" },
    });
};

type Recorded = { status: number; headers: Record<string, string>; body: unknown };

async function pending(): Promise<Handler> {
  const recorded = await recordedJson<Recorded>("analysis-pending.json");
  return json(recorded.body, recorded.status, { "retry-after": recorded.headers["retry-after"]! });
}

async function recordedProblem(name: string): Promise<Handler> {
  const recorded = await recordedJson<Recorded>(`analysis-${name}.json`);
  return json(recorded.body, recorded.status, { "content-type": "application/problem+json" });
}

async function member(name = "chain"): Promise<DerivedRefMember> {
  const { ref } = await recordedJson<{ ref: unknown }>(`analysis-${name}-ready.json`);
  const [found] = DatasetRef.fromJSON(ref).members;
  assert.ok(found && isDerived(found));
  return found;
}

async function framePaths(name = "chain"): Promise<string[]> {
  const found = await member(name);
  const path = `${BASE}/datasets/derived/${found.spec.spec_id}/${found.contentVersion}`;
  return [`GET ${path}`, `GET ${path}/file?${FILE_QUERY}`];
}

const calls = (seen: readonly Seen[]): string[] =>
  seen.map(({ method, url }) => `${method} ${url}`);
const body = (seen: readonly Seen[], index: number): unknown => JSON.parse(seen[index]!.body!);

const CHAIN = recipe(AID)
  .quotientOf(
    { spec_id: `spec_${"b".repeat(32)}`, definition: {} },
    { on: { destination: "place" } },
  )
  .growth({ by: "destination", window: [latestYear(-1), latestYear()] });

describe("a recipe", () => {
  test("runs in one request and reads its frame, warning once of what it left out", async () => {
    const { transport, seen, warnings } = make(await ready(), await manifest(), await frame());
    const data = await fetchDataset(transport, CHAIN);
    assert.deepEqual(calls(seen), [`POST ${BASE}/datasets/analysis`, ...(await framePaths())]);
    assert.deepEqual(body(seen, 0), { tree: CHAIN.tree(), latest: false });
    assert.ok(data.ref.equals(new DatasetRef([await member()])));
    const [built] = data.members;
    assert.ok(built && isDerived(built));
    assert.equal(built.outputDigest, (await member()).outputDigest);
    const served = (await recordedJson("analysis-chain-manifest.json"))["left_out"] as {
      reason: string;
    }[];
    assert.deepEqual(
      data.leftOut.map((series) => series.reason),
      served.map((row) => row.reason),
    );
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0] instanceof SeriesLeftOutWarning);
    assert.equal(warnings[0].code, "series_left_out");
    assert.match(warnings[0].message, /^3 series left out for missing data by growth, quotient_of/);
    assert.equal(data.rowCount, 1);
  });

  test("names each column of its left-out series and steps by the role the call used", async () => {
    const { transport } = make(await ready(), await manifest(), await frame());
    const data = await fetchDataset(transport, CHAIN);
    assert.ok(
      String(data).includes("  Derived: quotient_of by destination, then growth by destination, "),
    );
    assert.deepEqual(data.leftOut.map(String), [
      "LeftOutSeries(destination=country/NGA: growth dropped 1 row from data, endpoint_missing)",
      "LeftOutSeries(destination=country/GHA: quotient_of dropped 2 rows from data, unmatched_key)",
      "LeftOutSeries(destination=country/NGA: quotient_of dropped 1 row from data, " +
        "period_unmatched)",
    ]);
    // The coordinates keep DFO's columns, which the frame's columns match.
    assert.equal(data.leftOut[0]?.coordinates["financingRecipient"], "country/NGA");
  });

  test("run as one operation takes strict, timeout and signal as fetch does", async () => {
    const strict = make(await ready(), await manifest(), await frame());
    await assert.rejects(
      clientOver(strict.transport).analysis.growth(CHAIN, {
        by: "destination",
        window: [2021, 2022],
        strict: true,
      }),
      SeriesLeftOutWarning,
    );
    const late = make(await pending());
    await assert.rejects(
      clientOver(late.transport).analysis.rank(AID, { by: "destination", timeout: 1500 }),
      { name: "DfoTimeoutError", code: "deadline_exceeded" },
    );
    const aborted = make(await ready());
    const reason = new Error("stopped");
    await assert.rejects(
      clientOver(aborted.transport).analysis.shareOf(AID, {
        by: "origin",
        signal: AbortSignal.abort(reason),
      }),
      reason,
    );
  });

  test("raises the left-out warning under strict", async () => {
    const { transport } = make(await ready(), await manifest(), await frame());
    await assert.rejects(fetchDataset(transport, CHAIN, { strict: true }), SeriesLeftOutWarning);
  });

  test("that leaves nothing out warns nothing, and latest reaches the request", async () => {
    const { transport, seen, warnings } = make(
      await ready("rank"),
      await manifest("rank"),
      await frame("rank"),
    );
    const data = await fetchDataset(transport, recipe(AID).rank({ by: "destination", limit: 2 }), {
      latest: true,
    });
    assert.equal((body(seen, 0) as { latest: boolean }).latest, true);
    assert.deepEqual(data.leftOut, []);
    assert.deepEqual(warnings, []);
    const [built] = data.members;
    assert.ok(built && isDerived(built));
    assert.deepEqual(
      built.resolvedPeriods.map((period) => period.period),
      ["2022"],
    );
  });

  test("pending posts again after its Retry-After", async () => {
    const { transport, seen, sleeps } = make(
      await pending(),
      await ready("rank"),
      await manifest("rank"),
      await frame("rank"),
    );
    await fetchDataset(transport, recipe(AID).rank({ by: "destination" }));
    assert.deepEqual(calls(seen).slice(0, 2), Array(2).fill(`POST ${BASE}/datasets/analysis`));
    assert.deepEqual(body(seen, 0), body(seen, 1));
    assert.deepEqual(sleeps, [2000]);
  });

  test("pending past its timeout raises deadline_exceeded without waiting", async () => {
    const { transport, sleeps } = make(await pending());
    await assert.rejects(
      fetchDataset(transport, recipe(AID).rank({ by: "destination" }), { timeout: 1500 }),
      { name: "DfoTimeoutError", code: "deadline_exceeded", retryable: true },
    );
    assert.deepEqual(sleeps, []);
  });

  for (const [name, errorName, code] of [
    ["refused-role-ambiguous", "InvalidRequestError", "role_ambiguous"],
    ["refused-snapshot-not-found", "NotFoundError", "snapshot_not_found"],
  ] as const) {
    test(`refused raises its class with the fix (${code})`, async () => {
      const { transport, seen } = make(await recordedProblem(name));
      const error = await fetchDataset(transport, recipe(AID).rank({ by: "destination" })).catch(
        (caught: unknown) => caught,
      );
      assert.ok(error instanceof Error);
      assert.equal(error.name, errorName);
      const { problem: document } = error as unknown as { problem: Record<string, unknown> };
      const recorded = await recordedJson<{ body: { fix: unknown } }>(`analysis-${name}.json`);
      assert.deepEqual(document["fix"], recorded.body.fix);
      assert.equal((error as unknown as { code: string }).code, code);
      assert.equal(seen.length, 1);
    });
  }

  for (const [name, answer] of [
    ["no ref", () => Promise.resolve({ status: "ready" })],
    [
      "no members",
      () => Promise.resolve({ status: "ready", ref: { format_version: 1, members: [] } }),
    ],
    [
      "dataset members",
      async () => {
        const { ref } = await recordedJson<{ ref: Record<string, unknown> }>(
          "analysis-chain-ready.json",
        );
        return { status: "ready", ref: { ...ref, format_version: 1 } };
      },
    ],
  ] as const) {
    test(`ready with ${name} raises ContractError`, async () => {
      const { transport } = make(json(await answer()));
      await assert.rejects(fetchDataset(transport, CHAIN), {
        name: "ContractError",
        code: "contract_violation",
      });
    });
  }

  for (const [name, options] of [
    ["window", { window: [2020, 2024] }],
    ["entities", { entities: { origin: ["country/DEU"] } }],
    ["facets", { facets: { unit: "USD" } }],
    ["layout", { layout: "long" }],
    ["partyTotals", { partyTotals: true }],
    ["onProgress", { onProgress: () => undefined }],
  ] as const) {
    test(`refuses ${name} unsent`, async () => {
      const { transport, seen } = make();
      await assert.rejects(fetchDataset(transport, CHAIN, options), {
        name: "InvalidRequestError",
        code: "invalid_argument",
        message: new RegExp(`takes no ${name}`),
      });
      assert.deepEqual(seen, []);
    });
  }
});

describe("a derived ref", () => {
  test("reads the frame it names", async () => {
    const { transport, seen, warnings } = make(await manifest(), await frame());
    const data = await fetchDataset(transport, new DatasetRef([await member()]));
    assert.deepEqual(calls(seen), await framePaths());
    assert.ok(data.ref.equals(new DatasetRef([await member()])));
    assert.equal(warnings.length, 1);
  });

  test("whose file does not hash to the ref's digest is refused after one more ask", async () => {
    const tampered = () => new Response(new Uint8Array([0]), { status: 200 });
    const { transport, seen } = make(await manifest(), tampered, tampered);
    await assert.rejects(fetchDataset(transport, new DatasetRef([await member()])), {
      code: "digest_mismatch",
    });
    const [manifestCall, fileCall] = await framePaths();
    assert.deepEqual(calls(seen), [manifestCall, fileCall, fileCall]);
  });

  test("with latest posts its bare root", async () => {
    const { transport, seen } = make(
      await ready("rank"),
      await manifest("rank"),
      await frame("rank"),
    );
    const found = await member("rank");
    await fetchDataset(transport, new DatasetRef([found]), { latest: true });
    assert.deepEqual(body(seen, 0), {
      tree: { spec_id: found.spec.spec_id, content_version: found.contentVersion },
      latest: true,
    });
  });

  test("whose frame expired is computed again on its roots", async () => {
    const { transport, seen } = make(
      problem({ status: 410, code: "artifact_expired" }),
      await ready("rank"),
      await manifest("rank"),
      await frame("rank"),
    );
    const found = await member("rank");
    const data = await fetchDataset(transport, new DatasetRef([found]));
    assert.deepEqual(body(seen, 1), {
      tree: { spec_id: found.spec.spec_id, content_version: found.contentVersion },
      latest: false,
    });
    assert.ok(data.ref.equals(new DatasetRef([found])));
  });

  for (const [name, again] of [
    ["refused", () => Promise.resolve(problem({ status: 404, code: "recipe_not_found" }))],
    ["another version", () => ready("chain")],
  ] as const) {
    test(`whose frame DFO cannot compute again is unavailable (${name})`, async () => {
      const { transport, seen } = make(
        problem({ status: 410, code: "artifact_expired" }),
        await again(),
      );
      await assert.rejects(fetchDataset(transport, new DatasetRef([await member("rank")])), {
        name: "VersionUnavailableError",
        newestVersion: null,
        message: /client\.fetch\(ref, \{ latest: true \}\)/,
      });
      assert.equal(seen.length, 2);
    });
  }

  test("whose recomputation meets a transient refusal raises it as it came", async () => {
    const busy = problem({ status: 503, code: "service_unavailable", retryable: true });
    const { transport } = make(
      problem({ status: 410, code: "artifact_expired" }),
      busy,
      busy,
      busy,
    );
    await assert.rejects(fetchDataset(transport, new DatasetRef([await member("rank")])), {
      name: "ServerError",
      code: "service_unavailable",
      retryable: true,
    });
  });

  test("recomputed with another digest reads the new frame and warns", async () => {
    const answer = await recordedJson<{ ref: { members: [{ artifact: { digest: string } }] } }>(
      "analysis-rank-ready.json",
    );
    answer.ref.members[0].artifact.digest = `sha256:${"0".repeat(64)}`;
    const old = DatasetRef.fromJSON(answer.ref);
    const { transport, warnings } = make(
      problem({ status: 410, code: "artifact_expired" }),
      await ready("rank"),
      await manifest("rank"),
      await frame("rank"),
    );
    const data = await fetchDataset(transport, old);
    assert.deepEqual(
      warnings.map((warning) => warning.code),
      ["ref_digest_changed"],
    );
    assert.ok(data.ref.equals(new DatasetRef([await member("rank")])));
  });

  test("of two derived members is refused unsent", async () => {
    const { transport, seen } = make();
    const ref = new DatasetRef([await member(), await member("rank")]);
    await assert.rejects(fetchDataset(transport, ref), {
      name: "InvalidRequestError",
      code: "invalid_argument",
    });
    assert.deepEqual(seen, []);
  });
});

/** A dataset of one stored version, or of `count`, each another spec answering a part. */
async function versions(count = 1): Promise<Dataset> {
  const data = await scenarioBytes("fetch-ref.parquet");
  const fetched = Array.from({ length: count }, (_, index): FetchedMember => {
    const specId = `spec_${String(index).repeat(32)}`;
    return {
      parts: count === 1 ? [] : [`part ${index}`],
      spec: { spec_id: specId, definition: { schema_version: 1, spec_id: specId, identity: {} } },
      sentence: "A sentence.",
      contentVersion: `cv_${String(index).repeat(32)}`,
      manifest: { retention: { pinned: false, held_until: "2026-11-27T00:00:00Z" } },
      digest: `sha256:${createHash("sha256").update(data).digest("hex")}`,
      rendering: { format: "parquet", bundle: false, without_party_totals: true },
      data,
    };
  });
  return Dataset.create(fetched, { layout: "long" });
}

/** DFO's answer to a pin: the version and digest the request named. */
const pinned = (request: Seen) => {
  const [, specId, contentVersion] = /\/datasets\/([^/]+)\/([^/]+)\/pin$/.exec(request.url)!;
  const { artifact_digest } = JSON.parse(request.body!) as { artifact_digest: string };
  return json({
    schema_version: 1,
    pinned: { id: specId, content_version: contentVersion, artifact_digest, pinned_at: "x" },
  })();
};

describe("pin", () => {
  test("pins each member and returns the dataset pinned", async () => {
    const data = await versions();
    const { transport, seen } = make(pinned);
    const kept = await pin(transport, data);
    const [only] = data.members;
    assert.ok(only && !isDerived(only));
    assert.deepEqual(calls(seen), [
      `POST ${BASE}/datasets/${only.spec.spec_id}/${only.contentVersion}/pin`,
    ]);
    assert.deepEqual(body(seen, 0), { schema_version: 1, artifact_digest: only.digest });
    assert.deepEqual([kept.pinned, kept.heldUntil], [true, null]);
    assert.ok(kept.ref.equals(data.ref));
    assert.equal(data.pinned, false);
    assert.match(String(kept), /\(exact\), pinned\n/);
    assert.deepEqual(await kept.toRows(), await data.toRows());
  });

  test("refuses a derived dataset unsent", async () => {
    const { dataset } = await derivedDataset(
      await member("rank"),
      await recordedJson("analysis-rank-manifest.json"),
      await recordedBytes("analysis-rank-frame.parquet"),
    );
    const { transport, seen } = make();
    await assert.rejects(pin(transport, dataset), {
      name: "InvalidRequestError",
      code: "invalid_argument",
      message: /frame DFO computed/,
    });
    assert.deepEqual(seen, []);
  });

  for (const [name, answer, errorName] of [
    ["another version", json({ schema_version: 1, pinned: {} }), "ContractError"],
    [
      "allowance spent",
      problem({ status: 429, code: "allowance_exhausted" }),
      "QuotaExceededError",
    ],
  ] as const) {
    test(`raises when DFO does not confirm it (${name})`, async () => {
      const { transport } = make(answer);
      await assert.rejects(pin(transport, await versions()), { name: errorName, pinned: [] });
    });
  }

  test("that fails part-way names the versions it pinned", async () => {
    const data = await versions(3);
    const { transport, seen } = make(pinned, problem({ status: 429, code: "allowance_exhausted" }));
    const error = await pin(transport, data).then(
      () => assert.fail("the pin succeeded"),
      (caught: unknown) => caught as Error & { code: string; pinned: readonly string[] },
    );
    assert.equal(seen.length, 2);
    assert.deepEqual([error.name, error.code], ["QuotaExceededError", "allowance_exhausted"]);
    const [first, second] = data.members;
    assert.deepEqual(error.pinned, [first!.contentVersion]);
    assert.ok(error.message.includes(`${first!.spec.spec_id} at ${first!.contentVersion}`));
    assert.ok(!error.message.includes(second!.contentVersion), error.message);
  });
});

test("client.analysis runs one step as a recipe of one step", async () => {
  const { transport, seen } = make(
    await ready("rank"),
    await manifest("rank"),
    await frame("rank"),
  );
  const client = clientOver(transport);
  await client.analysis.rank(AID, { by: "destination", limit: 2 });
  assert.deepEqual(body(seen, 0), {
    tree: recipe(AID).rank({ by: "destination", limit: 2 }).tree(),
    latest: false,
  });
  assert.equal(
    String(client.analysis),
    "<Analysis: filter, aggregate, growth, rank, quotientOf, shareOf, join, sumOf, compare>",
  );
});
