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
    [
      "a recipe that starts from a frame DFO computed",
      async () =>
        recipe(
          DatasetRef.fromJSON(
            (await contractJson<{ ref: unknown }>("refs/ref-derived-member.json")).ref,
          ),
        ).rank({ by: "origin" }),
      /fetch the recipe with latest: true/,
    ],
    [
      "a derived ref",
      async () =>
        DatasetRef.fromJSON(
          (await contractJson<{ ref: unknown }>("refs/ref-derived-member.json")).ref,
        ),
      /use latest: true/,
    ],
    ["a recipe with no step", () => recipe(storedRef), /A recipe with no step/],
  ] as const) {
    test(name, async () => {
      const { fetch, seen } = mockFetch();
      await assert.rejects(
        fetchDataset(transportOver(fetch), await target(), { latest: "stored" }),
        { name: "InvalidRequestError", code: "invalid_argument", message: named },
      );
      assert.deepEqual(seen, []);
    });
  }
});

const ready = await recordedJson<{ ref: unknown }>("analysis-rank-ready.json");
const derivedManifest = await recordedJson("analysis-rank-manifest.json");
const frameBytes = await recordedBytes("analysis-rank-frame.parquet");

describe('a recipe fetched with latest: "stored"', () => {
  const derived = DatasetRef.fromJSON(ready.ref).members[0]!;
  const framePath = `/api/datasets/derived/${derived.spec.spec_id}/${derived.contentVersion}`;

  /** Answers each request by its route: a spec's manifest at `NEWER` with the freshness
   *  `stated` gives it, the analysis, and the computed frame's manifest and file. */
  const routed =
    (stated: Readonly<Record<string, string>> = {}) =>
    (request: Seen): Response => {
      const { pathname } = new URL(request.url);
      if (request.method === "POST") return json(ready)();
      if (pathname === framePath) return json(derivedManifest)();
      if (pathname === `${framePath}/file`)
        return new Response(frameBytes.slice(), { status: 200 });
      const specId = pathname.split("/").at(-1)!;
      return json(manifestOf(specId), 200, freshnessHeaders(stated[specId]))();
    };

  const calls = (seen: readonly Seen[]): string[] =>
    seen.map(({ method, url }) => {
      const { pathname, search } = new URL(url);
      return `${method} ${pathname}${search}`;
    });
  const posted = (seen: readonly Seen[]): Record<string, unknown> =>
    JSON.parse(seen.find(({ method }) => method === "POST")!.body!) as Record<string, unknown>;
  const STORED_QUERY = "?format=parquet&bundle=false&party_totals=false";
  const FRAME_CALLS = [
    `GET ${framePath}`,
    `GET ${framePath}/file?format=parquet&bundle=false&layout=frame`,
  ];

  test("of one reading reads its manifest, posts the stored version and downloads no root", async () => {
    const { fetch, seen } = mockFetch(
      ...Array.from({ length: 4 }, () => routed({ [held.spec.spec_id]: "pending" })),
    );
    const chain = recipe(storedRef).rank({ by: "origin", limit: 6 });
    const data = await fetchDataset(transportOver(fetch), chain, { latest: "stored" });
    assert.deepEqual(calls(seen), [
      `GET /api/datasets/${held.spec.spec_id}${STORED_QUERY}`,
      "POST /api/datasets/analysis",
      ...FRAME_CALLS,
    ]);
    const tree = chain.tree() as { inputs: { data: Record<string, unknown> } };
    assert.deepEqual(posted(seen), {
      tree: { ...tree, inputs: { data: { ...tree.inputs.data, content_version: NEWER } } },
      latest: false,
    });
    assert.notEqual(held.contentVersion, NEWER);
    assert.equal(data.freshness, "pending");
    assert.ok(data.ref.equals(new DatasetRef([derived])));
  });

  test("of several members is refused before any request, as DFO refuses it", async () => {
    const ids = ["0", "1", "2", "3"].map((digit) => `spec_${digit.repeat(32)}`);
    const { fetch, seen } = mockFetch();
    const chain = recipe(new DatasetRef(ids.map(memberOf))).aggregate({ by: "destination" });
    await assert.rejects(fetchDataset(transportOver(fetch), chain, { latest: "stored" }), {
      name: "InvalidRequestError",
      code: "several_members",
    });
    assert.equal(seen.length, 0);
  });

  test("aborts the other manifest reads when one fails", async () => {
    const [first, second] = ["0", "1"].map((digit) => ({
      spec_id: `spec_${digit.repeat(32)}`,
      definition: held.spec.definition,
    }));
    let aborted = false;
    const { fetch, seen } = mockFetch(
      json(manifestOf(`spec_${"9".repeat(32)}`)),
      (_request, { signal }) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
            reject(signal.reason);
          });
        }),
    );
    const chain = recipe(first!).shareOf(second!, { on: ["destination"] });
    await assert.rejects(fetchDataset(transportOver(fetch), chain, { latest: "stored" }), {
      name: "ContractError",
      code: "contract_violation",
    });
    assert.equal(seen.length, 2);
    assert.ok(aborted);
  });

  test("reads a spec's manifest once for a spec root read twice, as its frame without totals", async () => {
    const spec = { spec_id: held.spec.spec_id, definition: held.spec.definition };
    const { fetch, seen } = mockFetch(...Array.from({ length: 4 }, () => routed()));
    const chain = recipe(spec).shareOf(spec, { on: ["destination"] });
    await fetchDataset(transportOver(fetch), chain, { latest: "stored" });
    assert.deepEqual(calls(seen), [
      `GET /api/datasets/${spec.spec_id}?format=parquet&bundle=false&layout=frame&party_totals=false`,
      "POST /api/datasets/analysis",
      ...FRAME_CALLS,
    ]);
    const { inputs } = posted(seen)["tree"] as { inputs: Record<string, unknown> };
    const root = {
      spec_id: spec.spec_id,
      rendering: { without_party_totals: true },
      content_version: NEWER,
    };
    assert.deepEqual(inputs, { data: root, other: root });
  });
});
