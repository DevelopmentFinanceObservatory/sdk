import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parquetMetadata } from "hyparquet";

import { Answer, answerFromBody, Candidate, SearchWarning } from "../src/search/answer.ts";
import type { AnswerContext, Gap, QueryOption } from "../src/search/answer.ts";
import {
  ContractError,
  DeclinedError,
  IncompleteAnswerError,
  InvalidRequestError,
} from "../src/core/errors.ts";
import { toArrow } from "../src/datasets/arrow.ts";
import { clientOver } from "../src/client.ts";
import { Dataset } from "../src/datasets/dataset.ts";
import type { MemberRequest } from "../src/datasets/fetch.ts";
import { search } from "../src/search/search.ts";
import { Transport } from "../src/http/transport.ts";
import type { DfoWarning } from "../src/core/warnings.ts";
import type { CandidatesPart, DefinitePart } from "../src/wire.ts";
import { NO_EXCHANGES, replay, scenarioBytes, scenarios, stepOf } from "./replay.ts";
import type { Scenario } from "./replay.ts";
import { json, mockFetch } from "./support.ts";

const records = new Map((await scenarios()).map((scenario) => [scenario.name, scenario]));
const record = (name: string): Scenario => records.get(name)!;
/** The body of a scenario's first Search response, copied so a test can edit it. */
const body = (name: string): Record<string, unknown> =>
  structuredClone(record(name).exchanges[0]!.response.json) as Record<string, unknown>;

type Context = AnswerContext & { built: MemberRequest[][]; warnings: DfoWarning[] };

