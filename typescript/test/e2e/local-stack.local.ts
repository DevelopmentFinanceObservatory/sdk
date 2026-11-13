// The dashboard journey against the dfo-apis local stack at `DFO_BASE_URL`, shorter than the
// Python one where that one covers the server's behaviour, plus the ref crossing between the
// two languages. `pnpm test:e2e:local` brings the stack up, seeds it, runs this journey and
// brings the stack down (`DFO_APIS_DIR` names the dfo-apis checkout);
// `scripts/local-stack-journeys.sh both` in the repository root runs the Python journey first and
// the Python crossing back after. With the stack up and seeded:
//
//   DFO_BASE_URL=http://127.0.0.1:58083/api DFO_E2E_DIR=<dir> node --test test/e2e/local-stack.local.ts
//
// `DFO_E2E_DIR` names a directory both journeys share: this one reads `derived-python.json`,
// which the Python journey writes, and writes `derived-typescript.json`. Without it, or before
// the Python journey has run, the crossing steps skip.
//
// The local stack has no Search, so each seeded spec carries its sentence, and its download
// links point at the storage emulator, which the client refuses as a host other than the API
// and Google Cloud Storage. `shim` moves those links onto the API's origin and forwards them to
// the emulator, and records every request. One step reads ODA summed by recipient, as a data-mcp
// breakdown reads it, and checks the root's groupby survives the ref, a card and a share.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";

import { InvalidRequestError, NotFoundError, PermissionDeniedError } from "../../src/errors.ts";
import { Client, DatasetRef, recipe } from "../../src/index.ts";
import type { Dataset, Spec } from "../../src/index.ts";
import { isDerived } from "../../src/types.ts";
import type { Card, ResolvedSpec, Row, Share } from "../../src/types.ts";

const baseUrl = process.env["DFO_BASE_URL"];
if (baseUrl === undefined || baseUrl === "") {
  throw new Error("Set DFO_BASE_URL to the local stack's API, http://127.0.0.1:58083/api.");
}
const e2eDir = process.env["DFO_E2E_DIR"];
const apiOrigin = new URL(baseUrl).origin;

const ODA = {
  specId: "spec_7f535e528a2a527aa54b316d4eccbb6e",
  contentVersion: "cv_46e66114368dacdffa282c61ee456e0f",
  sentence: "ODA from Germany to Kenya, Ghana and Nigeria, 2018 to 2023",
};
const POPULATION = {
  specId: "spec_429926a07022f78c65e0379e8004ae6d",
  contentVersion: "cv_3f610869372f93965119e3c0221847f6",
  sentence: "Kenya population, 2015 to 2024",
};
// The codes a server without the seed answers a seeded reading with.
const NOT_FOUND_CODES: ReadonlySet<string | null> = new Set([
  "spec_not_found",
  "snapshot_not_found",
]);
const PAIRING = { destination: "place" };
// A breakdown by recipient, the sum data-mcp's `get_data` reads a frame with.
const BREAKDOWN = { by: ["time_period", "financingRecipient"], op: "sum" };
// The breakdown as a ref names it: dfo-apis sorts `by`.
const SORTED_BREAKDOWN = { by: ["financingRecipient", "time_period"], op: "sum" };
const ROW_COLUMNS = ["time_period", "financingRecipient", "value"] as const;
const WRONG_TOKEN = `shw_${"0".repeat(22)}`;
// Where `shim` moves a download link that points off the API's origin.
const MOVED = "/__moved__";

/** Every request the client sent: method, path and JSON body. */
const sent: { method: string; path: string; body: unknown }[] = [];
let movedOrigin: string | undefined;

/** The platform's fetch, recording each request and moving emulator links onto the API. */
const shim: typeof fetch = async (input, init) => {
  let url = new URL(input instanceof Request ? input.url : input);
  if (url.pathname.startsWith(MOVED)) {
    assert.ok(movedOrigin, "a moved link arrived before any redirect");
    url = new URL(movedOrigin + url.href.slice(apiOrigin.length + MOVED.length));
  }
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null;
  sent.push({ method: init?.method ?? "GET", path: url.pathname, body });
  const response = await fetch(url, init);
  const location = response.headers.get("location");
  if (location === null || location.startsWith(apiOrigin)) return response;
  movedOrigin = new URL(location).origin;
  const headers = new Headers(response.headers);
  headers.set("location", apiOrigin + MOVED + location.slice(movedOrigin.length));
  return new Response(response.body, { status: response.status, headers });
};

// A direct call names its caller from the rightmost X-Forwarded-For entry, which Cloud Run
// appends in production.
const client = new Client({
  baseUrl,
  apiKey: false,
  fetch: shim,
  headers: { "X-Forwarded-For": "127.0.0.1" },
  onWarning: () => {},
});

