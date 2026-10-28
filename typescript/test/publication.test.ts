// Cards and shares: storing a card DFO draws, publishing cards as a link, replacing, fixing and
// taking it down, and reading what it served. The replies are the ones
// python/tests/_async/datasets/test_publication.py replays, recorded from dfo-apis' components
// and shares doors over their test doubles.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { inspect } from "node:util";

import { clientOver } from "../src/client.ts";
import { envFrom } from "../src/config/env.ts";
import { latestYear } from "../src/core/periods.ts";
import { DatasetRef, isDerived } from "../src/core/ref.ts";
import type { Spec } from "../src/core/ref.ts";
import { Cards, statIntent } from "../src/datasets/cards.ts";
import type { StatOptions } from "../src/datasets/cards.ts";
import { Dataset } from "../src/datasets/dataset.ts";
import { derivedDataset } from "../src/datasets/derived.ts";
import { Card, Share, shareIdOf } from "../src/datasets/publication.ts";
import { recipe } from "../src/datasets/recipe.ts";
import { history, share, snapshot, unshare } from "../src/datasets/shares.ts";
import { Transport } from "../src/http/transport.ts";
import { scenarioBytes } from "./replay.ts";
import { json, mockFetch, problem, recordedBytes, recordedJson } from "./support.ts";
import type { Seen } from "./support.ts";

const BASE = "https://api.example/api";
const SHARES = `${BASE}/presentation/shares`;
const SHARE_ID = "lBm1RKBw";
const SHARE_URL = `https://site.example/s/${SHARE_ID}`;
const TOKEN = "shw_iGYq8-qYahz4BaNQ1NC1Dg";
const CARD_ID = "cmp_ad956b407b1623ec17cfcd55";
const SHOWN = { component_id: CARD_ID, revision: 1 };

type Handler = Parameters<typeof mockFetch>[number];
type Recorded = { status: number; headers: Record<string, string>; body: unknown };

/** A transport over `handlers` whose sleeps return at once. */
function make(...handlers: Handler[]) {
  const { fetch, seen } = mockFetch(...handlers);
  const transport = new Transport({
    baseUrl: BASE,
    apiKey: false,
    env: envFrom({}),
    readCredentialsFile: () => null,
    fetch,
    sleep: () => Promise.resolve(),
  });
  return { transport, seen };
}

/** A recorded reply as the handler that answers it. */
async function recorded(name: string): Promise<Handler> {
  const { status, headers, body } = await recordedJson<Recorded>(`${name}.json`);
  if (body === null) return () => new Response(null, { status, headers });
  return json(body, status, headers);
}

const calls = (seen: readonly Seen[]): string[] =>
  seen.map(({ method, url }) => `${method} ${url}`);
const bodyOf = (seen: readonly Seen[], index: number): Record<string, unknown> =>
  JSON.parse(seen[index]!.body!) as Record<string, unknown>;

const digestOf = (data: Uint8Array): string =>
  `sha256:${createHash("sha256").update(data).digest("hex")}`;

async function dataset(): Promise<Dataset> {
  const data = await scenarioBytes("fetch-spec-known-sentence.parquet");
  return Dataset.create(
    [
      {
        parts: [],
        spec: { spec_id: `spec_${"9f2e".repeat(8)}`, definition: {} },
        sentence: "Malaria grants to Ethiopia.",
        contentVersion: `cv_${"f4a8".repeat(8)}`,
        manifest: {},
        digest: digestOf(data),
        rendering: { format: "parquet", bundle: false },
        data,
      },
    ],
    { layout: "long" },
  );
}

async function derived(): Promise<Dataset> {
  const { ref } = await recordedJson<{ ref: unknown }>("analysis-rank-ready.json");
  const [member] = DatasetRef.fromJSON(ref).members;
  assert.ok(member && isDerived(member));
  const { dataset: built } = await derivedDataset(
    member,
    await recordedJson("analysis-rank-manifest.json"),
    await recordedBytes("analysis-rank-frame.parquet"),
  );
  return built;
}

async function variables(data: Dataset): Promise<string[]> {
  const rows = await data.toRows();
  return [...new Set(rows.map((row) => row["stat_var"]))].filter((v) => typeof v === "string");
}

