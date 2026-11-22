import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { envFrom } from "../src/config/env.ts";
import { DatasetRef, isDerived } from "../src/core/ref.ts";
import type { RefMember } from "../src/core/ref.ts";
import { Dataset } from "../src/datasets/dataset.ts";
import { recipe } from "../src/datasets/recipe.ts";
import { currentManifest, fetchDataset } from "../src/datasets/resolve.ts";
import { Transport } from "../src/http/transport.ts";
import { scenario, scenarioBytes, stepOf } from "./replay.ts";
import {
  contractJson,
  json,
  mockFetch,
  recordedBytes,
  recordedJson,
  recordingSleep,
} from "./support.ts";
import type { Seen } from "./support.ts";

// A `latest: "stored"` fetch on a stub transport: the fetch-ref record's manifest answers
// `GET /datasets/{spec_id}` for each member, and the files route answers the file's bytes, as
// the website's gateway does.
const record = await scenario("fetch-ref");
const recorded = record.exchanges[0]!.response.json as Record<string, unknown>;
const bytes = await scenarioBytes("fetch-ref.parquet");
const storedRef = DatasetRef.fromJSON(stepOf(record, 0, "fetch").ref);
const [first] = storedRef.members;
assert.ok(first !== undefined && !isDerived(first));
const held: RefMember = first;
const NEWER = `cv_${"1".repeat(32)}`;

/** The recorded manifest as the stored newest version of `specId`, at `NEWER`. */
function manifestOf(specId: string): Record<string, unknown> {
  const manifest = structuredClone(recorded);
  manifest["content_version"] = NEWER;
  const definition = manifest["definition"] as Record<string, unknown>;
  definition["spec_id"] = specId;
  return manifest;
}

/** The held member under another spec id, so a ref holds two members. */
function memberOf(specId: string): RefMember {
  return {
    ...held,
    spec: { spec_id: specId, definition: { ...held.spec.definition, spec_id: specId } },
  };
}

const freshnessHeaders = (freshness: string | undefined): Record<string, string> =>
  freshness === undefined ? {} : { "x-dfo-freshness": freshness };

const file = () => new Response(bytes.slice(), { status: 200 });

function transportOver(fetch: typeof globalThis.fetch, sleep?: (ms: number) => Promise<void>) {
  return new Transport({
    baseUrl: "https://api.example/api",
    apiKey: false,
    env: envFrom({}),
    readCredentialsFile: () => null,
    fetch,
    ...(sleep === undefined ? {} : { sleep }),
  });
}