async function seeded(reading: typeof ODA): Promise<Dataset> {
  const path = `/datasets/${reading.specId}/${reading.contentVersion}`;
  const { definition } = (await client.request("GET", path)).json() as Spec;
  // The stack has no Search, so the spec carries the sentence Search would give it.
  const resolved = { rendered_sentence: reading.sentence } as ResolvedSpec;
  const data = await client.fetch({ spec_id: reading.specId, definition, resolved });
  const [member] = data.members;
  assert.deepEqual(
    [member?.spec.spec_id, member?.contentVersion],
    [reading.specId, reading.contentVersion],
  );
  return data;
}

const rowsOf = async (data: Dataset): Promise<Row[]> =>
  (await data.toRows()).map((row) =>
    Object.fromEntries(ROW_COLUMNS.map((key) => [key, row[key] ?? null])),
  );

const derivedOf = (data: Dataset): [string, string] => {
  const [member] = data.ref.members;
  assert.ok(member);
  return [member.spec.spec_id, member.contentVersion];
};

/** A card payload without what differs between two creates of one intent. */
const withoutIds = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutIds);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "component_id" && key !== "generated_at")
      .map(([key, item]) => [key, withoutIds(item)]),
  );
};

const payloadOf = async (card: Card): Promise<unknown> =>
  (
    (await client.request("GET", `/presentation/components/${card.id}`)).json() as {
      resolved_payload: unknown;
    }
  ).resolved_payload;

type FromPython = {
  ref: unknown;
  rows: Row[];
  join_ref: unknown;
  join_card: unknown;
};

/** What the Python journey wrote, or the reason a crossing step skips. */
async function fromPython(): Promise<FromPython | string> {
  if (e2eDir === undefined) return "DFO_E2E_DIR is unset";
  const path = join(e2eDir, "derived-python.json");
  try {
    return JSON.parse(await readFile(path, "utf8")) as FromPython;
  } catch {
    return `${path} is absent; the Python journey writes it`;
  }
}

