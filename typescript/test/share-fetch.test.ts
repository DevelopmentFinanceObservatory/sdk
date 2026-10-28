// Fetching what a share shows: the slot's frame now or at a moment, read as the exact version,
// and every refusal of a slot, moment or option. The share replies are the ones
// python/tests/_async/datasets/test_share_fetch.py replays, recorded from dfo-apis' shares door
// over its test doubles: a live share of three cards, whose slot 2 served its card's own frame
// and then newer data. Those doubles draw a frame no dataset route serves, so each test points
// the slot's frames at a recorded version: the contract's `fetch-ref` dataset version, whose
// manifest lists the frame file `fetch-spec-frame-layout.parquet`, and the ranked frame
// `analysis-rank-*` DFO computed.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { envFrom } from "../src/config/env.ts";
import { DatasetRef, isDerived } from "../src/core/ref.ts";
import type { Spec } from "../src/core/ref.ts";
import { dayText } from "../src/datasets/dataset.ts";
import type { FetchOptions } from "../src/datasets/fetch.ts";
import { Share, today } from "../src/datasets/publication.ts";
import type { ShareUrl } from "../src/datasets/publication.ts";
import { fetchDataset } from "../src/datasets/resolve.ts";
import { Transport } from "../src/http/transport.ts";
import { scenario, scenarioBytes } from "./replay.ts";
import { json, mockFetch, problem, recordedBytes, recordedJson } from "./support.ts";
import type { Seen } from "./support.ts";

const BASE = "https://api.example/api";
const SHARES = `${BASE}/presentation/shares`;
const SHARE_ID = "CJmD6XzG";
const SHARE_URL = `https://site.example/s/${SHARE_ID}`;
const SLOT_2_CARD = "cmp_ced1680e050bfd9b4226a4e6";
const POSTED_ID = "spec_774d6c001a6250aa67ca676ab067895e";
const VERSION = "cv_b92d94774702c7f05f2075d0b03dd756";
const FRAME_DIGEST = "sha256:f4026e80af4b8683d3bb86645ab3aca83dff75cd03fdd4c73ec54ba638922104";
const TITLE = "Malaria grants by year";

type Handler = Parameters<typeof mockFetch>[number];
type Recorded = { status: number; headers: Record<string, string>; body: Record<string, unknown> };
type Frame = { spec_id: string; content_version: string };

function make(...handlers: Handler[]) {
  const { fetch, seen } = mockFetch(...handlers);
  const transport = new Transport({
    baseUrl: BASE,
    apiKey: false,
    env: envFrom({}),
    readCredentialsFile: () => null,
    fetch,
    onWarning: () => {},
    sleep: () => Promise.resolve(),
  });
  return { transport, seen };
}

const calls = (seen: readonly Seen[]): string[] =>
  seen.map(({ method, url }) => `${method} ${url}`);

const reply = (name: string): Promise<Recorded> => recordedJson<Recorded>(`${name}.json`);

const answered = ({ status, body }: Recorded): Handler => json(body, status);

const parquet =
  (data: Uint8Array<ArrayBuffer>): Handler =>
  () =>
    new Response(data, {
      status: 200,
      headers: { "content-type": "application/vnd.apache.parquet" },
    });

async function threeSlots(): Promise<Share> {
  const { body } = await reply("share-three-created");
  return new Share({
    id: String(body["id"]),
    url: String(body["url"]) as ShareUrl,
    embedUrl: String(body["embed_url"]) as ShareUrl,
    dataUrls: body["data_urls"] as string[],
    revision: Number(body["revision"]),
    latest: body["latest"] === true,
    writeToken: String(body["write_token"]),
  });
}

const datasetFrame = (): Frame => ({ spec_id: POSTED_ID, content_version: VERSION });

async function computedFrame(): Promise<Frame> {
  const ready = await recordedJson<{ ref: { members: Record<string, unknown>[] } }>(
    "analysis-rank-ready.json",
  );
  const [member] = ready.ref.members;
  return {
    spec_id: String((member!["spec"] as Record<string, unknown>)["spec_id"]),
    content_version: String(member!["content_version"]),
  };
}

/** The recorded slot 2 card, drawn on `frame`. */
async function slotCard(frame: Frame): Promise<Handler> {
  const recorded = await reply("share-slot-card");
  const payload = recorded.body["resolved_payload"] as Record<string, Record<string, unknown>>;
  payload["provenance"]!["inputs"] = [frame];
  return answered(recorded);
}

/** The recorded history, slot 2's newer frame computed and its first a dataset version. */
async function slotHistory(): Promise<Handler> {
  const recorded = await reply("share-three-history");
  const [newer, , first] = recorded.body["served"] as Record<string, unknown>[];
  newer!["frame"] = await computedFrame();
  first!["frame"] = datasetFrame();
  return answered(recorded);
}