function frameOf(data: Dataset): { spec_id: string; content_version: string } {
  const [member] = data.members;
  return { spec_id: member!.spec.spec_id, content_version: member!.contentVersion };
}

async function card(): Promise<Card> {
  const ref = (await dataset()).ref;
  return new Card({
    id: CARD_ID,
    revision: 1,
    kind: "line",
    ref,
    title: null,
    heldUntil: null,
    pinned: false,
    writeToken: "cmw_AAAAAAAAAAAAAAAAAAAAAA",
  });
}

async function heldShare(): Promise<Share> {
  type Created = {
    id: string;
    url: string;
    embed_url: string;
    data_urls: string[];
    revision: number;
    latest: boolean;
    write_token: string;
  };
  const { body } = await recordedJson<{ body: Created }>("share-created.json");
  return new Share({
    id: body.id,
    url: body.url,
    embedUrl: body.embed_url,
    dataUrls: body.data_urls,
    revision: body.revision,
    latest: body.latest,
    writeToken: body.write_token,
  });
}

describe("a card", () => {
  for (const [name, build] of [
    ["dataset", dataset],
    ["derived", derived],
  ] as const) {
    test(`of a ${name} draws every variable of its version`, async () => {
      const data = await build();
      const { transport, seen } = make(await recorded("card-line-created"));
      const made = await new Cards(transport).line(data, {
        window: [latestYear(-9), latestYear()],
        title: "Malaria grants to Ethiopia",
      });

      assert.deepEqual(calls(seen), [`POST ${BASE}/presentation/components`]);
      const sent = bodyOf(seen, 0);
      const held = await variables(data);
      assert.deepEqual(sent["intent"], {
        type: "line_chart",
        frame_ref: frameOf(data),
        select: { stat_var: held.length === 1 ? held[0] : held },
        window: {
          start: { anchor: "latest", offset: -9 },
          end: { anchor: "latest", offset: 0 },
        },
        title: "Malaria grants to Ethiopia",
      });
      assert.match(String(sent["write_token"]), /^cmw_[A-Za-z0-9_-]{22}$/);
      assert.deepEqual(
        [made.id, made.revision, made.kind, made.title],
        [CARD_ID, 1, "line", "Malaria grants to Ethiopia"],
      );
      assert.ok(made.ref.equals(data.ref));
      assert.equal(made.writeToken, "cmw_AAAAAAAAAAAAAAAAAAAAAA");
      for (const shown of [String(made), inspect(made), JSON.stringify(made)]) {
        assert.ok(!shown.includes(made.writeToken), shown);
      }
    });
  }

  test("of a ref reads the frame's variables first", async () => {
    const ref = (await dataset()).ref;
    const frame = frameOf(await dataset());
    const { transport, seen } = make(
      await recorded("card-frame-variables"),
      await recorded("card-stat-created"),
    );
    const made = await new Cards(transport).stat(ref, {
      year: latestYear(),
      compareTo: latestYear(-1),
    });

    const path = `${BASE}/presentation/frames/${frame.spec_id}/${frame.content_version}`;
    assert.deepEqual(calls(seen), [
      `GET ${path}?dimension=stat_var`,
      `POST ${BASE}/presentation/components`,
    ]);
    const intent = bodyOf(seen, 1)["intent"] as Record<string, unknown>;
    assert.deepEqual(intent["select"], { stat_var: "dcid:MalariaGrantDisbursements" });
    assert.equal(made.kind, "stat");
    assert.ok(made.ref.equals(ref));
  });

  test("of a source sends its frame alone", async () => {
    const data = await dataset();
    const { transport, seen } = make(await recorded("card-line-created"));
    const made = await new Cards(transport).source(data.ref);
    assert.deepEqual(bodyOf(seen, 0)["intent"], {
      type: "source_card",
      frame_ref: frameOf(data),
    });
    assert.equal(made.kind, "source");
  });

  for (const [name, retention, held, pinned] of [
    ["held", { pinned: false, held_until: "2026-11-27T09:00:00+00:00" }, "2026-11-27", false],
    ["pinned", { pinned: true }, null, true],
    ["unrecorded", null, null, false],
  ] as const) {
    test(`carries how long its version is held from the reply (${name})`, async () => {
      const { body } = await recordedJson<Recorded>("card-line-created.json");
      const { transport } = make(json({ ...(body as object), retention }, 201));
      const made = await new Cards(transport).source((await dataset()).ref);
      assert.deepEqual(
        [made.heldUntil?.toISOString() ?? null, made.pinned],
        [held === null ? null : `${held}T00:00:00.000Z`, pinned],
      );
    });
  }

  test("carries the retention a recorded held reply states", async () => {
    const { transport } = make(await recorded("card-created-held"));
    const made = await new Cards(transport).line(await dataset());
    assert.deepEqual(
      [made.heldUntil?.toISOString(), made.pinned],
      ["2026-11-27T00:00:00.000Z", false],
    );
  });

  test("whose reply states a malformed retention raises ContractError", async () => {
    const { body } = await recordedJson<Recorded>("card-line-created.json");
    const { transport } = make(json({ ...(body as object), retention: { held_until: "x" } }, 201));
    await assert.rejects(new Cards(transport).source((await dataset()).ref), {
      name: "ContractError",
      code: "contract_violation",
      pointer: "/retention/pinned",
    });
  });

  test("of anything but one version with rows is refused unsent", async () => {
    const spec: Spec = { spec_id: `spec_${"a".repeat(32)}`, definition: {} };
    const one = await dataset();
    const several = new DatasetRef([one.ref.members[0]!, one.ref.members[0]!]);
    const loose = (value: unknown): never => value as never;
    for (const data of [spec, recipe(spec).rank({ by: "origin" }), spec.spec_id, several]) {
      const { transport, seen } = make();
      await assert.rejects(new Cards(transport).line(loose(data)), {
        name: "InvalidRequestError",
        code: "invalid_argument",
      });
      assert.equal(seen.length, 0);
    }
  });
});

