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

const READ = `GET ${SHARES}/${SHARE_ID}`;

/** The recorded read of the three-card share, live or a snapshot, cut to its first `slots`. */
async function shareRead({ live = true, slots = 3 } = {}): Promise<Handler> {
  const recorded = await reply("share-three-read");
  recorded.body["mode"] = live ? "live" : "snapshot";
  recorded.body["slots"] = (recorded.body["slots"] as unknown[]).slice(0, slots);
  return answered(recorded);
}

/** A Share like the recorded one, with `changes`. */
async function sharedWith(changes: { dataUrls?: readonly string[]; latest?: boolean }) {
  const three = await threeSlots();
  return new Share({
    id: three.id,
    url: three.url,
    embedUrl: three.embedUrl,
    dataUrls: changes.dataUrls ?? three.dataUrls,
    revision: three.revision,
    latest: changes.latest ?? three.latest,
    writeToken: three.writeToken,
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

/** The `slotHistory` entries cut into pages of `sizes`, each naming the next page by its cursor,
 *  the last naming none. */
async function pagedHistory(...sizes: number[]): Promise<Handler[]> {
  const entries = ((await reply("share-three-history")).body as { served: unknown[] }).served;
  const [newer, , first] = entries as Record<string, unknown>[];
  newer!["frame"] = await computedFrame();
  first!["frame"] = datasetFrame();
  assert.equal(
    sizes.reduce((total, size) => total + size, 0),
    entries.length,
  );
  let start = 0;
  return sizes.map((size, index) => {
    const page = entries.slice(start, start + size);
    start += size;
    const next = index === sizes.length - 1 ? null : `cursor-${index + 1}`;
    return json({ id: SHARE_ID, served: page, next }, 200);
  });
}

/** Slot 2 serves a dataset frame, then a replace leaves it without a card, then a later replace
 *  fills it with the computed frame. `shuffled` serves the entries in no order of time. */
async function emptiedHistory(shuffled = false): Promise<Handler> {
  const recorded = await reply("share-three-emptied-history");
  const served = recorded.body["served"] as Record<string, unknown>[];
  const [later, empty, slotOne, first] = served;
  assert.equal(empty!["component_id"], null);
  later!["frame"] = await computedFrame();
  first!["frame"] = datasetFrame();
  if (shuffled) {
    recorded.body["served"] = [first, later, slotOne, empty];
  }
  return answered(recorded);
}

const storedManifest = async (): Promise<unknown> =>
  (await scenario("fetch-ref")).exchanges[0]!.response.json;

/** Search's answer to the identity resubmit, naming `specId`. */
async function resubmitted(specId: string): Promise<Handler> {
  const resubmit = await recordedJson<{ parts: { spec: Record<string, unknown> }[] }>(
    "probe-resubmit-identity.json",
  );
  const spec = resubmit.parts[0]!.spec;
  spec["spec_id"] = specId;
  (spec["definition"] as Record<string, unknown>)["spec_id"] = specId;
  return json(resubmit);
}

/** The dataset version's manifest, its frame file, and Search's sentence, or `sentence` in its
 *  place. */
async function storedVersion(sentence?: Handler): Promise<Handler[]> {
  return [
    json(await storedManifest()),
    parquet(await scenarioBytes("fetch-spec-frame-layout.parquet")),
    sentence ?? (await resubmitted(POSTED_ID)),
  ];
}

const storedVersionCalls = [
  `GET ${BASE}/datasets/${POSTED_ID}/${VERSION}`,
  `GET ${BASE}/datasets/${POSTED_ID}/${VERSION}/files/${FRAME_DIGEST}`,
  `POST ${BASE}/search/resolve`,
];

/** The stored manifest without its frame-layout files, as a long-layout fetch leaves a version:
 *  long Parquet, the canonical `{format: frame}` and statistics among them. `longDigest`
 *  replaces the long Parquet file's digest. */
async function longOnlyManifest(longDigest?: string): Promise<Record<string, unknown>> {
  const manifest = (await storedManifest()) as Record<string, unknown>;
  const artifacts = (manifest["artifacts"] as Record<string, unknown>[]).filter(
    (artifact) => (artifact["rendering"] as Record<string, unknown>)["layout"] !== "frame",
  );
  if (longDigest !== undefined) artifacts[0]!["artifact_digest"] = longDigest;
  return { ...manifest, artifacts };
}

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
  for (const [name, target] of [
    ["share", threeSlots],
    ["url", () => SHARE_URL],
    ["embed url", () => `https://site.example/embed/${SHARE_ID}/?x=1`],
  ] as const) {
    test(`of a ${name} reads the exact version its slot shows now, on the day it read`, async () => {
      const { transport, seen } = make(
        await shareRead(),
        await slotCard(datasetFrame()),
        ...(await storedVersion()),
      );
      const before = dayText(today());
      const data = await fetchDataset(transport, await target(), { slot: 2 });
      const after = dayText(today());

      assert.deepEqual(calls(seen), [
        READ,
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

  test("of a version listing no frame file reads the one the file selector renders", async () => {
    const { transport, seen } = make(
      await shareRead(),
      await slotCard(datasetFrame()),
      json(await longOnlyManifest()),
      parquet(await scenarioBytes("fetch-spec-frame-layout.parquet")),
      json(await storedManifest()),
      await resubmitted(POSTED_ID),
    );
    const data = await fetchDataset(transport, await threeSlots(), { slot: 2 });

    const stored = `GET ${BASE}/datasets/${POSTED_ID}/${VERSION}`;
    assert.deepEqual(calls(seen), [
      READ,
      `GET ${SHARES}/${SHARE_ID}/slots/2`,
      stored,
      `${stored}/file?format=parquet&bundle=false&layout=frame`,
      stored,
      `POST ${BASE}/search/resolve`,
    ]);
    const [member] = data.ref.members;
    assert.ok(member !== undefined && !isDerived(member));
    assert.deepEqual(
      [member.digest, member.rendering],
      [
        FRAME_DIGEST,
        { format: "parquet", bundle: false, layout: "frame", without_party_totals: true },
      ],
    );
    assert.equal(data.layoutVersion, "frame");
  });

  test("refuses a selector file the manifest lists in the long layout", async () => {
    const { transport } = make(
      await shareRead(),
      await slotCard(datasetFrame()),
      json(await longOnlyManifest()),
      parquet(await scenarioBytes("fetch-spec-frame-layout.parquet")),
      json(await longOnlyManifest(FRAME_DIGEST)),
    );
    await assert.rejects(
      fetchDataset(transport, await threeSlots(), { slot: 2 }),
      (error: Error & { code?: string }) =>
        error.code === "contract_violation" && error.message.includes(FRAME_DIGEST),
    );
  });

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
        await shareRead(),
        await slotHistory(),
        answered(await reply("card-read")),
        ...(computed ? await computedVersion() : await storedVersion()),
      );
      const data = await fetchDataset(transport, await threeSlots(), { slot: 2, asOf });

      assert.deepEqual(calls(seen), [
        READ,
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
        assert.deepEqual(JSON.parse(seen[3]!.body!), { tree: shown, latest: false });
      }
      assert.ok(String(data).includes(`slot 2 "${TITLE}", on ${day}`), String(data));
    });
  }

  // Only a live share read at an earlier moment can show other data now; any other read of what
  // the slot shows now would fail the same way, so its error names no fetch.
  // `version`: the snapshot route refuses the version. `file`: it answers the manifest, the file
  // routes refuse the file, and the version does not rebuild. The Share says the opposite of the
  // share read about whether it is live, and the read decides.
  for (const [name, latest, asOf, hinted, gone] of [
    ["now", true, undefined, false, "version"],
    ["asOf on a live share", true, "2026-10-28T17:13:42.427Z", true, "version"],
    ["asOf on a snapshot", false, "2026-10-28T17:13:42.427Z", false, "version"],
    ["now, its file gone", true, undefined, false, "file"],
    ["asOf on a live share, its file gone", true, "2026-10-28T17:13:42.427Z", true, "file"],
    ["asOf on a snapshot, its file gone", false, "2026-10-28T17:13:42.427Z", false, "file"],
  ] as const) {
    test(`a slot whose dataset frame expired is unavailable, naming the newest: ${name}`, async () => {
      const newest = `cv_${"c".repeat(32)}`;
      const shown =
        asOf === undefined
          ? [await slotCard(datasetFrame())]
          : [await slotHistory(), answered(await reply("card-read"))];
      const lost =
        gone === "version"
          ? [problem({ status: 410, code: "artifact_expired" })]
          : [
              json(await storedManifest()),
              problem({ status: 410, code: "artifact_expired" }),
              problem({ status: 404, code: "not_found" }),
              problem({ status: 422, code: "definition_not_reproducible" }),
            ];
      const { transport, seen } = make(
        await shareRead({ live: latest }),
        ...shown,
        ...lost,
        json({
          spec_id: POSTED_ID,
          versions: [{ content_version: newest, base_content_version: null, rendering: "plain" }],
          next_cursor: null,
          complete: true,
        }),
      );
      const share = await sharedWith({ latest: !latest });
      const error = await fetchDataset(transport, share, { slot: 2, asOf }).then(
        () => assert.fail("the fetch read an expired frame"),
        (caught: unknown) => caught as Error & { code: string; newestVersion: string },
      );
      assert.equal(error.name, "VersionUnavailableError");
      assert.deepEqual([error.code, error.newestVersion], ["artifact_expired", newest]);
      assert.equal(/client\.fetch\(share, \{ slot: 2 \}\)/.test(error.message), hinted);
      assert.equal(error.message.includes("cannot show slot 2"), !hinted);
      assert.ok(!error.message.includes("latest: true"), error.message);
      assert.equal(calls(seen).at(-1), `GET ${BASE}/datasets/${POSTED_ID}/versions?limit=100`);
    });
  }

  test("asOf before the slot first served is refused, naming history", async () => {
    const { transport, seen } = make(await shareRead(), await slotHistory());
    await assert.rejects(
      fetchDataset(transport, await threeSlots(), { slot: 2, asOf: "2026-10-27" }),
      (error: Error & { code?: string }) =>
        error.code === "invalid_argument" && error.message.includes("client.history(share)"),
    );
    assert.deepEqual(calls(seen), [READ, `GET ${SHARES}/${SHARE_ID}/history`]);
  });

  for (const [name, asOf, computed, shuffled] of [
    ["before it was emptied reads the first frame", "2026-10-28", false, false],
    ["after it was refilled reads the later frame", "2026-10-30", true, false],
    [
      "before it was emptied reads the first frame from a shuffled history",
      "2026-10-28",
      false,
      true,
    ],
    [
      "after it was refilled reads the later frame from a shuffled history",
      "2026-10-30",
      true,
      true,
    ],
  ] as const) {
    test(`asOf ${name} of an emptied slot`, async () => {
      const { transport, seen } = make(
        await shareRead(),
        await emptiedHistory(shuffled),
        answered(await reply("card-read")),
        ...(computed ? await computedVersion() : await storedVersion()),
      );
      const data = await fetchDataset(transport, await threeSlots(), { slot: 2, asOf });

      assert.deepEqual(calls(seen), [
        READ,
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

  for (const shuffled of [false, true]) {
    test(`asOf while a slot showed no card is not found, naming the slot${shuffled ? " (shuffled history)" : ""}`, async () => {
      const { transport, seen } = make(await shareRead(), await emptiedHistory(shuffled));
      await assert.rejects(
        fetchDataset(transport, await threeSlots(), { slot: 2, asOf: "2026-10-29" }),
        (error: Error & { code?: string }) =>
          error.name === "NotFoundError" &&
          error.code === "not_found" &&
          error.message.includes("Slot 2") &&
          error.message.includes("no card"),
      );
      assert.deepEqual(calls(seen), [READ, `GET ${SHARES}/${SHARE_ID}/history`]);
    });
  }

  for (const [name, target, slot] of [
    ["a Share given no slot", threeSlots, undefined],
    ["a Share given slot 4", threeSlots, 4],
    [
      "a Share of six slots given slot 4",
      async () =>
        sharedWith({ dataUrls: (await threeSlots()).dataUrls.flatMap((url) => [url, url]) }),
      4,
    ],
    ["a URL given no slot", () => SHARE_URL, undefined],
    ["a URL given slot 4", () => SHARE_URL, 4],
  ] as const) {
    test(`of ${name} is refused with its numbering`, async () => {
      const shared = await target();
      const { transport, seen } = make(await shareRead());
      await assert.rejects(
        fetchDataset(transport, shared, slot === undefined ? {} : { slot }),
        (error: Error & { code?: string }) =>
          error.code === "invalid_argument" && error.message.includes("slot: 1 to slot: 3"),
      );
      assert.deepEqual(calls(seen), [READ]);
    });
  }

  test("of a Share reads a slot a replace added since it was returned", async () => {
    const held = await sharedWith({ dataUrls: (await threeSlots()).dataUrls.slice(0, 2) });
    const { transport, seen } = make(
      await shareRead(),
      await slotCard(datasetFrame()),
      ...(await storedVersion()),
    );
    const data = await fetchDataset(transport, held, { slot: 3 });
    assert.deepEqual(calls(seen).slice(0, 2), [READ, `GET ${SHARES}/${SHARE_ID}/slots/3`]);
    assert.equal(data.ref.members[0]?.contentVersion, VERSION);
  });

  // Search words the sentence once the data is read; when it cannot, the dataset reads as the
  // card's title.
  for (const [name, sentence] of [
    ["answers another spec", () => resubmitted(`spec_${"9".repeat(32)}`)],
    ["refuses", () => Promise.resolve(problem({ status: 400, code: "request_invalid" }))],
    [
      "is down",
      () =>
        Promise.resolve(() => {
          throw new TypeError("fetch failed");
        }),
    ],
  ] as const) {
    test(`reads its version whatever Search says: Search ${name}`, async () => {
      const failing = await sentence();
      const { transport, seen } = make(
        await shareRead(),
        await slotCard(datasetFrame()),
        ...(await storedVersion(failing)),
        failing,
        failing,
        failing,
      );
      const data = await fetchDataset(transport, await threeSlots(), { slot: 2 });
      assert.deepEqual(calls(seen).slice(0, 5), [
        READ,
        `GET ${SHARES}/${SHARE_ID}/slots/2`,
        ...storedVersionCalls,
      ]);
      const [member] = data.ref.members;
      assert.deepEqual([member?.contentVersion, member?.sentence], [VERSION, TITLE]);
      assert.ok(String(data).startsWith(`<Dataset ${TITLE}\n`), String(data));
    });
  }

  test("asOf finds the entry on a later history page", async () => {
    // The newer entry sits on page one, past the moment; the entry at the moment is the only
    // one on page two.
    const { transport, seen } = make(
      await shareRead(),
      ...(await pagedHistory(1, 2)),
      answered(await reply("card-read")),
      ...(await storedVersion()),
    );
    const data = await fetchDataset(transport, await threeSlots(), {
      slot: 2,
      asOf: "2026-10-28T17:13:42.427Z",
    });

    assert.deepEqual(calls(seen), [
      READ,
      `GET ${SHARES}/${SHARE_ID}/history`,
      `GET ${SHARES}/${SHARE_ID}/history?before=cursor-1`,
      `GET ${BASE}/presentation/components/${SLOT_2_CARD}?revision=1`,
      ...storedVersionCalls,
    ]);
    assert.equal(data.ref.members[0]?.contentVersion, VERSION);
  });

  test("asOf stops paging after the page that settles it", async () => {
    const [firstPage] = await pagedHistory(1, 2);
    const { transport, seen } = make(
      await shareRead(),
      firstPage!,
      answered(await reply("card-read")),
      ...(await computedVersion()),
    );
    const data = await fetchDataset(transport, await threeSlots(), {
      slot: 2,
      asOf: "2026-10-28",
    });

    assert.deepEqual(calls(seen).slice(0, 3), [
      READ,
      `GET ${SHARES}/${SHARE_ID}/history`,
      `GET ${BASE}/presentation/components/${SLOT_2_CARD}?revision=1`,
    ]);
    assert.equal(data.ref.members[0]?.contentVersion, (await computedFrame()).content_version);
  });

  test("asOf takes the entry the history lists first of one millisecond", async () => {
    // A replace empties slot 2 and a later one fills it again within one millisecond; the
    // history lists the filled entry first.
    const recorded = await reply("share-three-emptied-history");
    const [later, empty, , first] = recorded.body["served"] as Record<string, unknown>[];
    later!["frame"] = await computedFrame();
    first!["frame"] = datasetFrame();
    later!["first_served_at"] = "2026-10-29T10:00:00.100900+00:00";
    empty!["first_served_at"] = "2026-10-29T10:00:00.100400+00:00";
    const { transport } = make(
      await shareRead(),
      answered(recorded),
      answered(await reply("card-read")),
      ...(await computedVersion()),
    );
    const data = await fetchDataset(transport, await threeSlots(), {
      slot: 2,
      asOf: "2026-10-29T10:00:00.100Z",
    });
    assert.equal(data.ref.members[0]?.contentVersion, (await computedFrame()).content_version);
  });

  test("given an empty entities or facets reads the share, as a spec or a ref does", async () => {
    const { transport, seen } = make(await shareRead());
    await assert.rejects(
      fetchDataset(transport, await threeSlots(), { slot: 4, entities: {}, facets: {} }),
      (error: Error & { code?: string }) => error.message.includes("slot: 1 to slot: 3"),
    );
    assert.deepEqual(calls(seen), [READ]);
  });

  // The share read after the contract's `live-replace-with-fewer-cards` replacement: slot 1
  // holds a card, slots 2 and 3 are listed with `card: null` and keep their URLs.
  for (const [name, target] of [
    ["share", threeSlots],
    ["url", () => SHARE_URL],
  ] as const) {
    test(`of a ${name} whose slot a replacement left empty is not found, naming the slot`, async () => {
      const { transport, seen } = make(
        answered(await reply("share-emptied-read")),
        answered(await reply("share-slot-empty")),
      );
      await assert.rejects(
        fetchDataset(transport, await target(), { slot: 2 }),
        (error: Error & { code?: string }) =>
          error.name === "NotFoundError" &&
          error.code === "not_found" &&
          error.message.includes("slot 2"),
      );
      assert.deepEqual(calls(seen), [READ, `GET ${SHARES}/${SHARE_ID}/slots/2`]);
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
    ["facets", { facets: { unit: null } }],
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
    const { transport, seen } = make(
      await shareRead({ slots: 1 }),
      answered(await reply("share-note-slot-card")),
    );
    await assert.rejects(fetchDataset(transport, one), {
      name: "InvalidRequestError",
      code: "invalid_argument",
    });
    assert.deepEqual(calls(seen), [READ, `GET ${SHARES}/${SHARE_ID}/slots/1`]);
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