/** Slot 2 serves a dataset frame, then a replace leaves it without a card, then a later replace
 *  fills it with the computed frame. */
async function emptiedHistory(): Promise<Handler> {
  const recorded = await reply("share-three-emptied-history");
  const [later, empty, , first] = recorded.body["served"] as Record<string, unknown>[];
  assert.equal(empty!["component_id"], null);
  later!["frame"] = await computedFrame();
  first!["frame"] = datasetFrame();
  return answered(recorded);
}

/** The dataset version's manifest, Search's sentence, and its frame file. */
async function storedVersion(): Promise<Handler[]> {
  const record = await scenario("fetch-ref");
  const resubmit = await recordedJson<{ parts: { spec: Record<string, unknown> }[] }>(
    "probe-resubmit-identity.json",
  );
  const spec = resubmit.parts[0]!.spec;
  spec["spec_id"] = POSTED_ID;
  (spec["definition"] as Record<string, unknown>)["spec_id"] = POSTED_ID;
  return [
    json(record.exchanges[0]!.response.json),
    json(resubmit),
    parquet(await scenarioBytes("fetch-spec-frame-layout.parquet")),
  ];
}

const storedVersionCalls = [
  `GET ${BASE}/datasets/${POSTED_ID}/${VERSION}`,
  `POST ${BASE}/search/resolve`,
  `GET ${BASE}/datasets/${POSTED_ID}/${VERSION}/files/${FRAME_DIGEST}`,
];

async function computedVersion(): Promise<Handler[]> {
  return [
    json(await recordedJson("analysis-rank-ready.json")),
    json(await recordedJson("analysis-rank-manifest.json")),
    parquet(await recordedBytes("analysis-rank-frame.parquet")),
  ];
}

async function computedVersionCalls(): Promise<string[]> {
  const { spec_id, content_version } = await computedFrame();
  const derived = `${BASE}/datasets/derived/${spec_id}/${content_version}`;
  return [
    `POST ${BASE}/datasets/analysis`,
    `GET ${derived}`,
    `GET ${derived}/file?format=parquet&bundle=false&layout=frame`,
  ];
}