describe("a stat card", () => {
  const LATEST = { anchor: "latest", offset: 0 };
  const BEFORE = { anchor: "latest", offset: -1 };
  for (const [name, options, intent] of [
    ["newest", {}, {}],
    ["year", { year: 2020 }, { window: { start: "2020", end: "2020" } }],
    [
      "change",
      { year: latestYear(), compareTo: latestYear(-1) },
      { window: { start: BEFORE, end: LATEST }, change: { basis: [BEFORE, LATEST] } },
    ],
    [
      "percent",
      { year: latestYear(), compareTo: 2015, change: "percent", title: "Aid to Kenya" },
      {
        title: "Aid to Kenya",
        window: { start: "2015", end: LATEST },
        change: { basis: ["2015", LATEST], derivation: "percent_change" },
      },
    ],
  ] as const) {
    test(`shows its year and counts its change from compareTo (${name})`, () => {
      assert.deepEqual(statIntent(options as StatOptions), intent);
    });
  }

  for (const [name, options] of [
    ["compare without year", { compareTo: latestYear(-1) }],
    ["change without compare", { year: latestYear(), change: "percent" }],
    ["unknown change", { year: latestYear(), compareTo: 2015, change: "ratio" }],
    ["change in the old word", { year: latestYear(), compareTo: 2015, change: "percent_change" }],
    ["text year", { year: "2020" }],
    ["empty title", { title: " " }],
  ] as const) {
    test(`is refused when malformed (${name})`, () => {
      assert.throws(() => statIntent(options as unknown as StatOptions), {
        name: "InvalidRequestError",
        code: "invalid_argument",
      });
    });
  }
});

