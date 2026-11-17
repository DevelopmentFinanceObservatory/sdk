// A search by series codes, against the dev reply python/tests/data/search-codes.json to the
// request beside it: two IDS codes DFO holds exactly and one it does not hold. The inexact cases
// change only `exact`, or add a second code, in that reply.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { answerFromBody } from "../src/search/answer.ts";
import type { AnswerContext, SearchOptions } from "../src/search/answer.ts";
import { answerText, incompleteMessage } from "../src/search/answer-text.ts";
import { Entity, Match } from "../src/search/lookup-results.ts";
import { search } from "../src/search/search.ts";
import { parsedInput } from "../src/search/structured.ts";
import type { CodeSearchOptions } from "../src/search/structured.ts";
import type { MemberRequest } from "../src/datasets/fetch.ts";
import { Dataset } from "../src/datasets/dataset.ts";
import { NO_EXCHANGES, replay, scenarioBytes } from "./replay.ts";
import { json, mockFetch, recordedJson } from "./support.ts";

const CODES = ["DT.TDS.MLAT.CD", "DT.TDS.BLAT.CD", "XX.NOPE.CD"];
const ONE_CODE: CodeSearchOptions = { codes: ["DT.TDS.MLAT.CD"] };
const IDS = "provenance/WorldBankInternationalDebtStatistics";
const MLAT = { provenance: IDS, code: "DT.TDS.MLAT.CD", exact: true };
/** A lookup result, read as `client.lookup.resolve` reads one. */
const matchOf = (result: Record<string, unknown>): Match =>
  new Match(result as ConstructorParameters<typeof Match>[0]);
const KENYA = new Entity({ ref: "country/KEN", label: "Kenya", kind: "country" });

type Body = {
  parts: {
    warnings: unknown[];
    restatement: Record<string, unknown>;
    spec?: { resolved: { stat_vars: { source_codes: unknown[] } } };
  }[];
};

const reply = async (): Promise<Body> => recordedJson<Body>("search-codes.json");
const recordedRequest = await recordedJson<{ input: unknown }>("search-codes.request.json");

/** The recorded reply with its first part's source codes replaced. */
async function held(entries: unknown[]): Promise<Body> {
  const body = await reply();
  body.parts[0]!.spec!.resolved.stat_vars.source_codes = entries;
  return body;
}

/** What the recording builder returns for every fetch: one member of recorded Parquet. */
const builtDataset = await Dataset.create(
  [
    {
      parts: [],
      spec: { spec_id: "spec_offline", definition: {} },
      sentence: "Built offline.",
      contentVersion: "cv_offline",
      manifest: {},
      digest: "sha256:offline",
      rendering: { format: "parquet", bundle: false },
      data: await scenarioBytes("answer-definite-fetch.parquet"),
    },
  ],
  { layout: "long" },
);

/** A context that answers each Search request with `bodies` in turn and records what `fetch`
 *  builds. */
function serving(...bodies: unknown[]): {
  context: AnswerContext;
  built: MemberRequest[][];
  posted: () => unknown[];
} {
  const { fetch, seen } = mockFetch(...bodies.map((body) => json(body)));
  const built: MemberRequest[][] = [];
  const context: AnswerContext = {
    transport: replay(NO_EXCHANGES, { fetch }).transport,
    fetchMembers: (_, members) => {
      built.push([...members]);
      return Promise.resolve(builtDataset);
    },
  };
  return {
    context,
    built,
    posted: () => seen.map((request): unknown => JSON.parse(request.body ?? "")),
  };
}

