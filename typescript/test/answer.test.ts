import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { Answer, answerFromBody, Candidate, SearchWarning } from "../src/answer.ts";
import type { AnswerContext, Gap } from "../src/answer.ts";
import {
  ContractError,
  DeclinedError,
  IncompleteAnswerError,
  InvalidRequestError,
} from "../src/errors.ts";
import { clientOver } from "../src/client.ts";
import { Dataset } from "../src/dataset.ts";
import type { MemberRequest } from "../src/fetch.ts";
import { search } from "../src/search.ts";
import { Transport } from "../src/transport.ts";
import type { DfoWarning } from "../src/warnings.ts";
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

describe("gaps", () => {
  test("a candidate splits its sentence into label, source and unit", () => {
    const [candidate] = answerOf("answer-candidates-choose-fetch").gaps[0]!.options;
    assert.ok(candidate?.kind === "candidate");
    assert.deepEqual(
      { label: candidate.label, source: candidate.source, unit: candidate.unit },
      {
        label: "Germany's primary income for gross of fixed capital consumption, 2015 to 2022.",
        source: "OECD DAC1",
        unit: "Current US dollars",
      },
    );
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
      assert.match(error.message, /^Part 0 offers no choice: "Congo" matches/);
      return true;
    });
  });

  test("refuses an answer with nothing to choose and an option it does not offer", async () => {
    await assert.rejects(answerOf("answer-definite-fetch").choose(0), /No part of this answer/);
    await assert.rejects(answerOf("choose-place-one-part").choose("Congo [Nowhere]"), /no option/);
    await assert.rejects(answerOf("choose-place-one-part").choose(2), /out of range/);
  });

  test("needs the part when several await a choice, and a word two parts share", async () => {
    const answer = answerOf("choose-place-two-parts");
    await assert.rejects(answer.choose("Congo [DRC]"), /2 parts of this answer await a choice/);
    await assert.rejects(answer.choose("Congo", "Congo [DRC]"), /2 parts are named "Congo"/);
  });

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
  test("a declined or catalogue answer raises DeclinedError with its reason", async () => {
    await assert.rejects(answerOf("answer-declined").fetch(), (error: unknown) => {
      assert.ok(error instanceof DeclinedError);
      assert.equal(error.code, "answer_declined");
      assert.match(error.message, /^Search declined the question: it asks for an argument/);
      return true;
    });
    await assert.rejects(answerOf("answer-catalogue").fetch(), /answered with the catalogue/);
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
    await answerOf("answer-several-readings-folded", context).fetch();
    assert.deepEqual(
      context.built[0]!.map((member) => member.parts),
      [["ODA disbursements for health", "ODA disbursements for education"], ["GDP"]],
    );
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

  test("search posts the raw question and keeps it on the answer", async () => {
    const scenario = record("answer-definite-fetch");
    const { transport } = replay({ ...scenario, exchanges: scenario.exchanges.slice(0, 1) });
    const question = "ODA disbursements from Germany to Nigeria for basic health care";
    const answer = await search({ ...offline(), transport }, question);
    assert.equal(answer.question, question);
  });
});