describe("a share", () => {
  test("publishes its cards with a token the client minted, and carries the token", async () => {
    const { transport, seen } = make(await recorded("share-created"));
    const made = await share(transport, [await card(), await card()], { latest: true });

    assert.deepEqual(calls(seen), [`POST ${SHARES}`]);
    const { write_token: token, ...sent } = bodyOf(seen, 0);
    assert.deepEqual(sent, { cards: [SHOWN, SHOWN], latest: true });
    assert.match(String(token), /^shw_[A-Za-z0-9_-]{22}$/);
    const held = await heldShare();
    assert.deepEqual(
      [made.id, made.url, made.embedUrl, made.dataUrls, made.revision, made.latest],
      [held.id, held.url, held.embedUrl, held.dataUrls, held.revision, held.latest],
    );
    assert.equal(made.writeToken, TOKEN);
    for (const shown of [String(made), inspect(made), JSON.stringify(made)]) {
      assert.ok(!shown.includes(TOKEN), shown);
    }
  });

  test("create is retried after a retryable failure with the same token and body", async () => {
    const { transport, seen } = make(
      problem({ status: 503, code: "service_unavailable", retryable: true }),
      await recorded("share-created"),
    );
    await share(transport, await card(), { latest: false });
    assert.equal(seen.length, 2);
    assert.equal(seen[0]!.body, seen[1]!.body);
  });

  for (const [name, target, writeToken, sent] of [
    ["share", "held", undefined, TOKEN],
    ["url", SHARE_URL, "shw_other", "shw_other"],
    ["embed url", `https://site.example/embed/${SHARE_ID}/`, "shw_other", "shw_other"],
  ] as const) {
    test(`replace gives a live share new cards with its token (${name})`, async () => {
      const { transport, seen } = make(await recorded("share-replaced"));
      const replace = target === "held" ? await heldShare() : target;
      const made = await share(transport, await card(), {
        latest: true,
        replace,
        ...(writeToken === undefined ? {} : { writeToken }),
      });

      assert.deepEqual(calls(seen), [`PUT ${SHARES}/${SHARE_ID}`]);
      assert.equal(seen[0]!.headers.get("x-dfo-write-token"), sent);
      assert.deepEqual(bodyOf(seen, 0), { cards: [SHOWN] });
      assert.deepEqual(
        [made.revision, made.dataUrls, made.writeToken],
        [2, (await heldShare()).dataUrls, sent],
      );
    });
  }

  test("is refused unsent when malformed", async () => {
    const one = await card();
    const loose = (value: unknown): never => value as never;
    for (const [name, cards, options] of [
      ["no cards", [], { latest: true }],
      ["card id", "cmp_x", { latest: true }],
      ["mixed cards", [one, "cmp_x"], { latest: true }],
      ["latest not boolean", one, { latest: "yes" }],
      ["latest missing", one, {}],
      ["replace a snapshot", one, { latest: false, replace: SHARE_URL }],
      ["token without replace", one, { latest: true, writeToken: TOKEN }],
      ["bare id", one, { latest: true, replace: SHARE_ID }],
      ["empty token", one, { latest: true, replace: SHARE_URL, writeToken: "" }],
      ["title", one, { latest: true, title: "Aid" }],
    ] as const) {
      const { transport, seen } = make();
      await assert.rejects(
        share(transport, loose(cards), loose(options)),
        { name: "InvalidRequestError", code: "invalid_argument" },
        name,
      );
      assert.equal(seen.length, 0, name);
    }
  });

  test("snapshot fixes a live share under its URLs", async () => {
    const { transport, seen } = make(await recorded("share-snapshot"));
    const fixed = await snapshot(transport, await heldShare());
    assert.deepEqual(calls(seen), [`POST ${SHARES}/${SHARE_ID}/snapshot`]);
    assert.equal(seen[0]!.headers.get("x-dfo-write-token"), TOKEN);
    assert.deepEqual([fixed.latest, fixed.url, fixed.writeToken], [false, SHARE_URL, TOKEN]);
  });

  test("unshare takes the share down with its token", async () => {
    const { transport, seen } = make(() => new Response(null, { status: 204 }));
    await unshare(transport, SHARE_URL, { writeToken: TOKEN });
    assert.deepEqual(calls(seen), [`DELETE ${SHARES}/${SHARE_ID}`]);
    assert.equal(seen[0]!.headers.get("x-dfo-write-token"), TOKEN);
  });

  test("history lists each frame served, newest first, with no token sent", async () => {
    const { transport, seen } = make(await recorded("share-history"));
    const served = await history(transport, await heldShare());

    assert.deepEqual(calls(seen), [`GET ${SHARES}/${SHARE_ID}/history`]);
    assert.equal(seen[0]!.headers.get("x-dfo-write-token"), null);
    assert.deepEqual(
      served.map((entry) => [entry.slot, entry.contentVersion, entry.pinned, entry.fetchable]),
      [
        [1, `cv_${"b".repeat(32)}`, false, true],
        [1, "cv_f4a81c22d9075e3ba61c2ee98f83b405", true, true],
      ],
    );
    assert.equal(served[0]!.heldUntil?.toISOString(), "2026-11-27T00:00:00.000Z");
    assert.equal(served[1]!.heldUntil, null);
    assert.ok(served[0]!.firstServed > served[1]!.firstServed);
  });

  for (const [reply, name, code] of [
    ["write-token-required", "InvalidRequestError", "write_token_required"],
    ["write-token-invalid", "PermissionDeniedError", "write_token_invalid"],
    ["not-replaceable", "InvalidRequestError", "share_not_replaceable"],
    ["not-found", "NotFoundError", "not_found"],
  ] as const) {
    test(`a refused change raises the class its code maps to (${code})`, async () => {
      const { transport, seen } = make(await recorded(`share-refused-${reply}`));
      await assert.rejects(share(transport, await card(), { latest: true, replace: SHARE_URL }), {
        name,
        code,
      });
      assert.equal(seen.length, 1);
    });
  }

  test("a spent allowance raises QuotaExceededError with its reset", async () => {
    const { transport, seen } = make(await recorded("share-refused-allowance-exhausted"));
    await assert.rejects(share(transport, await card(), { latest: true }), {
      name: "QuotaExceededError",
      code: "allowance_exhausted",
      retryAfterMs: 54_000_000,
    });
    assert.equal(seen.length, 1);
  });

  for (const [name, change, pointer] of [
    ["latest", { latest: "live" }, "/latest"],
    ["data urls", { data_urls: null }, "/data_urls"],
    ["revision", { revision: 0 }, "/revision"],
  ] as const) {
    test(`a reply missing a member raises ContractError (${name})`, async () => {
      const { body } = await recordedJson<Recorded>("share-created.json");
      const { transport } = make(json({ ...(body as object), ...change }, 201));
      await assert.rejects(share(transport, await card(), { latest: true }), {
        name: "ContractError",
        code: "contract_violation",
        pointer,
      });
    });
  }
});

