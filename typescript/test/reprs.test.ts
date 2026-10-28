import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";

import { clientOver } from "../src/client.ts";
import { DfoError, NotFoundError, serverCode } from "../src/core/errors.ts";
import { describing } from "../src/core/trace.ts";
import { DataWarning, DfoWarning, SeriesLeftOutWarning } from "../src/core/warnings.ts";
import { Dataset } from "../src/datasets/dataset.ts";
import { Card, Served, Share } from "../src/datasets/publication.ts";
import { recipe } from "../src/datasets/recipe.ts";
import { latestYear } from "../src/core/periods.ts";
import { RawResponse, Transport } from "../src/http/transport.ts";
import { Answer, answerFromBody, SearchWarning } from "../src/search/answer.ts";
import { Catalogue, Code, Match, Node } from "../src/search/lookup-results.ts";
import type { GraphNode } from "../src/search/lookup-results.ts";
import type { CatalogueResponse, EntityRef, ResolveResult } from "../src/wire.ts";
import { NO_EXCHANGES, replay, scenarioBytes, scenarios } from "./replay.ts";

const SPEC_ID = `spec_${"3f1a".repeat(8)}`;
const VERSION = `cv_${"b92d".repeat(8)}`;

const dataset = await Dataset.create(
  [
    {
      parts: [],
      spec: { spec_id: SPEC_ID, definition: {} },
      sentence: "Germany's gross ODA disbursements to Nigeria.",
      contentVersion: VERSION,
      manifest: {},
      digest: "sha256:offline",
      rendering: { format: "parquet", bundle: false },
      data: await scenarioBytes("answer-definite-fetch.parquet"),
    },
  ],
  { layout: "long" },
);

const recorded = (await scenarios()).find(({ name }) => name === "answer-definite-fetch")!;
const answer = answerFromBody(
  structuredClone(recorded.exchanges[0]!.response.json),
  { transport: replay(NO_EXCHANGES).transport },
  null,
);

const lookup = clientOver(new Transport({ baseUrl: "https://api.example", apiKey: false })).lookup;

const KENYA: EntityRef = { ref: "country/KEN", label: "Kenya", kind: "country" };
const GERMANY: EntityRef = { ref: "country/DEU", label: "Germany", kind: "country" };

/** A resolver result for `input`, with the members its status uses. */
const result = (input: string, members: Partial<ResolveResult>): ResolveResult => ({
  input,
  status: "resolved",
  entity: null,
  matched: null,
  reading: null,
  projection: null,
  member_count: null,
  members: null,
  candidates: null,
  near_matches: null,
  ...members,
});

const georgias = ["country/GEO", "geoId/13", "geoId/13a", "geoId/13b"].map(
  (ref, index): EntityRef => ({
    ref,
    label: "Georgia",
    kind: index === 0 ? "country" : "place_other",
  }),
);

const kenyaNode = (label: string): GraphNode => ({
  ref: "country/KEN",
  label,
  types: ["Country"],
  description: null,
  links: {},
  gaps: [],
  built_from: {},
  kind: "country",
  country: { contained_in: [], membership: null },
});

const catalogueOf = (version: string, example: string): CatalogueResponse => ({
  catalogue_version: version,
  counts: {
    indicators: 108917,
    datasets: 92,
    publishers: 42,
    countries: 246,
    aid: { donors: 172, recipients: 235, years: { first: 1960, last: 2025 } },
  },
  examples: [{ text: example, template: "", stat_var: "", place: "country/KEN" }],
});

// Each row builds the object and gives what it prints: the whole text when `whole` is set, which
// holds at most two lines of at most 200 characters, else the start of the text.
const cardOf = (title: string): Card =>
  new Card({
    id: "cmp_ad956b407b1623ec17cfcd55",
    revision: 1,
    kind: "line",
    ref: dataset.ref,
    title,
    heldUntil: null,
    pinned: false,
    writeToken: "cmw_secret",
  });

const shareOf = (url: string): Share =>
  new Share({
    id: "k3Qx8vTa",
    url,
    embedUrl: "https://developmentfinance.org/embed/k3Qx8vTa",
    dataUrls: ["https://developmentfinance.org/api/v1/presentation/shares/k3Qx8vTa/slots/1/data"],
    revision: 2,
    latest: true,
    writeToken: "shw_secret",
  });