describe('a ref fetched with latest: "stored"', () => {
  test("reads the spec's stored version in the member's rendering, then its file", async () => {
    const { fetch, seen } = mockFetch(
      json(manifestOf(held.spec.spec_id), 200, freshnessHeaders("pending")),
      file,
    );
    const data = await fetchDataset(transportOver(fetch), storedRef, { latest: "stored" });
    const asked = new URL(seen[0]!.url);
    assert.equal(asked.pathname, `/api/datasets/${held.spec.spec_id}`);
    // The ref's member leaves party totals out, so the read asks for the cut.
    assert.deepEqual(Object.fromEntries(asked.searchParams), {
      format: "parquet",
      bundle: "false",
      party_totals: "false",
    });
    assert.match(seen[1]!.url, /\/files\/sha256:/);
    assert.equal(seen.length, 2);
    assert.equal(data.members[0]!.contentVersion, NEWER);
    assert.equal(data.sentence, held.sentence);
    assert.equal(data.freshness, "pending");
    // The ref names the version read, and neither it nor the saved file holds the freshness.
    assert.equal((data.ref.members[0] as RefMember).contentVersion, NEWER);
    assert.doesNotMatch(JSON.stringify(data.ref), /freshness|pending/);
    assert.equal((await Dataset.fromBytes(await data.toBytes())).freshness, null);
  });

  // Each row gives the members' `x-dfo-freshness` headers, undefined for none, and the
  // dataset's freshness.
  for (const [stated, freshness] of [
    [["current", "stale"], "stale"],
    [["pending", "current"], "pending"],
    [["current", "current"], "current"],
    [["stale", undefined], null],
    [["current", "fresh"], null],
  ] as const) {
    test(`is ${String(freshness)} for members stating ${stated.map((value) => value ?? "none").join(" and ")}`, async () => {
      const other = `spec_${"0".repeat(32)}`;
      const { fetch } = mockFetch(
        json(manifestOf(held.spec.spec_id), 200, freshnessHeaders(stated[0])),
        file,
        json(manifestOf(other), 200, freshnessHeaders(stated[1])),
        file,
      );
      const ref = new DatasetRef([held, memberOf(other)]);
      const data = await fetchDataset(transportOver(fetch), ref, { latest: "stored" });
      assert.equal(data.members.length, 2);
      assert.equal(data.freshness, freshness);
    });
  }

  test("follows a 202 through the operation it names to the built version", async () => {
    const operation = (await scenario("operation-resume")).exchanges;
    const running = operation[0]!.response.json as { operation: { operation_id: string } };
    const done = structuredClone(operation.at(-4)!.response.json) as Record<string, unknown>;
    assert.equal((done["operation"] as Record<string, unknown>)["status"], "done");
    done["manifest"] = manifestOf(held.spec.spec_id);
    const { sleep, waits } = recordingSleep();
    const { fetch, seen } = mockFetch(
      // The 202 states stale, and the operation that follows it reads the version current.
      json(running, 202, { "retry-after": "2", ...freshnessHeaders("stale") }),
      json(done),
      file,
    );
    const data = await fetchDataset(transportOver(fetch, sleep), storedRef, { latest: "stored" });
    assert.match(
      seen[1]!.url,
      new RegExp(`/datasets/operations/${running.operation.operation_id}$`),
    );
    assert.deepEqual(waits, [1500]);
    assert.equal(data.members[0]!.contentVersion, NEWER);
    assert.equal(data.freshness, "current");
  });

  test("raises contract_violation for another spec's answer", async () => {
    const { fetch } = mockFetch(json(manifestOf(`spec_${"0".repeat(32)}`)));
    await assert.rejects(fetchDataset(transportOver(fetch), storedRef, { latest: "stored" }), {
      name: "ContractError",
      code: "contract_violation",
      pointer: "/definition/spec_id",
    });
  });
});

describe("a deadline on a stored read", () => {
  /** A response that arrives after `ms` of real time, or rejects when the request aborts first. */
  const answerAfter =
    (ms: number, respond: () => Response) =>
    (_request: unknown, init: RequestInit): Promise<Response> =>
      new Promise((resolve, reject) => {
        const socket = setTimeout(() => {
          resolve(respond());
        }, ms);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(socket);
          reject(init.signal?.reason);
        });
      });

  test("on the first GET is a plain read timeout", async () => {
    const { fetch } = mockFetch(answerAfter(2_000, () => json(manifestOf(held.spec.spec_id))()));
    await assert.rejects(
      fetchDataset(transportOver(fetch), storedRef, { latest: "stored", timeout: 50 }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "DfoTimeoutError");
        assert.ok(!error.message.includes("still running"), error.message);
        return true;
      },
    );
  });

  test("while the operation is polled says the build is still running", async () => {
    const operation = (await scenario("operation-resume")).exchanges;
    const running = operation[0]!.response.json;
    const { fetch } = mockFetch(
      json(running, 202),
      answerAfter(2_000, () => json(running)()),
    );
    await assert.rejects(
      fetchDataset(transportOver(fetch), storedRef, { latest: "stored", timeout: 200 }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "DfoTimeoutError");
        assert.ok(error.message.includes("still running"), error.message);
        return true;
      },
    );
  });
});

describe("currentManifest", () => {
  test("refuses a spec id that is not a server id before any request", async () => {
    const { fetch, seen } = mockFetch();
    await assert.rejects(
      currentManifest(transportOver(fetch), "not-a-spec", held.rendering, {
        deadline: Infinity,
      }),
      {
        name: "InvalidRequestError",
        code: "invalid_argument",
      },
    );
    assert.equal(seen.length, 0);
  });
});