/** What the recording builder returns for every fetch: one member of recorded Parquet. */
const builtDataset = new Dataset<Gap>(
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

/** A context whose transport fails any request, or answers through `fetch`, and whose builder
 *  records its members. */
function offline(fetch?: typeof globalThis.fetch): Context {
  const built: MemberRequest[][] = [];
  const warnings: DfoWarning[] = [];
  return {
    transport: replay(NO_EXCHANGES, fetch === undefined ? {} : { fetch }).transport,
    onWarning: (warning) => warnings.push(warning),
    fetchMembers: (_, members) => {
      built.push([...members]);
      return Promise.resolve(builtDataset);
    },
    built,
    warnings,
  };
}

/** The error a promise rejects with; the test fails when it resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return assert.fail("the call resolved");
}

const answerOf = (name: string, context: AnswerContext = offline()): Answer =>
  answerFromBody(body(name), context, null);

describe("IncompleteAnswerError", () => {
  test("lists the answered part, the missing one and the partial fetch", async () => {
    const answer = answerOf("answer-mixed-fetch-raises");
    const error = await rejection(answer.fetch());
    assert.ok(error instanceof IncompleteAnswerError);
    assert.equal(error.code, "answer_incomplete");
    assert.equal(error.answer, answer);
    assert.deepEqual(
      error.gaps.map((gap) => [gap.partIndex, gap.kind]),
      [[1, "not_understood"]],
    );
    assert.deepEqual(error.message.split("\n"), [
      "Search answered 1 of 2 parts of your question.",
      `  answered "debt service": Kenya's external debt service owed to all creditors, 1970 to 2024. Current US dollars · World Bank International Debt Statistics (IDS).`,
      `  missing  "price of tea": Could not match "price of tea" to a supported indicator. Try a different wording or a related indicator.`,
      "  Or take the answered part: answer.fetch({ partial: true })",
    ]);
  });

  test("numbers a candidates part's readings and gives the call that settles it", async () => {
    const error = await rejection(answerOf("answer-candidates-choose-fetch").fetch());
    assert.ok(error instanceof IncompleteAnswerError);
    assert.deepEqual(error.message.split("\n"), [
      "Search answered 0 of 1 part of your question.",
      `  missing  "GNI": 3 readings`,
      "    [0] Germany's primary income for gross of fixed capital consumption, 2015 to 2022 · OECD DAC1 · Current US dollars",
      "    [1] Germany's gross national income based on purchasing power parity in international dollars, 2015 to 2022 · World Development Indicators",
      "    [2] Germany's gross national income based on purchasing power parity per capita in international dollars, 2015 to 2022 · World Development Indicators",
      "  Choose: (await answer.choose(0)).fetch()",
    ]);
  });

  test("names a place choice by the word it settles, or by the part when the word repeats", () => {
    assert.deepEqual(
      answerOf("choose-place-one-part").incompleteError().message.split("\n").slice(-1),
      [`  Choose: (await answer.choose("Congo", "Congo [DRC]")).fetch()`],
    );
    assert.deepEqual(
      answerOf("choose-place-two-parts").incompleteError().message.split("\n").slice(-2),
      [
        `  Choose: (await answer.choose("GDP", "Congo [DRC]")).fetch()`,
        `  Choose: (await answer.choose("ODA disbursements", "Congo [DRC]")).fetch()`,
      ],
    );
  });
});

const ASSUMED = {
  kind: "declared_default",
  binding_ref: "how:dac2aAidType",
  text: "official development assistance",
  refs: ["DAC2aAidType206"],
};

describe("gaps", () => {
  test("a candidate splits its sentence into label, source and unit, and carries its assumptions", () => {
    const edited = body("answer-candidates-choose-fetch");
    const [part] = edited["parts"] as CandidatesPart[];
    const [first, second] = part!.candidates.specs;
    part!.reading_assumptions = { [first!.spec_id]: [ASSUMED] };
    const [candidate, other] = answerFromBody(edited, offline(), null).gaps[0]!.options;
    assert.ok(candidate?.kind === "candidate" && other?.kind === "candidate");
    assert.deepEqual(
      {
        label: candidate.label,
        source: candidate.source,
        unit: candidate.unit,
        assumptions: candidate.assumptions,
      },
      {
        label: "Germany's primary income for gross of fixed capital consumption, 2015 to 2022.",
        source: "OECD DAC1",
        unit: "Current US dollars",
        assumptions: [ASSUMED],
      },
    );
    assert.equal(other.spec.spec_id, second!.spec_id);
    assert.deepEqual(other.assumptions, []);
    assert.deepEqual(candidate.unbound().assumptions, [ASSUMED]);
  });

  for (const sentence of [undefined, ""]) {
    test(`a candidate with no heading and ${sentence === undefined ? "no" : "an empty"} sentence has a null label`, () => {
      const edited = body("answer-candidates-choose-fetch");
      const [part] = edited["parts"] as CandidatesPart[];
      const { resolved } = part!.candidates.specs[0]!;
      delete resolved.sentence_plan;
      if (sentence === undefined) delete resolved.rendered_sentence;
      else resolved.rendered_sentence = sentence;
      const [candidate] = answerFromBody(edited, offline(), null).gaps[0]!.options;
      assert.ok(candidate?.kind === "candidate");
      assert.equal(candidate.label, null);
    });
  }

  test("a no_data part with an empty message takes its reason's text", () => {
    const edited = body("answer-mixed-fetch-raises");
    const part = (edited["parts"] as { no_data?: { message: string; reason: string } }[])[1]!;
    part.no_data!.message = "";
    assert.equal(answerFromBody(edited, offline(), null).gaps[0]?.message, part.no_data!.reason);
  });

  test("Search's time limit makes every no_data part a timed_out gap", () => {
    const edited = body("answer-mixed-fetch-raises");
    (edited["diagnostics"] as Record<string, unknown>)["timed_out"] = true;
    const answer = answerFromBody(edited, offline(), null);
    assert.equal(answer.timedOut, true);
    assert.deepEqual(
      answer.gaps.map((gap) => [gap.partIndex, gap.kind, gap.options.length]),
      [[1, "timed_out", 0]],
    );
  });

  test("a no_data reason with no contract row is a no_data gap", () => {
    const edited = body("search-place-ambiguous");
    const [part] = edited["parts"] as { no_data: { reason: string } }[];
    part!.no_data.reason = "reason_from_a_later_server";
    assert.equal(answerFromBody(edited, offline(), null).gaps[0]?.kind, "no_data");
  });
});

describe("choose", () => {
  test("refuses a part that offers no options, with no request", async () => {
    const edited = body("search-place-ambiguous");
    const [part] = edited["parts"] as { no_data: { options: unknown[] } }[];
    part!.no_data.options = [];
    const answer = answerFromBody(edited, offline(), null);
    await assert.rejects(answer.choose(0), (error: unknown) => {
      assert.ok(error instanceof InvalidRequestError);
      assert.equal(error.code, "choice_invalid");
      return true;
    });
  });

  const queries: [string, (query: { parts: unknown[] }) => unknown][] = [
    ["no data_query", () => undefined],
    ["an empty data_query", () => ({})],
    ["a two-part data_query", (query) => ({ ...query, parts: [query.parts[0], query.parts[0]] })],
  ];
  for (const name of ["choose-place-one-part", "choose-place-two-parts"]) {
    for (const [what, edit] of queries) {
      test(`refuses an option with ${what} in ${name}, with no request`, async () => {
        const edited = body(name);
        const parts = edited["parts"] as { no_data?: { options: Record<string, unknown>[] } }[];
        const part = parts.find((candidate) => candidate.no_data !== undefined)!;
        for (const option of part.no_data!.options) {
          option["data_query"] = edit(option["data_query"] as { parts: unknown[] });
        }
        const answer = answerFromBody(edited, offline(), null);
        const index = parts.indexOf(part);
        await assert.rejects(answer.choose(index, 0), {
          name: "ContractError",
          code: "contract_violation",
        });
      });
    }
  }

  const invalidChoices: [string, () => Promise<Answer>][] = [
    ["an answer with nothing to choose", () => answerOf("answer-definite-fetch").choose(0)],
    ["an option label no option has", () => answerOf("choose-place-one-part").choose("Nowhere")],
    ["an option index out of range", () => answerOf("choose-place-one-part").choose(2)],
    ["no part when several await a choice", () => answerOf("choose-place-two-parts").choose(0)],
    [
      "a word two parts share",
      () => answerOf("choose-place-two-parts").choose("Congo", "Congo [DRC]"),
    ],
    ["a part index out of range", () => answerOf("choose-place-one-part").choose(3, 0)],
    ["a part that already has a reading", () => answerOf("answer-mixed-fetch-raises").choose(0, 0)],
  ];
  for (const [name, choose] of invalidChoices) {
    test(`refuses ${name}, with no request`, async () => {
      await assert.rejects(choose(), { name: "InvalidRequestError", code: "choice_invalid" });
    });
  }

  test("a several-part choice of a candidate posts identities for the definite and the chosen part", async () => {
    const definite = (body("answer-definite-fetch")["parts"] as DefinitePart[])[0]!;
    const groups = { origin: { label: "Germany", ref: "country/DEU" } };
    definite.spec.resolved.entity_groups = groups;
    const candidates = (body("answer-candidates-choose-fetch")["parts"] as CandidatesPart[])[0]!;
    const chosen = candidates.candidates.specs[1]!;
    const resolution = {
      ...body("answer-definite-fetch"),
      status: "mixed",
      parts: [definite, candidates],
    };
    const { fetch, seen } = mockFetch(json(body("answer-definite-fetch")));
    const answer = answerFromBody(resolution, offline(fetch), null);

    await answer.choose("GNI", 1);

    const posted = JSON.parse(seen[0]!.body!) as { input: unknown };
    assert.deepEqual(posted.input, {
      kind: "dataset_resubmit",
      entries: [
        {
          variable_text: definite.variable_text,
          entry_kind: "identity",
          identity: definite.spec.definition.identity,
          entity_groups: groups,
          assumptions: definite.assumptions,
        },
        {
          variable_text: "GNI",
          entry_kind: "identity",
          identity: chosen.definition.identity,
          ...(chosen.resolved.entity_groups
            ? { entity_groups: chosen.resolved.entity_groups }
            : {}),
          assumptions: candidates.reading_assumptions![chosen.spec_id],
        },
      ],
    });
  });
});

/** Every value reachable from `root` through own properties, `root` included. */
function reachable(root: unknown): unknown[] {
  const seen = new Set<unknown>();
  const queue = [root];
  while (queue.length > 0) {
    const value = queue.pop();
    if (value === null || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      queue.push((value as Record<PropertyKey, unknown>)[key]);
    }
  }
  return [...seen];
}

const candidatesOf = (gaps: readonly Gap[]): Candidate[] =>
  gaps.flatMap((gap) => gap.options.filter((option) => option instanceof Candidate));

/** Checks that a candidate refuses `fetch`, naming the call that fetches its spec. */
async function refusesFetch(candidate: Candidate): Promise<void> {
  await assert.rejects(candidate.fetch(), (error: unknown) => {
    assert.ok(error instanceof InvalidRequestError);
    assert.equal(error.code, "invalid_argument");
    assert.match(error.message, /client\.fetch\(candidate\.spec\)/);
    return true;
  });
}

describe("candidate.fetch", () => {
  test("builds the dataset choosing the candidate builds", async () => {
    const scenario = record("answer-candidates-choose-fetch");
    const { transport, remaining } = replay(scenario);
    const answer = await clientOver(transport).search("GNI of Germany from 2015 to 2022");
    const dataset = await candidatesOf(answer.gaps)[0]!.fetch();
    const expected = scenario.expect[2]!;
    assert.ok("dataset" in expected);
    assert.equal(dataset.rows, expected.dataset.rows);
    assert.deepEqual(
      dataset.members.map((member) => [
        member.spec.spec_id,
        member.contentVersion,
        member.sentence,
      ]),
      expected.dataset.members.map((member) => [
        member.spec_id,
        member.content_version,
        member.sentence,
      ]),
    );
    assert.deepEqual(remaining(), []);
  });

  test("a malformed assumption reads parsed on the candidate and its dataset, and its echo posts the object items", async () => {
    const scenario = structuredClone(record("answer-candidates-choose-fetch"));
    const [search, resubmit] = scenario.exchanges;
    const assumed = {
      kind: "declared_default",
      binding_ref: "how:fixedCapitalConsumptionBasis",
      text: "gross of fixed capital consumption",
      refs: ["GrossOfFixedCapitalConsumption"],
    };
    const listed = [null, { kind: "declared_default", binding_ref: 3, text: "bad" }, assumed];
    const offered = (search!.response.json as { parts: Record<string, unknown>[] }).parts[0]!;
    const specId = (offered as CandidatesPart).candidates.specs[0]!.spec_id;
    offered["reading_assumptions"] = { [specId]: listed };
    (resubmit!.response.json as { parts: Record<string, unknown>[] }).parts[0]!["assumptions"] =
      listed;
    const posted = resubmit!.request.json as { input: { entries: { assumptions: unknown }[] } };
    posted.input.entries[0]!.assumptions = listed.slice(1);
    const { transport, remaining } = replay(scenario);

    const answer = await clientOver(transport).search("GNI of Germany from 2015 to 2022");
    const candidate = candidatesOf(answer.gaps)[0]!;
    const dataset = await candidate.fetch();
    assert.deepEqual(remaining(), []);
    assert.deepEqual(candidate.assumptions, [assumed]);
    assert.deepEqual(dataset.assumptions, candidate.assumptions);
  });

  test("in an answer of several parts, asks Search for the candidate alone and builds its answer with the options given", async () => {
    const built: { members: MemberRequest[]; layout: unknown; timeout: unknown }[] = [];
    const picked = body("answer-definite-fetch");
    const { fetch, seen } = mockFetch(json(picked));
    const context: AnswerContext = {
      transport: replay(NO_EXCHANGES, { fetch }).transport,
      onWarning: () => undefined,
      fetchMembers: (_, members, options) => {
        built.push({ members: [...members], layout: options.layout, timeout: options.timeout });
        return Promise.resolve(builtDataset);
      },
    };
    const answer = answerOf("choose-candidate-two-parts", context);
    const part = answer.parts[0] as CandidatesPart;
    const candidate = candidatesOf(answer.gaps)[1]!;
    await candidate.fetch({ layout: "frame", timeout: 5_000 });

    const posted = JSON.parse(seen[0]!.body!) as { input: unknown };
    assert.deepEqual(posted.input, {
      kind: "dataset_resubmit",
      entries: [
        {
          variable_text: "GNI",
          entry_kind: "identity",
          identity: candidate.spec.definition.identity,
          assumptions: part.reading_assumptions![candidate.spec.spec_id],
        },
      ],
    });
    const [answered] = picked["parts"] as DefinitePart[];
    assert.deepEqual(
      built.map(({ members, layout, timeout }) => ({
        specs: members.map((member) => member.spec.spec_id),
        layout,
        timeout,
      })),
      [{ specs: [answered!.spec.spec_id], layout: "frame", timeout: 5_000 }],
    );
  });

  test("a partial fetch's dataset and an IncompleteAnswerError hold candidates with no client", async () => {
    const scenario = record("choose-candidate-two-parts");
    const [search, , , , , ...oda] = scenario.exchanges;
    const { transport, remaining } = replay({ ...scenario, exchanges: [search!, ...oda] });
    const answer = await clientOver(transport).search(stepOf(scenario, 0, "search").question);
    const dataset = await answer.fetch({ partial: true });
    assert.deepEqual(remaining(), []);

    assert.deepEqual(
      reachable(dataset).filter((value) => value instanceof Transport),
      [],
    );
    const missing = candidatesOf(dataset.missing);
    assert.equal(missing.length, 3);
    for (const candidate of missing) await refusesFetch(candidate);

    const error = answer.incompleteError();
    const held = candidatesOf(error.gaps);
    assert.equal(held.length, 3);
    for (const candidate of held) await refusesFetch(candidate);
    assert.deepEqual(
      candidatesOf(answer.gaps).map((candidate) => candidate.spec),
      held.map((candidate) => candidate.spec),
    );
  });
});

describe("fetch", () => {
  test("normalizes malformed optional part metadata through Search, fetch, toRows, toArrow and a bytes() reopen", async () => {
    const scenario = structuredClone(record("answer-definite-fetch"));
    const search = scenario.exchanges[0]!.response.json as { parts: Record<string, unknown>[] };
    const [part] = search.parts;
    part!["assumptions"] = [
      null,
      { kind: "declared_default", binding_ref: 3, text: "bad" },
      { kind: "declared_default", binding_ref: "how:aid", text: "aid", refs: ["A", 2] },
    ];
    part!["departures"] = [
      null,
      { code: 3, text: "bad" },
      { code: "operation_not_applied", text: "Not ranked.", asked: 2, shown: {} },
    ];
    part!["operations"] = [
      null,
      { verb: 3, phrase: "bad" },
      { verb: "rank", phrase: "top 5", over: 2, target_year: "2030" },
    ];
    const { transport, remaining } = replay(scenario);

    const answer = await clientOver(transport).search(stepOf(scenario, 0, "search").question);
    // The answer's hints read the same operations the dataset keeps.
    assert.deepEqual(String(answer).split("\n").slice(1), ['  Not done: rank ("top 5")']);
    const dataset = await answer.fetch();
    assert.deepEqual(remaining(), []);
    assert.deepEqual(dataset.assumptions, [
      { kind: "declared_default", binding_ref: "how:aid", text: "aid", refs: ["A"] },
    ]);
    assert.deepEqual(dataset.departures, [{ code: "operation_not_applied", text: "Not ranked." }]);
    assert.deepEqual(dataset.requestedOperations, [{ verb: "rank", phrase: "top 5" }]);

    const rows = await dataset.toRows();
    assert.equal(rows.length, dataset.rows);
    const table = await toArrow(dataset);
    assert.equal(table.numRows, dataset.rows);
    assert.deepEqual(
      table.schema.fields.map((field) => field.name),
      dataset.columns,
    );

    const saved = await dataset.bytes();
    const reopened = new Dataset([{ ...dataset.members[0]!, manifest: {}, data: saved }], {
      layout: "long",
    });
    assert.deepEqual(await reopened.toRows(), rows);
    const metadata = new Map(
      (parquetMetadata(saved.slice().buffer).key_value_metadata ?? []).map(({ key, value }) => [
        key,
        value,
      ]),
    );
    const provenance = JSON.parse(metadata.get("dfo.dataset")!) as Record<string, unknown>;
    assert.deepEqual(
      {
        assumptions: provenance["assumptions"],
        departures: provenance["departures"],
        requested_operations: provenance["requested_operations"],
      },
      {
        assumptions: [
          { kind: "declared_default", binding_ref: "how:aid", text: "aid", refs: ["A"] },
        ],
        departures: [
          {
            code: "operation_not_applied",
            text: "Not ranked.",
            asked: null,
            shown: null,
            binding_ref: null,
          },
        ],
        requested_operations: [{ verb: "rank", phrase: "top 5", over: null, target_year: null }],
      },
    );
  });

  test("a declined or catalogue answer raises DeclinedError", async () => {
    await assert.rejects(answerOf("answer-declined").fetch(), (error: unknown) => {
      assert.ok(error instanceof DeclinedError);
      assert.equal(error.code, "answer_declined");
      return true;
    });
    await assert.rejects(answerOf("answer-catalogue").fetch(), {
      name: "DeclinedError",
      code: "answer_declined",
    });
  });

  test("partial with no answered part still raises IncompleteAnswerError", async () => {
    const context = offline();
    await assert.rejects(
      answerOf("search-place-ambiguous", context).fetch({ partial: true }),
      IncompleteAnswerError,
    );
    assert.equal(context.built.length, 0);
  });

  test("builds each distinct spec once, naming every folded part", async () => {
    const context = offline();
    const answer = answerOf("answer-several-readings-folded", context);
    await answer.fetch();
    assert.deepEqual(
      context.built[0]!.map((member) => member.parts),
      [["ODA disbursements for health", "ODA disbursements for education"], ["GDP"]],
    );
    // A folded reading keeps its first part's spec.
    assert.equal(answer.specs[0], (answer.parts[0] as DefinitePart).spec);
  });

  test("a part with empty variable text adds nothing to its member's parts", async () => {
    const edited = body("answer-definite-fetch");
    const [part] = edited["parts"] as DefinitePart[];
    part!.variable_text = "";
    const context = offline();
    await answerFromBody(edited, context, null).fetch();
    assert.deepEqual(context.built[0]![0]!.parts, []);
  });

  test("a departure, a skipped computation and a warn notice arrive as one SearchWarning", async () => {
    const edited = body("answer-definite-fetch");
    const [part] = edited["parts"] as DefinitePart[];
    part!.departures = [{ code: "operation_not_applied", text: "Not ranked: rank skipped." }];
    part!.operations = [{ verb: "rank", phrase: "top 5" }];
    (edited["diagnostics"] as { warnings: unknown[] }).warnings = [
      { code: "slow_leg", severity: "warn", message: "One source answered slowly." },
      { code: "trace", severity: "info", message: "Hidden." },
    ];
    const context = offline();
    const answer = answerFromBody(edited, context, null);

    assert.equal(
      answer.toString(),
      `${answer.sentence!}\n  Not done: rank ("top 5")\n  Note: One source answered slowly.`,
    );
    await answer.fetch();
    assert.equal(context.warnings.length, 1);
    const [warning] = context.warnings;
    assert.ok(warning instanceof SearchWarning);
    assert.equal(warning.code, null);
    assert.deepEqual(warning.message.split("\n"), [
      "Search's reading differs from your question:",
      `  Not done: rank ("top 5")`,
      "  Not ranked: rank skipped.",
      "  Note: One source answered slowly.",
    ]);
    assert.equal(context.built.length, 1);

    await assert.rejects(answer.fetch({ strict: true }), SearchWarning);
    assert.equal(context.built.length, 1);
  });

  test('a warn notice with no code shows its note and raises under strict with the code ""', async () => {
    const edited = body("answer-definite-fetch");
    (edited["diagnostics"] as { warnings: unknown[] }).warnings = [
      { severity: "warn", message: "One source answered slowly." },
    ];
    const context = offline();
    const answer = answerFromBody(edited, context, null);
    assert.equal(answer.toString(), `${answer.sentence!}\n  Note: One source answered slowly.`);
    await assert.rejects(answer.fetch({ strict: true }), { name: "SearchWarning", code: "" });
    assert.equal(context.built.length, 0);
  });

  test("a strict fetch with one departure throws a SearchWarning with its code", async () => {
    const edited = body("answer-definite-fetch");
    const [part] = edited["parts"] as DefinitePart[];
    part!.departures = [{ code: "operation_not_applied", text: "Not ranked: rank skipped." }];
    const context = offline();
    await assert.rejects(answerFromBody(edited, context, null).fetch({ strict: true }), {
      name: "SearchWarning",
      code: "operation_not_applied",
    });
    assert.equal(context.built.length, 0);
  });
});

describe("reading a Search response", () => {
  test("refuses an answer kind this client does not know", () => {
    assert.throws(
      () => answerFromBody({ ...body("answer-declined"), kind: "essay" }, offline(), null),
      ContractError,
    );
  });

  test("refuses a definite part with no spec_id", () => {
    const edited = body("answer-definite-fetch");
    delete (edited["parts"] as { spec: Record<string, unknown> }[])[0]!.spec["spec_id"];
    assert.throws(() => answerFromBody(edited, offline(), null), ContractError);
  });

  type Edit = (parts: Record<string, unknown>[]) => void;
  const unlike = "spec_00000000000000000000000000000000";
  const refusals: [string, string, Edit, string][] = [
    ["a resolution with no parts", "answer-definite-fetch", (p) => p.splice(0), "/parts"],
    [
      "a part with no status",
      "answer-definite-fetch",
      (p) => delete p[0]!["status"],
      "/parts/0/status",
    ],
    [
      "a part whose status is not a string",
      "answer-definite-fetch",
      (p) => (p[0]!["status"] = 5),
      "/parts/0/status",
    ],
    [
      "a definite spec whose definition names another spec",
      "answer-definite-fetch",
      (p) =>
        ((p[0]!["spec"] as Record<string, Record<string, unknown>>)["definition"]!["spec_id"] =
          unlike),
      "/parts/0/spec/definition/spec_id",
    ],
    [
      "a candidate whose definition names another spec",
      "answer-candidates-choose-fetch",
      (p) => ((p[0] as unknown as CandidatesPart).candidates.specs[1]!.definition.spec_id = unlike),
      "/parts/0/candidates/specs/1/definition/spec_id",
    ],
  ];
  for (const [name, scenarioName, edit, pointer] of refusals) {
    test(`refuses ${name}`, () => {
      const edited = body(scenarioName);
      edit(edited["parts"] as Record<string, unknown>[]);
      assert.throws(() => answerFromBody(edited, offline(), null), {
        name: "ContractError",
        code: "contract_violation",
        pointer,
      });
    });
  }

  type BodyEdit = (body: Record<string, unknown>, parts: Record<string, unknown>[]) => void;
  type Read = (answer: Answer, context: ReturnType<typeof offline>) => void | Promise<void>;
  const specsOf = (part: Record<string, unknown>): Record<string, unknown>[] =>
    (part["candidates"] as { specs: Record<string, unknown>[] }).specs;
  const resolvedOf = (spec: Record<string, unknown>): Record<string, unknown> =>
    spec["resolved"] as Record<string, unknown>;
  const sentenceOf = (name: string): string =>
    String(answerFromBody(body(name), offline(), null).sentence);
  const malformed: [string, string, BodyEdit, string | Read][] = [
    [
      "candidates.specs that is not an array",
      "answer-candidates-choose-fetch",
      (_, p) => ((p[0]!["candidates"] as Record<string, unknown>)["specs"] = {}),
      "/parts/0/candidates/specs",
    ],
    ["parts that is not an array", "answer-definite-fetch", (b) => (b["parts"] = {}), "/parts"],
    [
      "a part that is not an object",
      "answer-definite-fetch",
      (_, p) => p.unshift(null!),
      "/parts/0",
    ],
    [
      "a null token in a sentence plan",
      "answer-candidates-choose-fetch",
      (_, p) => (resolvedOf(specsOf(p[0]!)[0]!)["sentence_plan"] as unknown[]).unshift(null),
      (answer) => {
        assert.equal(answer.gaps.length, 1);
      },
    ],
    [
      "a sentence plan that is not an array",
      "answer-candidates-choose-fetch",
      (_, p) => (resolvedOf(specsOf(p[0]!)[0]!)["sentence_plan"] = {}),
      (answer) => {
        const [candidate] = answer.gaps[0]!.options as Candidate[];
        assert.equal(candidate!.label, candidate!.sentence);
      },
    ],
    [
      "reading assumptions that are not an array",
      "answer-candidates-choose-fetch",
      (_, p) => {
        const id = String(specsOf(p[0]!)[0]!["spec_id"]);
        (p[0]!["reading_assumptions"] as Record<string, unknown>)[id] = {};
      },
      (answer) => {
        assert.deepEqual((answer.gaps[0]!.options[0] as Candidate).assumptions, []);
      },
    ],
    [
      "operations that are not an array",
      "answer-definite-fetch",
      (_, p) => (p[0]!["operations"] = {}),
      (answer) => {
        assert.equal(String(answer), sentenceOf("answer-definite-fetch"));
      },
    ],
    [
      "warnings that are not an array",
      "answer-definite-fetch",
      (_, p) => (p[0]!["warnings"] = {}),
      (answer) => {
        assert.equal(String(answer), sentenceOf("answer-definite-fetch"));
      },
    ],
    ...[null, 5].map((segment): [string, string, BodyEdit, Read] => [
      `a sentence-plan token whose segment is ${String(segment)}`,
      "answer-candidates-choose-fetch",
      (_, p) =>
        (resolvedOf(specsOf(p[0]!)[0]!)["sentence_plan"] as unknown[]).unshift({
          segment,
          text: "ZZZ ",
        }),
      (answer) => {
        const [candidate] = answer.gaps[0]!.options as Candidate[];
        assert.equal(candidate!.label?.startsWith("ZZZ "), true);
      },
    ]),
    [
      "an option mention that is not a string",
      "choose-place-one-part",
      (_, p) => {
        for (const option of (p[0]!["no_data"] as { options: Record<string, unknown>[] }).options) {
          option["mentions"] = [5, "Congo"];
        }
      },
      (answer) => {
        assert.deepEqual((answer.gaps[0]!.options[0] as QueryOption).mentions, ["Congo"]);
      },
    ],
    [
      "a variable_text that is not a string, in a fetched member",
      "answer-definite-fetch",
      (_, p) => (p[0]!["variable_text"] = 5),
      async (answer, { built }) => {
        await answer.fetch();
        assert.deepEqual(built[0]![0]!.parts, []);
      },
    ],
    [
      "a variable_text that is not a string, in a gap line",
      "choose-place-one-part",
      (_, p) => (p[0]!["variable_text"] = 7),
      (answer) => {
        assert.match(String(answer), /^ {2}missing {2}"": /m);
      },
    ],
    [
      "a null departure",
      "answer-definite-fetch",
      (_, p) => (p[0]!["departures"] = [null]),
      async (answer) => {
        await answer.fetch();
        assert.equal(String(answer), sentenceOf("answer-definite-fetch"));
      },
    ],
  ];
  for (const [name, scenarioName, edit, expected] of malformed) {
    test(`reads ${name} ${typeof expected === "string" ? `as a violation at ${expected}` : "as absent"}`, async () => {
      const edited = body(scenarioName);
      edit(edited, edited["parts"] as Record<string, unknown>[]);
      if (typeof expected === "string") {
        assert.throws(() => answerFromBody(edited, offline(), null), {
          name: "ContractError",
          code: "contract_violation",
          pointer: expected,
        });
      } else {
        const context = offline();
        await expected(answerFromBody(edited, context, null), context);
      }
    });
  }

  const resubmits: [string, string, BodyEdit, (entries: Record<string, unknown>[]) => void][] = [
    [
      "a restatement that is not an object posts a placeholder",
      "choose-place-two-parts",
      (_, p) => (p[1]!["restatement"] = "ODA disbursements"),
      (entries) => {
        assert.deepEqual(entries[1], {
          entry_kind: "placeholder",
          status: "no_data",
          reason: "entity_ambiguous",
          variable_text: "ODA disbursements",
        });
      },
    ],
    [
      "assumptions that are not an array post none",
      "choose-candidate-echoes-assumptions",
      (_, p) => (p[1]!["assumptions"] = {}),
      (entries) => {
        assert.equal("assumptions" in entries[1]!, false);
      },
    ],
  ];
  for (const [name, scenarioName, edit, check] of resubmits) {
    test(`choose: ${name}`, async () => {
      const edited = body(scenarioName);
      edit(edited, edited["parts"] as Record<string, unknown>[]);
      const { fetch, seen } = mockFetch(json(record(scenarioName).exchanges[1]!.response.json));
      await answerFromBody(edited, offline(fetch), null).choose(0, 0);
      const posted = JSON.parse(seen[0]!.body!) as {
        input: { entries: Record<string, unknown>[] };
      };
      check(posted.input.entries);
    });
  }

  test("search bounds the whole call, each attempt reading until its deadline", async () => {
    const answered = record("answer-definite-fetch").exchanges[0]!.response.json;
    const slow =
      (ms: number) =>
      (_request: unknown, init: RequestInit): Promise<Response> =>
        new Promise((resolve, reject) => {
          const socket = setTimeout(() => {
            resolve(json(answered)());
          }, ms);
          init.signal?.addEventListener("abort", () => {
            clearTimeout(socket);
            reject(init.signal?.reason);
          });
        });
    // The client's 20 ms attempt timeout does not cut off a search that takes 60 ms.
    const quick = mockFetch(slow(60));
    const context = {
      ...offline(),
      transport: replay(NO_EXCHANGES, { fetch: quick.fetch, timeout: 20 }).transport,
    };
    assert.equal((await search(context, "q")).kind, "resolution");
    // A search past its own timeout raises once, with no retry.
    const late = mockFetch(slow(1_000), slow(1_000));
    const stuck = {
      ...offline(),
      transport: replay(NO_EXCHANGES, { fetch: late.fetch, now: () => performance.now() })
        .transport,
    };
    await assert.rejects(search(stuck, "q", { timeout: 30 }), {
      name: "DfoTimeoutError",
      code: "deadline_exceeded",
    });
    assert.equal(late.seen.length, 1);
  });

  test("search posts the raw question and keeps it on the answer", async () => {
    const scenario = record("answer-definite-fetch");
    const { transport } = replay({ ...scenario, exchanges: scenario.exchanges.slice(0, 1) });
    const question = "ODA disbursements from Germany to Nigeria for basic health care";
    const answer = await search({ ...offline(), transport }, question);
    assert.equal(answer.question, question);
  });
});