const ROWS: [string, () => { toString(): string }, string, boolean][] = [
  ["answer", () => answer, String(answer).split("\n")[0]!, false],
  ["dataset", () => dataset, "<Dataset Germany's gross ODA disbursements to Nigeria.\n", false],
  ["dataset-ref", () => dataset.ref, `DatasetRef(1 member: ${SPEC_ID} at ${VERSION}, exact)`, true],
  ["lookup", () => lookup, "<Lookup: resolve(names), node(dcid), code(code), catalogue()>", true],
  [
    "match-resolved",
    () => new Match(result("Kenya", { entity: KENYA })),
    "Kenya -> Kenya  country/KEN  (country)",
    true,
  ],
  [
    "match-resolved-near",
    () => new Match(result("Georgia", { entity: georgias[0]!, near_matches: [georgias[1]!] })),
    "Georgia -> Georgia  country/GEO  (country)  +1 near match",
    true,
  ],
  [
    "match-resolved-near-matches",
    () =>
      new Match(result("Georgia", { entity: georgias[0]!, near_matches: georgias.slice(1, 3) })),
    "Georgia -> Georgia  country/GEO  (country)  +2 near matches",
    true,
  ],
  [
    "match-ambiguous",
    () => new Match(result("Georgia", { status: "ambiguous", candidates: georgias })),
    "Georgia -> ambiguous: Georgia  country/GEO | Georgia  geoId/13 | Georgia  geoId/13a | +1 more",
    true,
  ],
  [
    "match-not-found-nearest",
    () => new Match(result("Germny", { status: "not_found", near_matches: [GERMANY] })),
    "Germny -> not found; nearest: Germany  country/DEU",
    true,
  ],
  [
    "match-not-found",
    () => new Match(result("Xqzzy", { status: "not_found", near_matches: [] })),
    "Xqzzy -> not found",
    true,
  ],
  [
    "match-not-held",
    () =>
      new Match(
        result("Atlantis", {
          status: "not_held",
          entity: { ref: "dc/x", label: "Atlantis", kind: null },
        }),
      ),
    "Atlantis -> not held: Atlantis  dc/x",
    true,
  ],
  [
    "node",
    () => new Node(kenyaNode("Kenya")),
    "Kenya  country/KEN  (country)  types: Country",
    true,
  ],
  [
    "code",
    () =>
      new Code({
        code: "spec_not_found",
        classification: "refusal",
        definition: "No definition is registered at this id.",
        lifecycle: "active",
        mappings: [],
        title: null,
        detail: null,
      }),
    "spec_not_found: No definition is registered at this id.",
    true,
  ],
  [
    "catalogue",
    () => new Catalogue(catalogueOf("cat_1", "Life expectancy in Kenya")),
    "108,917 indicators, 92 datasets, 42 publishers, 246 countries; " +
      '1 example question, such as "Life expectancy in Kenya"',
    true,
  ],
  [
    "raw-response",
    () =>
      new RawResponse(
        200,
        new Headers({ "content-type": "application/json" }),
        new Uint8Array([123, 125]),
      ),
    "RawResponse(200, application/json, 2 bytes)",
    true,
  ],
  [
    "raw-response-untyped",
    () => new RawResponse(204, new Headers(), new Uint8Array([0])),
    "RawResponse(204, 1 byte)",
    true,
  ],
  ["latest-year", () => latestYear(-4), "latestYear(-4)", true],
  [
    "recipe",
    () => recipe({ spec_id: SPEC_ID, definition: {} }).rank({ by: "origin", limit: 10 }),
    `Recipe(rank by origin, limit 10, from ${SPEC_ID})`,
    true,
  ],
  [
    "analysis",
    () => clientOver(new Transport({ baseUrl: "https://api.example", apiKey: false })).analysis,
    "<Analysis: filter, aggregate, growth, rank, quotientOf, shareOf, join, sumOf, compare>",
    true,
  ],
  [
    "cards",
    () => clientOver(new Transport({ baseUrl: "https://api.example", apiKey: false })).cards,
    "<Cards: line, bar, table, stat, source>",
    true,
  ],
  [
    "card",
    () => cardOf("German ODA, last ten years"),
    `Card(line cmp_ad956b407b1623ec17cfcd55, "German ODA, last ten years", draws ${SPEC_ID} ` +
      `at ${VERSION})`,
    true,
  ],
  [
    "share",
    () => shareOf("https://developmentfinance.org/s/k3Qx8vTa"),
    "Share(live https://developmentfinance.org/s/k3Qx8vTa, 1 slot, revision 2)",
    true,
  ],
  [
    "served",
    () =>
      new Served({
        slot: 1,
        cardId: "cmp_ad956b407b1623ec17cfcd55",
        cardRevision: 1,
        specId: `ops_${"a".repeat(32)}`,
        contentVersion: `ocv_${"b".repeat(32)}`,
        firstServed: new Date("2026-09-24T08:00:00Z"),
        pinned: false,
        heldUntil: new Date("2026-11-23T00:00:00Z"),
        fetchable: true,
      }),
    `Served(slot 1 cmp_ad956b407b1623ec17cfcd55 from 24 Sep 2026: ops_${"a".repeat(32)} at ` +
      `ocv_${"b".repeat(32)} · fetchable until 23 Nov 2026)`,
    true,
  ],
];