describe('a fetch refuses latest: "stored" before any request', () => {
  const spec = { spec_id: "spec_1", definition: { spec_id: "spec_1" } };

  for (const [name, target, named] of [
    ["a spec", () => spec, /client\.fetch\(spec\)/],
    ["a share", () => "https://developmentfinance.org/s/k3Qx8vTa", /takes no latest: "stored"/],
    ["a recipe with no step", () => recipe(storedRef), /A recipe with no step/],
  ] as const) {
    test(name, async () => {
      const { fetch, seen } = mockFetch();
      await assert.rejects(fetchDataset(transportOver(fetch), target(), { latest: "stored" }), {
        name: "InvalidRequestError",
        code: "invalid_argument",
        message: named,
      });
      assert.deepEqual(seen, []);
    });
  }
});

const ready = await recordedJson<{ ref: unknown }>("analysis-rank-ready.json");
const derivedManifest = await recordedJson("analysis-rank-manifest.json");
const frameBytes = await recordedBytes("analysis-rank-frame.parquet");
const pendingAnswer = await recordedJson<{ body: unknown; headers: Record<string, string> }>(
  "analysis-pending.json",
);

describe('a recipe fetched with latest: "stored"', () => {
  const derived = DatasetRef.fromJSON(ready.ref).members[0]!;
  const framePath = `/api/datasets/derived/${derived.spec.spec_id}/${derived.contentVersion}`;
  const chain = recipe(storedRef).rank({ by: "origin", limit: 6 });

  /** The stored 200: the recorded answer with `resolved_roots` stating `stated`, one entry per
   *  value, and the derived manifest embedded, as `edit` changes the body. */
  const storedAnswer = (
    stated: readonly (string | undefined)[] = ["current"],
    edit: (body: Record<string, unknown>) => void = () => undefined,
  ) => {
    const body: Record<string, unknown> = {
      ...structuredClone(ready),
      resolved_roots: stated.map((freshness, index) => ({
        spec_id: `spec_${String(index).repeat(32)}`,
        content_version: NEWER,
        ...(freshness === undefined ? {} : { freshness }),
      })),
      manifest: structuredClone(derivedManifest),
    };
    edit(body);
    return json(body);
  };
  const frameFile = () => new Response(frameBytes.slice(), { status: 200 });

  const calls = (seen: readonly Seen[]): string[] =>
    seen.map(({ method, url }) => {
      const { pathname, search } = new URL(url);
      return `${method} ${pathname}${search}`;
    });
  const POST = "POST /api/datasets/analysis";
  const DIGEST_FILE = `GET ${framePath}/files/${derived.digest}`;

  test("costs the post and the digest file, resolved by DFO", async () => {
    const { fetch, seen } = mockFetch(storedAnswer(["pending"]), frameFile);
    const data = await fetchDataset(transportOver(fetch), chain, { latest: "stored" });
    assert.deepEqual(calls(seen), [POST, DIGEST_FILE]);
    // The roots go as the recipe built them, the ref's pinned version included.
    assert.deepEqual(JSON.parse(seen[0]!.body!), {
      tree: chain.tree(),
      latest: "stored",
      include: ["manifest"],
    });
    assert.equal(data.freshness, "pending");
    assert.ok(data.ref.equals(new DatasetRef([derived])));
  });

  // Each row gives the `resolved_roots` entries' freshness, undefined for none, and the
  // dataset's freshness.
  for (const [stated, freshness] of [
    [["current", "stale"], "stale"],
    [["pending", "current"], "pending"],
    [["current", "current"], "current"],
    [["stale", undefined], null],
    [["current", "fresh"], null],
  ] as const) {
    test(`is ${String(freshness)} for roots stating ${stated.map((value) => value ?? "none").join(" and ")}`, async () => {
      const { fetch } = mockFetch(storedAnswer(stated), frameFile);
      const data = await fetchDataset(transportOver(fetch), chain, { latest: "stored" });
      assert.equal(data.freshness, freshness);
    });
  }

  test("is null when the answer states no resolved_roots", async () => {
    const { fetch } = mockFetch(
      storedAnswer(undefined, (body) => delete body["resolved_roots"]),
      frameFile,
    );
    const data = await fetchDataset(transportOver(fetch), chain, { latest: "stored" });
    assert.equal(data.freshness, null);
  });

  /** Sets `key` of the stored 200's embedded manifest to `value`. */
  const setManifest = (key: string, value: unknown) => (body: Record<string, unknown>) => {
    (body["manifest"] as Record<string, unknown>)[key] = value;
  };

  // Each row edits the stored 200 and gives the pointer the refusal names.
  const refused: [string, (body: Record<string, unknown>) => void, string][] = [
    ["no manifest", (body) => delete body["manifest"], "/manifest"],
    ["a manifest that is not an object", (body) => (body["manifest"] = []), "/manifest"],
    [
      "another spec's manifest",
      setManifest("spec_id", `ops_${"0".repeat(32)}`),
      "/manifest/spec_id",
    ],
    [
      "another version's manifest",
      setManifest("content_version", `ocv_${"0".repeat(32)}`),
      "/manifest/content_version",
    ],
    ["a left_out that is no list", setManifest("left_out", {}), "/manifest/left_out"],
  ];
  for (const [name, edit, pointer] of refused) {
    test(`refuses ${name} before the file`, async () => {
      const { fetch, seen } = mockFetch(storedAnswer(["current"], edit));
      await assert.rejects(fetchDataset(transportOver(fetch), chain, { latest: "stored" }), {
        name: "ContractError",
        code: "contract_violation",
        pointer,
      });
      assert.deepEqual(calls(seen), [POST]);
    });
  }

  test("reads the series left out from the embedded manifest", async () => {
    const chainAnswer = await recordedJson<{ ref: unknown }>("analysis-chain-ready.json");
    const chainManifest = await recordedJson("analysis-chain-manifest.json");
    const chainFrame = await recordedBytes("analysis-chain-frame.parquet");
    const { fetch, seen } = mockFetch(
      json({ ...chainAnswer, resolved_roots: [], manifest: chainManifest }),
      () => new Response(chainFrame.slice(), { status: 200 }),
    );
    const warnings: unknown[] = [];
    const transport = new Transport({
      baseUrl: "https://api.example/api",
      apiKey: false,
      env: envFrom({}),
      readCredentialsFile: () => null,
      fetch,
      onWarning: (warning) => warnings.push(warning),
    });
    const data = await fetchDataset(transport, chain, { latest: "stored" });
    assert.equal(seen.length, 2);
    assert.equal(data.leftOut.length, (chainManifest["left_out"] as unknown[]).length);
    assert.equal(warnings.length, 1);
    assert.equal((warnings[0] as { code: string }).code, "series_left_out");
  });

  test("posts again after a 202 and then reads the file", async () => {
    const { sleep, waits } = recordingSleep();
    const { fetch, seen } = mockFetch(
      json(pendingAnswer.body, 202, { "retry-after": pendingAnswer.headers["retry-after"]! }),
      storedAnswer(),
      frameFile,
    );
    const data = await fetchDataset(transportOver(fetch, sleep), chain, { latest: "stored" });
    assert.deepEqual(calls(seen), [POST, POST, DIGEST_FILE]);
    assert.equal(seen[0]!.body, seen[1]!.body);
    assert.deepEqual(waits, [2000]);
    assert.equal(data.freshness, "current");
  });

  test("posts a root of a frame DFO computed as it stands", async () => {
    const computed = DatasetRef.fromJSON(
      (await contractJson<{ ref: unknown }>("refs/ref-derived-member.json")).ref,
    );
    const { fetch, seen } = mockFetch(storedAnswer(), frameFile);
    const fromComputed = recipe(computed).rank({ by: "origin" });
    await fetchDataset(transportOver(fetch), fromComputed, { latest: "stored" });
    assert.deepEqual(JSON.parse(seen[0]!.body!), {
      tree: fromComputed.tree(),
      latest: "stored",
      include: ["manifest"],
    });
  });

  test("of a derived ref posts its bare root and reads the digest file", async () => {
    const { fetch, seen } = mockFetch(storedAnswer(["stale"]), frameFile);
    const data = await fetchDataset(transportOver(fetch), new DatasetRef([derived]), {
      latest: "stored",
    });
    assert.deepEqual(calls(seen), [POST, DIGEST_FILE]);
    assert.deepEqual(JSON.parse(seen[0]!.body!), {
      tree: { spec_id: derived.spec.spec_id, content_version: derived.contentVersion },
      latest: "stored",
      include: ["manifest"],
    });
    assert.equal(data.freshness, "stale");
  });
});