describe("a share's URL", () => {
  for (const url of [
    "https://developmentfinance.org/s/k3Qx8vTa",
    "https://developmentfinance.org/embed/k3Qx8vTa?theme=dark",
    "http://localhost:3000/s/k3Qx8vTa/",
  ]) {
    test(`names its share (${url})`, () => {
      assert.equal(shareIdOf(url), "k3Qx8vTa");
    });
  }

  for (const target of [
    "k3Qx8vTa",
    "https://developmentfinance.org/s/k3Qx8vT",
    "https://developmentfinance.org/data/k3Qx8vTa",
    "https://developmentfinance.org/s/k3Qx8vTa/../x",
    null,
  ]) {
    test(`is refused when it names no share (${String(target)})`, () => {
      assert.throws(() => shareIdOf(target), {
        name: "InvalidRequestError",
        message: /client\.share\(cards/,
      });
    });
  }
});

test("client cards and shares run through the client's transport", async () => {
  const { ref } = await recordedJson<{ ref: unknown }>("analysis-rank-ready.json");
  const { fetch, seen } = mockFetch(
    await recorded("card-line-created"),
    await recorded("share-created"),
    await recorded("share-history"),
  );
  const client = clientOver(
    new Transport({ baseUrl: BASE, apiKey: false, env: envFrom({}), fetch }),
  );
  const made = await client.cards.source(DatasetRef.fromJSON(ref));
  const tile = await client.share(made, { latest: true });
  const served = await client.history(tile.url);
  await assert.rejects(client.share([], { latest: true }), /client\.cards\.line\(data\)/);
  assert.deepEqual(
    seen.map(({ url }) => new URL(url).pathname),
    [
      "/api/presentation/components",
      "/api/presentation/shares",
      `/api/presentation/shares/${tile.id}/history`,
    ],
  );
  assert.equal(served.length, 2);
});