test("a match cuts its text, each name and its line, and counts the candidates it leaves out", () => {
  const long = "Kenya's percent ".repeat(10);
  const candidates = Array.from({ length: 120 }, () => ({
    ref: `x/${"y".repeat(80)}`,
    label: long,
    kind: "place_other" as const,
  }));
  const text = String(new Match(result(long, { status: "ambiguous", candidates })));
  const cut = (width: number) => `${long.slice(0, width - 1).trimEnd()}…`;
  assert.ok(text.startsWith(`${cut(40)} -> ambiguous: ${cut(30)}  x/`), text);
  assert.equal(Array.from(text).length, 180);
  assert.ok(text.endsWith("…"), text);
});

for (const [name, build, expected, whole] of ROWS) {
  test(`${name} prints its summary in a template string and through util.inspect`, () => {
    const value = build();
    // What a template string prints.
    const text = value.toString();
    assert.equal(inspect(value), text);
    assert.ok(!text.includes("[object Object]"), text);
    if (!whole) {
      assert.ok(text.startsWith(expected), text);
      return;
    }
    assert.equal(text, expected);
    const lines = text.split("\n");
    assert.ok(lines.length <= 2 && lines.every((line) => line.length <= 200), text);
  });
}

// Each row gives an error or warning and the message it carries, the bracket at its end.
for (const [name, build, message] of [
  [
    "an error with a trace id",
    () =>
      new NotFoundError({
        code: serverCode("code_not_found"),
        detail: "No entry.",
        traceId: "4f2a",
      }),
    "No entry. [code_not_found · trace 4f2a]",
  ],
  [
    "an error with no trace id",
    () => new DfoError({ code: "invalid_argument", detail: "Bad window." }),
    "Bad window. [invalid_argument]",
  ],
  [
    "an error of several lines",
    () => new DfoError({ code: "invalid_argument", detail: "Bad window.\n  Use [2022, 2022]." }),
    "Bad window.\n  Use [2022, 2022].\n[invalid_argument]",
  ],
  [
    "an error that settles the trace id of the response it describes",
    () => {
      try {
        return describing("trace-9", () => {
          throw new DfoError({ code: "contract_violation", detail: "No members." });
        });
      } catch (error) {
        return error as DfoError;
      }
    },
    "No members. [contract_violation · trace trace-9]",
  ],
  [
    "a data warning, whose trace id stays out",
    () => new DataWarning("empty_result", "No rows.", "warn", "4f2a"),
    "No rows. [empty_result]",
  ],
  [
    "a search warning of several lines",
    () => new SearchWarning("closest_match", "Differs:\n  shows 2022"),
    "Differs:\n  shows 2022\n[closest_match]",
  ],
  ["a warning with no code", () => new DfoWarning(null, "Differs."), "Differs."],
  [
    "a series-left-out warning, whose code is null",
    () => new SeriesLeftOutWarning("3 series left out for missing data by growth"),
    "3 series left out for missing data by growth",
  ],
  [
    "an error whose trace id holds terminal controls",
    () => new DfoError({ code: "invalid_argument", detail: "Bad.", traceId: "x\u001b[31mRED" }),
    "Bad. [invalid_argument · trace x[31mRED]",
  ],
  [
    "a warning whose code holds terminal controls",
    () => new DfoWarning("odd\u009b2J", "Differs."),
    "Differs. [odd2J]",
  ],
] as const) {
  test(`${name} ends its message with its code`, () => {
    const value = build();
    assert.equal(value.message, message);
    assert.equal(String(value), `${value.name}: ${message}`);
  });
}

// Server text that would steer a terminal or start a line of its own: an ESC sequence that
// clears the screen, the one-byte C1 control sequence introducer and a line break.
const TAINT = "x\u001b[2J\u009by\nz";
// A control that may not reach a display: any C0 control but the display's own line feed,
// DEL and the C1 controls.
// eslint-disable-next-line no-control-regex -- the pattern names the controls it matches
const STEERING = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;

// The members of a Search response whose text an answer shows.
const SHOWN_MEMBERS = new Set(["rendered_sentence", "text", "label", "message", "reason"]);