// Stops the file once, before any step is registered, when the server lacks the seed. Only the
// not-found codes count as missing, and any other error propagates as itself.
await (async () => {
  const missing: string[] = [];
  for (const { specId, contentVersion } of [ODA, POPULATION]) {
    try {
      await client.request("GET", `/datasets/${specId}/${contentVersion}`);
    } catch (error) {
      if (!(error instanceof NotFoundError) || !NOT_FOUND_CODES.has(error.code)) throw error;
      missing.push(`${specId} at ${contentVersion}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `The server lacks the local-stack seed; missing readings: ${missing.join(", ")}. ` +
        "Run `just local-stack seed` in dfo-apis.",
    );
  }
})();

// State the later steps read from the earlier ones.
let quotient: Dataset;
let chained: Dataset;
let cards: [Card, Card];
let share: Share;

describe(`the local-stack journey against ${baseUrl}`, { concurrency: false }, () => {
  test("quotientOf and a two-step recipe answer the same rows", async () => {
    const oda = await seeded(ODA);
    const population = await seeded(POPULATION);
    quotient = await client.analysis.quotientOf(oda, population, { on: PAIRING });
    const ref = quotient.ref.toJSON() as { format_version: number };
    assert.equal(ref.format_version, 2);
    const [specId, contentVersion] = derivedOf(quotient);
    assert.match(specId, /^ops_/);
    assert.match(contentVersion, /^ocv_/);
    assert.equal(quotient.rowCount, 6);
    assert.equal(quotient.leftOut.length, 3);
    assert.ok(DatasetRef.fromJSON(quotient.ref.toJSON()).equals(quotient.ref));
    const lines = String(quotient).split("\n");
    assert.equal(lines[0], "<Dataset Computed by DFO: quotient_of.");
    assert.ok(lines.includes("  Derived: quotient_of by destination, from 2 readings"));

    const file = await client.request("GET", `/datasets/derived/${specId}/${contentVersion}/file`, {
      params: { format: "parquet", bundle: "false", layout: "frame" },
    });
    const digest = `sha256:${createHash("sha256").update(file.body).digest("hex")}`;
    assert.equal(digest, quotient.members[0]?.digest);

    chained = await client.fetch(
      recipe(oda)
        .filter({ keep: { destination: "country/KEN" } })
        .quotientOf(population, { on: PAIRING }),
    );
    assert.notDeepEqual(derivedOf(chained), derivedOf(quotient));
    assert.deepEqual(await rowsOf(chained), await rowsOf(quotient));
    assert.ok(chained.ref.sameData(quotient.ref));

    const latest = await client.fetch(quotient.ref, { latest: true });
    assert.deepEqual(derivedOf(latest), derivedOf(quotient));
  });

  test("cards, a live share, a wrong token and unshare", async () => {
    cards = [
      await client.cards.line(quotient, { title: "Aid per person" }),
      await client.cards.stat(quotient, { year: 2023, compareTo: 2018, change: "percent" }),
    ];
    assert.deepEqual(
      cards.map((card) => card.kind),
      ["line", "stat"],
    );
    assert.ok(cards.every((card) => card.ref.equals(quotient.ref)));

    share = await client.share(cards, { latest: true });
    const site = share.url.slice(0, -`/s/${share.id}`.length);
    assert.equal(share.embedUrl, `${site}/embed/${share.id}`);
    assert.deepEqual(
      share.dataUrls,
      [1, 2].map((slot) => `${site}/api/v1/presentation/shares/${share.id}/slots/${slot}/data`),
    );
    assert.match(share.writeToken ?? "", /^shw_/);

    const shown = await client.fetch(share, { slot: 1 });
    assert.deepEqual(await rowsOf(shown), await rowsOf(quotient));

    const replaced = await client.share([cards[1], cards[0]], { latest: true, replace: share });
    assert.deepEqual([replaced.id, replaced.revision], [share.id, 2]);
    const refused = await client
      .share(cards[0], { latest: true, replace: share.url, writeToken: WRONG_TOKEN })
      .then(
        () => assert.fail("a wrong token was accepted"),
        (error: unknown) => error,
      );
    assert.ok(refused instanceof PermissionDeniedError);
    assert.equal(refused.code, "write_token_invalid");

    const today = new Date().toISOString().slice(0, 10);
    const then = await client.fetch(share, { slot: 1, asOf: today });
    assert.deepEqual(await rowsOf(then), await rowsOf(quotient));
    const served = await client.history(share);
    assert.ok(served.some((entry) => entry.slot === 1));

    await client.unshare(share);
    const gone = await client.fetch(share, { slot: 1 }).then(
      () => assert.fail("an unshared share answered"),
      (error: unknown) => error,
    );
    assert.ok(gone instanceof NotFoundError);
    assert.equal(gone.code, "not_found");
  });

  test("pin refuses a derived frame before any request", async () => {
    // pin(undefined) is refused unsent too, so without the frame this test would prove nothing.
    // `quotient` is unset when the quotientOf step failed, whatever its declared type says.
    assert.ok(
      (quotient as Dataset | undefined) !== undefined,
      "no derived frame: the quotientOf step did not finish",
    );
    assert.match(derivedOf(quotient)[0], /^ops_/);
    const before = sent.length;
    const refused = await client.pin(quotient).then(
      () => assert.fail("a derived frame was pinned"),
      (error: unknown) => error,
    );
    assert.ok(refused instanceof InvalidRequestError);
    assert.equal(refused.code, "invalid_argument");
    assert.equal(sent.length, before);
  });

  test("a ref the Python journey wrote reads the same rows and data", async (t) => {
    const written = await fromPython();
    if (typeof written === "string") {
      t.skip(written);
      return;
    }
    const ref = DatasetRef.fromJSON(written.ref);
    const data = await client.fetch(ref);
    assert.ok(ref.sameData(quotient.ref));
    assert.deepEqual(await rowsOf(data), written.rows);
    assert.deepEqual(await rowsOf(data), await rowsOf(quotient));
  });

  test("a card of the frame the Python journey drew resolves to its payload", async (t) => {
    const written = await fromPython();
    if (typeof written === "string") {
      t.skip(written);
      return;
    }
    const joined = await client.fetch(DatasetRef.fromJSON(written.join_ref));
    const card = await client.cards.table(joined, { title: "Kenya" });
    assert.deepEqual(withoutIds(await payloadOf(card)), written.join_card);
  });

  // The client has no call that sums a root, so the step posts the tree data-mcp posts.
  test("a root read summed keeps its groupby through the ref, a card and a share", async () => {
    const root = {
      spec_id: ODA.specId,
      content_version: ODA.contentVersion,
      rendering: { columns: [], groupby: BREAKDOWN },
    };
    const keep = { kind: "category_match", column: "destination", values: ["country/KEN"] };
    const tree = { verb: "filter", arguments: { predicates: [keep] }, inputs: { data: root } };
    const ready = (
      await client.request("POST", "/datasets/analysis", { json: { tree } })
    ).json() as { ref: unknown };
    const ref = DatasetRef.fromJSON(ready.ref);
    assert.deepEqual(ref.toJSON(), ready.ref);
    const groupbyOf = (data: Dataset) => {
      const [member] = data.ref.members;
      assert.ok(member && isDerived(member));
      return member.roots[0]?.groupby;
    };

    const data = await client.fetch(ref);
    assert.deepEqual(groupbyOf(data), SORTED_BREAKDOWN);
    const card = await client.cards.line(data, { title: "ODA to Kenya" });
    assert.ok(card.ref.equals(data.ref));
    const grouped = await client.share(card, { latest: false });
    try {
      const shown = await client.fetch(grouped, { slot: 1 });
      assert.deepEqual(groupbyOf(shown), SORTED_BREAKDOWN);
      assert.ok(shown.ref.sameData(data.ref));
      assert.deepEqual(await rowsOf(shown), await rowsOf(data));
    } finally {
      await client.unshare(grouped);
    }
  });

  test("writes the two-step recipe's ref for the Python journey", async (t) => {
    if (e2eDir === undefined) {
      t.skip("DFO_E2E_DIR is unset");
      return;
    }
    const written = { ref: chained.ref.toJSON(), rows: await rowsOf(chained) };
    await writeFile(join(e2eDir, "derived-typescript.json"), JSON.stringify(written));
  });
});