describe("a search by codes", () => {
  test("posts the recorded request", () => {
    const built = parsedInput({
      codes: ["DT.TDS.MLAT.CD", " DT.TDS.BLAT.CD", "XX.NOPE.CD"],
      entities: { destination: ["country/KEN"] },
      window: [2015, 2020],
    });
    assert.deepEqual(built, recordedRequest.input);
  });

  for (const [name, keys, expected] of [
    ["code", {}, {}],
    ["variable", { variable: " debt service " }, { variable_text: "debt service" }],
    [
      "place",
      { entities: { place: [KENYA] } },
      { entities: [{ text: "Kenya", dcid: "country/KEN" }] },
    ],
    [
      "flow",
      {
        entities: {
          origin: [
            matchOf({
              input: "France",
              status: "resolved",
              entity: { ref: "country/FRA", label: "France", kind: "country" },
              candidates: [],
              near_matches: [],
            }),
          ],
          destination: [" country/KEN ", KENYA],
        },
      },
      {
        entities: [
          { text: "France", dcid: "country/FRA", role_text: "from" },
          { text: "country/KEN", dcid: "country/KEN", role_text: "to" },
          { text: "Kenya", dcid: "country/KEN", role_text: "to" },
        ],
      },
    ],
    ["latest", { window: "latest" }, { time_text: "latest" }],
    ["all", { window: "all" }, {}],
    ["open", { openRoles: ["origin"] }, { open_roles: ["origin"] }],
    ["source", { source: "IDS" }, { sources: [{ text: "IDS" }] }],
  ] as const) {
    test(`fills every part from ${name}`, () => {
      const codes = ["DT.TDS.MLAT.CD", "dt.tds.blat.cd"];
      const built = parsedInput({ codes, ...keys });
      assert.deepEqual(
        built.parts,
        codes.map((code) => ({
          variable_text: code,
          source_code: code,
          separate: true,
          ...expected,
        })),
      );
    });
  }

  for (const [name, keys] of [
    ["codes as a string", { codes: "DT.TDS.MLAT.CD" }],
    ["no codes", { codes: [] }],
    ["a blank code", { codes: ["DT.TDS.MLAT.CD", " "] }],
    ["a code twice", { codes: ["DT.TDS.MLAT.CD", "dt.tds.mlat.cd"] }],
    ["an empty variable", { variable: "" }],
    ["entities as a list", { entities: ["country/KEN"] }],
    ["a wire word for a role", { entities: { recipient: ["country/KEN"] } }],
    ["a null role", { entities: { place: null } }],
    ["a role as a string", { entities: { place: "country/KEN" } }],
    ["reversed years", { window: [2020, 2015] }],
    ["open roles as a string", { openRoles: "origin" }],
    ["place as an open role", { openRoles: ["place"] }],
    ["an open role that is not a string", { openRoles: [{ toString: () => "origin" }] }],
    ["a source that is not text", { source: 3 }],
    ["a key it does not take", { partial: true }],
  ] as const) {
    test(`refuses ${name} before any request`, async () => {
      const { context, posted } = serving();
      const search_ = { ...ONE_CODE, ...keys } as unknown as CodeSearchOptions;
      await assert.rejects(search(context, search_), {
        name: "InvalidRequestError",
        code: "invalid_argument",
      });
      assert.deepEqual(posted(), []);
    });
  }

  for (const [name, question, options] of [
    ["a question beside codes", "debt service of Kenya", { codes: CODES }],
    ["a question beside a window", "debt service of Kenya", { window: [2015, 2020] }],
    ["keys without codes", { entities: { place: ["country/KEN"] } }, undefined],
    ["an empty object", {}, undefined],
    ["codes beside a second options object", { codes: CODES }, { timeout: 1000 }],
  ] as const) {
    test(`refuses ${name} before any request`, async () => {
      const { context, posted } = serving();
      await assert.rejects(
        search(context, question as CodeSearchOptions, options as unknown as SearchOptions),
        { name: "InvalidRequestError", code: "invalid_argument" },
      );
      assert.deepEqual(posted(), []);
    });
  }

  test("names codes for a list asked as the question, beside a key too", async () => {
    const { context, posted } = serving();
    await assert.rejects(
      search(
        context,
        ["DT.TDS.MLAT.CD"] as unknown as CodeSearchOptions,
        {
          entities: { place: ["country/KEN"] },
        } as unknown as SearchOptions,
      ),
      (error: Error) => /series codes/.test(error.message) && !/not both/.test(error.message),
    );
    assert.deepEqual(posted(), []);
  });

  test("reads a key of a search by codes set to undefined as absent beside a question", async () => {
    const { context, posted } = serving(await reply());
    const options = { window: undefined, codes: undefined } as unknown as SearchOptions;
    await search(context, "debt service of Kenya", options);
    assert.deepEqual(posted(), [
      { schema_version: 1, input: { kind: "raw_text", query: "debt service of Kenya" } },
    ]);
  });

  test("refuses an unresolved match as fetch refuses it", () => {
    const ambiguous = matchOf({
      input: "Congo",
      status: "ambiguous",
      entity: null,
      candidates: [{ ref: "country/COD", label: "Congo [DRC]", kind: "country" }],
      near_matches: [],
    });
    assert.throws(() => parsedInput({ codes: CODES, entities: { place: [ambiguous] } }), {
      name: "InvalidRequestError",
      code: "match_unresolved",
    });
  });

  for (const inexact of [false, true]) {
    test(`builds the ${inexact ? "exact codes only" : "codes held"} with partial`, async () => {
      const body = inexact ? await held([{ ...MLAT, exact: false }]) : await reply();
      const { context, built, posted } = serving(body);
      const answer = await search(context, {
        codes: CODES,
        entities: { destination: ["country/KEN"] },
        window: [2015, 2020],
      });
      assert.deepEqual(posted(), [{ schema_version: 1, ...recordedRequest }]);
      assert.equal(answer.question, null);
      const gaps = inexact ? [0, 2] : [2];
      assert.deepEqual(
        answer.gaps.map((gap) => [gap.partIndex, gap.kind]),
        gaps.map((index) => [index, "no_data"]),
      );
      await assert.rejects(answer.fetch(), { code: "answer_incomplete" });
      assert.equal(built.length, 0);
      await answer.fetch({ partial: true });
      assert.deepEqual(
        built[0]!.map((member) => member.parts),
        CODES.filter((_, index) => !gaps.includes(index)).map((code) => [code]),
      );
    });
  }

  for (const [name, entries, gaps] of [
    ["exact", [MLAT], [2]],
    ["lower case", [{ ...MLAT, code: "dt.tds.mlat.cd" }], [2]],
    ["not exact", [{ ...MLAT, exact: false }], [0, 2]],
    ["exact left out", [{ provenance: IDS, code: "DT.TDS.MLAT.CD" }], [0, 2]],
    ["a second code", [MLAT, { ...MLAT, code: "DT.TDS.MLAT.CD.X" }], [0, 2]],
    ["no code", [], [0, 2]],
    ["an entry that is not an object", [MLAT, "DT.TDS.MLAT.CD"], [0, 2]],
  ] as const) {
    for (const by of ["codes", "restatement"] as const) {
      test(`reads a reading holding ${name} by its ${by}`, async () => {
        const answer = answerFromBody(
          await held([...entries]),
          serving().context,
          null,
          null,
          by === "codes" ? CODES : undefined,
        );
        assert.deepEqual(
          answer.gaps.map((gap) => [gap.partIndex, gap.kind]),
          gaps.map((index) => [index, "no_data"]),
        );
        assert.equal(answer.specs.length, 3 - gaps.length);
        assert.equal(answer.complete, false);
      });
    }
  }

  test("names the asked code and the codes a part holds", async () => {
    const answer = answerFromBody(
      await held([
        { ...MLAT, exact: false },
        { ...MLAT, code: "DT.X" },
      ]),
      serving().context,
      null,
    );
    const { message } = answer.gaps[0]!;
    assert.match(message, /"DT\.TDS\.MLAT\.CD" \(not exact\)/);
    assert.match(message, /"DT\.X"/);
    assert.ok(message.includes("client.fetch((answer.parts[0] as DefinitePart).spec)"));
    const lines = incompleteMessage(answer).split("\n");
    assert.equal(lines[0], "Search answered 1 of 3 series codes.");
    assert.ok(lines[1]!.startsWith('  missing  "DT.TDS.MLAT.CD": '));
    assert.equal(answerText(answer).split("\n")[0], "Answered 1 of 3 series codes.");
  });

  for (const writtenBy of ["0.3", "0.2.0"] as const) {
    test(`reads a code gap through JSON written by ${writtenBy}`, async () => {
      const { context } = serving();
      const answer = answerFromBody(await held([{ ...MLAT, exact: false }]), context, null);
      const stored = structuredClone(answer.toJSON().answer) as Body;
      if (writtenBy === "0.2.0") {
        // @developmentfinance/client 0.2.0 cut `resolved.stat_vars` from answer JSON, so its
        // answers cannot be checked by code and read as they did then.
        for (const part of stored.parts) {
          if (part.spec !== undefined) {
            delete (part.spec.resolved as { stat_vars?: unknown }).stat_vars;
          }
        }
      }
      const revived = answerFromBody(stored, context, null, null, undefined, true);
      const expected = writtenBy === "0.3" ? answer.gaps : answer.gaps.slice(1);
      assert.deepEqual(
        revived.gaps.map((gap) => [gap.partIndex, gap.message]),
        expected.map((gap) => [gap.partIndex, gap.message]),
      );
    });
  }

  test("reads a live code part without stat_vars as a gap", async () => {
    const body = await reply();
    for (const part of body.parts) {
      if (part.spec !== undefined) delete (part.spec.resolved as { stat_vars?: unknown }).stat_vars;
    }
    const answer = answerFromBody(body, serving().context, null, null, CODES);
    assert.deepEqual(
      answer.gaps.map((gap) => gap.partIndex),
      [0, 1, 2],
    );
  });

  test("posts a code-gapped part restated beside a choice", async () => {
    // Search answers an identity entry with no restatement, so posting the code-gapped part by
    // its identity would lose its code and its gap. Posted restated, it comes back with its
    // code, and the new answer checks it again.
    const body = await recordedJson<Body>("search-two-parts-candidates.json");
    body.parts[0] = (await held([{ ...MLAT, exact: false }])).parts[0]!;
    const chosenReply = await recordedJson<Body>("probe-resubmit-code-part.json");
    chosenReply.parts[0]!.spec!.resolved.stat_vars.source_codes = [{ ...MLAT, exact: false }];
    const { context, posted } = serving(body, chosenReply);
    const answer = await search(context, "Germany's ODA and GNI from 2015 to 2022");
    assert.deepEqual(
      answer.gaps.map((gap) => [gap.partIndex, gap.kind]),
      [
        [0, "no_data"],
        [1, "choice"],
      ],
    );
    const chosen = await answer.choose(0);
    assert.deepEqual(
      posted()[1],
      await recordedJson<unknown>("probe-resubmit-code-part.request.json"),
    );
    assert.deepEqual(
      chosen.gaps.map((gap) => [gap.partIndex, gap.kind]),
      [[0, "no_data"]],
    );
    assert.equal(chosen.specs.length, 1);
  });

  test("reads a part without a code in its restatement as before", async () => {
    const body = await held([{ ...MLAT, exact: false }]);
    delete body.parts[0]!.restatement["source_code"];
    const answer = answerFromBody(body, serving().context, null);
    assert.deepEqual(
      answer.gaps.map((gap) => gap.partIndex),
      [2],
    );
  });

  for (const [name, edit] of [
    ["another number of parts", (body: Body) => void body.parts.pop()],
    [
      "a time_text_not_parsed warning",
      (body: Body) =>
        void body.parts[1]!.warnings.push({
          code: "time_text_not_parsed",
          severity: "warn",
          message: "unread",
        }),
    ],
  ] as const) {
    test(`raises contract_violation on ${name}`, async () => {
      const body = await reply();
      edit(body);
      const { context } = serving(body);
      await assert.rejects(search(context, { codes: CODES }), {
        name: "ContractError",
        code: "contract_violation",
      });
    });
  }
});