/** `body` with `taint` appended to each string an answer shows. */
function tainted(body: unknown, taint: string): unknown {
  if (Array.isArray(body)) return body.map((item) => tainted(item, taint));
  if (body === null || typeof body !== "object") return body;
  return Object.fromEntries(
    Object.entries(body).map(([key, value]) => [
      key,
      typeof value === "string" && SHOWN_MEMBERS.has(key)
        ? `${value}${taint}`
        : tainted(value, taint),
    ]),
  );
}

const SCENARIOS = await scenarios();
const answerClient = clientOver(replay(NO_EXCHANGES).transport);

/** The answer a recorded scenario's first response gives, with `taint` in its shown text. */
const answerOf = (name: string) => (taint: string) =>
  answerFromBody(
    tainted(SCENARIOS.find((record) => record.name === name)!.exchanges[0]!.response.json, taint),
    { transport: replay(NO_EXCHANGES).transport },
    null,
  );

const DATASET_BYTES = await scenarioBytes("answer-definite-fetch.parquet");

/** A dataset with `taint` in its sentence, source, spec id and version. */
const datasetOf = (taint: string) =>
  Dataset.create(
    [
      {
        parts: [],
        spec: { spec_id: `${SPEC_ID}${taint}`, definition: {} },
        sentence: `Germany's gross ODA disbursements to Nigeria.${taint}`,
        contentVersion: `${VERSION}${taint}`,
        manifest: { citation: { text: "", sources: [{ ref: "oecd", label: `OECD${taint}` }] } },
        digest: "sha256:offline",
        rendering: { format: "parquet", bundle: false },
        data: DATASET_BYTES,
      },
    ],
    { layout: "long" },
  );

// Each row builds an object whose display shows server text with `taint` in it. The empty
// taint builds the clean twin, whose lines the tainted display must keep.
/** `datasetOf`'s datasets, built before the rows below read them synchronously, with no
 *  taint and with `TAINT`. */
const DATASETS = new Map([
  ["", await datasetOf("")],
  [TAINT, await datasetOf(TAINT)],
]);

const TAINTED_ROWS: [string, (taint: string) => { toString(): string }][] = [
  ["a definite answer", answerOf("answer-definite-fetch")],
  [
    "a revived definite answer",
    (taint) => Answer.fromJSON(answerOf("answer-definite-fetch")(taint).toJSON(), answerClient),
  ],
  ["an answer awaiting a choice", answerOf("answer-candidates-choose-fetch")],
  ["a partly answered answer", answerOf("answer-mixed-fetch-partial")],
  ["a declined answer", answerOf("answer-declined")],
  ["a dataset", (taint) => DATASETS.get(taint)!],
  [
    "a match",
    (taint) =>
      new Match(
        result(`Kenya${taint}`, {
          status: "ambiguous",
          candidates: [{ ...KENYA, label: `Kenya${taint}`, ref: `country/KEN${taint}` }],
        }),
      ),
  ],
  ["a node", (taint) => new Node(kenyaNode(`Kenya${taint}`))],
  [
    "a code",
    (taint) =>
      new Code({
        code: "spec_not_found",
        classification: null,
        definition: `No spec.${taint}`,
        lifecycle: null,
        mappings: [],
        title: null,
        detail: null,
      }),
  ],
  ["a catalogue", (taint) => new Catalogue(catalogueOf("cat_1", `GDP${taint}`))],
  ["a dataset ref", (taint) => DATASETS.get(taint)!.ref],
  ["a card", (taint) => cardOf(`German ODA${taint}`)],
  ["a share", (taint) => shareOf(`https://developmentfinance.org/s/k3Qx8vTa${taint}`)],
  [
    "a raw response",
    // A header value holds no line break, so the response's taint stops at the controls.
    (taint) =>
      new RawResponse(
        200,
        new Headers({ "content-type": `application/json${taint.replace("\n", " ")}` }),
        new Uint8Array([123, 125]),
      ),
  ],
];

for (const [name, build] of TAINTED_ROWS) {
  test(`${name} shows server text without terminal controls or line breaks of its own`, () => {
    const lines = String(build("")).split("\n").length;
    const value = build(TAINT);
    for (const text of [String(value), inspect(value)]) {
      assert.doesNotMatch(text, STEERING);
      // What the display leaves of the taint: the controls dropped, the line break a space.
      assert.ok(text.includes("x[2Jy z"), text);
      assert.equal(text.split("\n").length, lines, text);
    }
  });
}

test("an answer and a dataset keep the server text their display cleans", () => {
  assert.ok(answerOf("answer-definite-fetch")(TAINT).sentence?.endsWith(TAINT));
  const data = DATASETS.get(TAINT)!;
  assert.ok(data.sentence.endsWith(TAINT));
  assert.ok(data.ref.members[0]!.contentVersion.endsWith(TAINT));
});