describe("a share fetch", () => {
  for (const [name, target, read] of [
    ["share", threeSlots, false],
    ["url", () => SHARE_URL, true],
    ["embed url", () => `https://site.example/embed/${SHARE_ID}/?x=1`, true],
  ] as const) {
    test(`of a ${name} reads the exact version its slot shows now, on the day it read`, async () => {
      const { transport, seen } = make(
        ...(read ? [answered(await reply("share-three-read"))] : []),
        await slotCard(datasetFrame()),
        ...(await storedVersion()),
      );
      const before = dayText(today());
      const data = await fetchDataset(transport, await target(), { slot: 2 });
      const after = dayText(today());

      assert.deepEqual(calls(seen), [
        ...(read ? [`GET ${SHARES}/${SHARE_ID}`] : []),
        `GET ${SHARES}/${SHARE_ID}/slots/2`,
        ...storedVersionCalls,
      ]);
      const [member] = data.ref.members;
      assert.ok(member !== undefined && !isDerived(member));
      assert.deepEqual(
        [member.spec.spec_id, member.contentVersion, member.digest, member.rendering],
        [
          POSTED_ID,
          VERSION,
          FRAME_DIGEST,
          { format: "parquet", bundle: false, layout: "frame", without_party_totals: true },
        ],
      );
      assert.equal(data.layoutVersion, "frame");
      const shown = `Shown by: share ${SHARE_ID}, slot 2 "${TITLE}", on `;
      const text = String(data);
      assert.ok(text.includes(shown + before) || text.includes(shown + after), text);
    });
  }

  for (const [name, asOf, computed, day] of [
    ["an ISO date reads the newer computed frame", "2026-10-28", true, "28 October 2026"],
    [
      "a Date between reads the first dataset frame",
      new Date("2026-10-28T17:13:42.427Z"),
      false,
      "28 October 2026",
    ],
    [
      "an RFC 3339 date-time between reads the first dataset frame",
      "2026-10-28T17:13:42.427Z",
      false,
      "28 October 2026",
    ],
    ["a later date reads the newer computed frame", "2026-10-29", true, "29 October 2026"],
  ] as const) {
    test(`asOf as ${name}`, async () => {
      const { transport, seen } = make(
        await slotHistory(),
        answered(await reply("card-read")),
        ...(computed ? await computedVersion() : await storedVersion()),
      );
      const data = await fetchDataset(transport, await threeSlots(), { slot: 2, asOf });

      assert.deepEqual(calls(seen), [
        `GET ${SHARES}/${SHARE_ID}/history`,
        `GET ${BASE}/presentation/components/${SLOT_2_CARD}?revision=1`,
        ...(computed ? await computedVersionCalls() : storedVersionCalls),
      ]);
      const [member] = data.ref.members;
      const shown = computed ? await computedFrame() : datasetFrame();
      assert.deepEqual(
        [member?.spec.spec_id, member?.contentVersion],
        [shown.spec_id, shown.content_version],
      );
      if (computed) {
        assert.deepEqual(JSON.parse(seen[2]!.body!), { tree: shown, latest: false });
      }
      assert.ok(String(data).includes(`slot 2 "${TITLE}", on ${day}`), String(data));
    });
  }

  // Only a live share read at an earlier moment can show other data now; any other read of what
  // the slot shows now would fail the same way, so its error names no fetch.
  for (const [name, latest, asOf, hinted] of [
    ["now", true, undefined, false],
    ["asOf on a live share", true, "2026-10-28T17:13:42.427Z", true],
    ["asOf on a snapshot", false, "2026-10-28T17:13:42.427Z", false],
  ] as const) {
    test(`a slot whose dataset frame expired is unavailable, naming the newest: ${name}`, async () => {
      const newest = `cv_${"c".repeat(32)}`;
      const shown =
        asOf === undefined
          ? [await slotCard(datasetFrame())]
          : [await slotHistory(), answered(await reply("card-read"))];
      const { transport, seen } = make(
        ...shown,
        problem({ status: 410, code: "artifact_expired" }),
        json({
          spec_id: POSTED_ID,
          versions: [{ content_version: newest, base_content_version: null, rendering: "plain" }],
          next_cursor: null,
          complete: true,
        }),
      );
      const three = await threeSlots();
      const share = new Share({
        id: three.id,
        url: three.url,
        embedUrl: three.embedUrl,
        dataUrls: three.dataUrls,
        revision: three.revision,
        latest,
        writeToken: three.writeToken,
      });
      const error = await fetchDataset(transport, share, { slot: 2, asOf }).then(
        () => assert.fail("the fetch read an expired frame"),
        (caught: unknown) => caught as Error & { code: string; newestVersion: string },
      );
      assert.equal(error.name, "VersionUnavailableError");
      assert.deepEqual([error.code, error.newestVersion], ["artifact_expired", newest]);
      assert.equal(/client\.fetch\(share, \{ slot: 2 \}\)/.test(error.message), hinted);
      assert.equal(error.message.includes("cannot show slot 2"), !hinted);
      assert.equal(calls(seen).at(-1), `GET ${BASE}/datasets/${POSTED_ID}/versions?limit=100`);
    });
  }

  test("asOf before the slot first served is refused, naming history", async () => {
    const { transport, seen } = make(await slotHistory());
    await assert.rejects(
      fetchDataset(transport, await threeSlots(), { slot: 2, asOf: "2026-10-27" }),
      (error: Error & { code?: string }) =>
        error.code === "invalid_argument" && error.message.includes("client.history(share)"),
    );
    assert.deepEqual(calls(seen), [`GET ${SHARES}/${SHARE_ID}/history`]);
  });

  for (const [name, asOf, computed] of [
    ["before it was emptied reads the first frame", "2026-10-28", false],
    ["after it was refilled reads the later frame", "2026-10-30", true],
  ] as const) {
    test(`asOf ${name} of an emptied slot`, async () => {
      const { transport, seen } = make(
        await emptiedHistory(),
        answered(await reply("card-read")),
        ...(computed ? await computedVersion() : await storedVersion()),
      );
      const data = await fetchDataset(transport, await threeSlots(), { slot: 2, asOf });

      assert.deepEqual(calls(seen), [
        `GET ${SHARES}/${SHARE_ID}/history`,
        `GET ${BASE}/presentation/components/${SLOT_2_CARD}?revision=1`,
        ...(computed ? await computedVersionCalls() : storedVersionCalls),
      ]);
      const [member] = data.ref.members;
      const shown = computed ? await computedFrame() : datasetFrame();
      assert.deepEqual(
        [member?.spec.spec_id, member?.contentVersion],
        [shown.spec_id, shown.content_version],
      );
    });
  }

  test("asOf while a slot showed no card is not found, naming the slot", async () => {
    const { transport, seen } = make(await emptiedHistory());
    await assert.rejects(
      fetchDataset(transport, await threeSlots(), { slot: 2, asOf: "2026-10-29" }),
      (error: Error & { code?: string }) =>
        error.name === "NotFoundError" &&
        error.code === "not_found" &&
        error.message.includes("Slot 2") &&
        error.message.includes("no card"),
    );
    assert.deepEqual(calls(seen), [`GET ${SHARES}/${SHARE_ID}/history`]);
  });

  for (const [name, target, slot] of [
    ["a Share given no slot", threeSlots, undefined],
    ["a Share given slot 4", threeSlots, 4],
    ["a URL given no slot", () => SHARE_URL, undefined],
    ["a URL given slot 4", () => SHARE_URL, 4],
  ] as const) {
    test(`of ${name} is refused with its numbering`, async () => {
      const shared = await target();
      const { transport, seen } = make(answered(await reply("share-three-read")));
      await assert.rejects(
        fetchDataset(transport, shared, slot === undefined ? {} : { slot }),
        (error: Error & { code?: string }) =>
          error.code === "invalid_argument" && error.message.includes("slot: 1 to slot: 3"),
      );
      assert.deepEqual(
        calls(seen),
        typeof shared === "string" ? [`GET ${SHARES}/${SHARE_ID}`] : [],
      );
    });
  }

  // The share read after the contract's `live-replace-with-fewer-cards` replacement: slot 1
  // holds a card, slots 2 and 3 are listed with `card: null` and keep their URLs.
  for (const [name, target, read] of [
    ["share", threeSlots, false],
    ["url", () => SHARE_URL, true],
  ] as const) {
    test(`of a ${name} whose slot a replacement left empty is not found, naming the slot`, async () => {
      const { transport, seen } = make(
        ...(read ? [answered(await reply("share-emptied-read"))] : []),
        answered(await reply("share-slot-empty")),
      );
      await assert.rejects(
        fetchDataset(transport, await target(), { slot: 2 }),
        (error: Error & { code?: string }) =>
          error.name === "NotFoundError" &&
          error.code === "not_found" &&
          error.message.includes("slot 2"),
      );
      assert.deepEqual(calls(seen), [
        ...(read ? [`GET ${SHARES}/${SHARE_ID}`] : []),
        `GET ${SHARES}/${SHARE_ID}/slots/2`,
      ]);
    });
  }

  for (const [name, options] of [
    ["slot 0", { slot: 0 }],
    ["slot 1.5", { slot: 1.5 }],
    ["slot as text", { slot: "2" }],
    ["asOf as words", { asOf: "last week" }],
    ["asOf as a number", { asOf: 20261028 }],
    ["asOf on a day that does not exist", { asOf: "2026-02-30" }],
    ["asOf as an invalid Date", { asOf: new Date(Number.NaN) }],
    ["window", { window: "latest" }],
    ["entities", { entities: { recipient: ["country/ETH"] } }],
    ["facets", { facets: {} }],
    ["partyTotals", { partyTotals: false }],
    ["layout long", { layout: "long" }],
    ["latest", { latest: true }],
  ] as const) {
    test(`given ${name} is refused unsent`, async () => {
      const { transport, seen } = make();
      await assert.rejects(fetchDataset(transport, SHARE_URL, options as FetchOptions), {
        name: "InvalidRequestError",
        code: "invalid_argument",
      });
      assert.deepEqual(seen, []);
    });
  }

  test("of a slot showing a note is refused after its card is read", async () => {
    const one = new Share({
      id: SHARE_ID,
      url: "https://site.example/s/u",
      embedUrl: "https://site.example/embed/e",
      dataUrls: [`${SHARES}/${SHARE_ID}/slots/1/data`],
      revision: 1,
      latest: true,
      writeToken: null,
    });
    const { transport, seen } = make(answered(await reply("share-note-slot-card")));
    await assert.rejects(fetchDataset(transport, one), {
      name: "InvalidRequestError",
      code: "invalid_argument",
    });
    assert.deepEqual(calls(seen), [`GET ${SHARES}/${SHARE_ID}/slots/1`]);
  });
});

describe("a share option or a bare share id without a share", () => {
  for (const [name, target, options] of [
    [
      "slot on a spec",
      (): Promise<Spec> => Promise.resolve({ spec_id: `spec_${"a".repeat(32)}`, definition: {} }),
      { slot: 1 },
    ],
    [
      "asOf on a ref",
      async () =>
        DatasetRef.fromJSON((await recordedJson<{ ref: unknown }>("analysis-rank-ready.json")).ref),
      { asOf: "2026-10-28" },
    ],
    ["a bare share id", () => Promise.resolve(SHARE_ID), {}],
  ] as const) {
    test(`is refused unsent: ${name}`, async () => {
      const { transport, seen } = make();
      await assert.rejects(fetchDataset(transport, await target(), options), {
        name: "InvalidRequestError",
        code: "invalid_argument",
      });
      assert.deepEqual(seen, []);
    });
  }
});
