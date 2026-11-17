// A reading fetched in another currency and price basis, against the dev replies under
// python/tests/data that the Python client's tests read too: search-oda-deu-ken.json (an answer
// whose spec offers conversions), search-debt-stock-ken.json (one that offers none), and the
// conversion resubmits probe-resubmit-unit-*.json with the bodies the client must post.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { clientOver } from "../src/client.ts";
import { unitConversion } from "../src/core/conversion.ts";
import { ContractError, DfoError, InvalidRequestError } from "../src/core/errors.ts";
import { DatasetRef } from "../src/core/ref.ts";
import type { Spec } from "../src/core/ref.ts";
import { DataWarning, SearchWarning } from "../src/core/warnings.ts";
import type { DfoWarning } from "../src/core/warnings.ts";
import type { Dataset } from "../src/datasets/dataset.ts";
import type { FetchMembersOptions, MemberRequest } from "../src/datasets/fetch.ts";
import { recipe } from "../src/datasets/recipe.ts";
import { fetchDataset } from "../src/datasets/resolve.ts";
import { Answer, answerFromBody } from "../src/search/answer.ts";
import { NO_EXCHANGES, replay, scenario, stepOf } from "./replay.ts";
import type { Exchange, Scenario } from "./replay.ts";
import { json, mockFetch, recordedJson } from "./support.ts";

type Body = Record<string, unknown>;
type Handler = Parameters<typeof mockFetch>[number];

const ODA = await recordedJson<Body>("search-oda-deu-ken.json");
const DEBT = await recordedJson<Body>("search-debt-stock-ken.json");
const CONSTANT = await recordedJson<Body>("probe-resubmit-unit-constant.json");
const CONSTANT_REQUEST = await recordedJson<Body>("probe-resubmit-unit-constant.request.json");
const RATE_GAP = await recordedJson<Body>("probe-resubmit-unit-rate-gap.json");
const RATE_GAP_REQUEST = await recordedJson<Body>("probe-resubmit-unit-rate-gap.request.json");
const RECIPE_REFUSED = await recordedJson<{
  status: number;
  headers: Record<string, string>;
  body: Body;
}>("probe-resubmit-unit-recipe-refused.json");
const RECIPE_REFUSED_REQUEST = await recordedJson<Body>(
  "probe-resubmit-unit-recipe-refused.request.json",
);

const EUR_2022 = { currency: "EUR", priceBasis: "constant", baseYear: 2022 } as const;

/** The first part's spec of a recorded reply. */
const partSpec = (body: Body, index = 0): Spec => (body["parts"] as { spec: Spec }[])[index]!.spec;

const CONVERTED = partSpec(CONSTANT);
const CONVERTED_SENTENCE = String(CONVERTED.resolved?.["rendered_sentence"]);

/** An answer over a transport that answers `handlers` in turn, whose fetch hands the members it
 *  would build to `built` and returns `dataset`. */
function answerOver(body: Body, handlers: Handler[], dataset: Partial<Dataset> = { warnings: [] }) {
  const { fetch, seen } = mockFetch(...handlers);
  const warnings: DfoWarning[] = [];
  const { transport } = replay(NO_EXCHANGES, {
    fetch,
    onWarning: (warning) => warnings.push(warning),
  });
  const built: { members: readonly MemberRequest[]; options: FetchMembersOptions }[] = [];
  const answer = answerFromBody(
    structuredClone(body),
    {
      transport,
      // The recorded answer's own warning, that Search dropped "bilateral", is not the
      // conversion's.
      onWarning: () => undefined,
      fetchMembers: (_, members, options) => {
        built.push({ members, options });
        return Promise.resolve(dataset as Dataset);
      },
    },
    "bilateral ODA from Germany to Kenya 2015 to 2022",
  );
  return { answer, seen, warnings, built };
}

const posted = (seen: readonly { body: string | undefined }[], index = 0): unknown =>
  JSON.parse(seen[index]!.body!);

/** The error a promise rejects with; the test fails when it resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return assert.fail("the call resolved");
}

describe("a spec's conversion offer", () => {
  const answer = (body: Body): Answer =>
    answerFromBody(structuredClone(body), { transport: replay(NO_EXCHANGES).transport }, null);

  test("lists each currency with its years and base years", () => {
    const offer = unitConversion(answer(ODA).specs[0]!);
    assert.ok(offer);
    const served = (ODA["parts"] as { spec: Spec }[])[0]!.spec.resolved!["unit_conversion"] as {
      currencies: { code: string }[];
      default_base_year: number;
    };
    assert.deepEqual(
      offer.currencies.map((currency) => currency.code),
      served.currencies.map((currency) => currency.code),
    );
    assert.equal(offer.defaultBaseYear, served.default_base_year);
    const eur = offer.currencies.find((currency) => currency.code === "EUR");
    assert.ok(eur);
    assert.equal(eur.noun, "euros");
    assert.deepEqual(eur.constantYears, [2015, 2022]);
    assert.deepEqual(eur.currentYears, [2015, 2022]);
    assert.ok(eur.baseYears !== null && eur.baseYears[0] <= 2022 && eur.baseYears[1] >= 2022);
    // A currency whose rates stop early shows the years it converts.
    const aed = offer.currencies.find((currency) => currency.code === "AED");
    assert.ok(aed);
    assert.deepEqual(aed.currentYears, [2015, 2021]);
    assert.deepEqual(aed.baseYears, [2023, 2023]);
    assert.ok(Object.isFrozen(offer) && Object.isFrozen(offer.currencies) && Object.isFrozen(eur));
  });

  test("survives the answer's JSON", () => {
    const { transport } = replay(NO_EXCHANGES);
    const client = clientOver(transport);
    const read = Answer.fromJSON(JSON.stringify(answer(ODA)), client);
    assert.deepEqual(unitConversion(read.specs[0]!), unitConversion(answer(ODA).specs[0]!));
  });

  test("is null for a series that converts to no currency", () => {
    assert.equal(unitConversion(answer(DEBT).specs[0]!), null);
  });

  test("is null for a spec with no Search reading", () => {
    const { spec_id, definition } = answer(ODA).specs[0]!;
    assert.equal(unitConversion({ spec_id, definition }), null);
  });

  for (const [name, edit, pointer] of [
    ["currencies not a list", (offer: Body) => (offer["currencies"] = {}), "/currencies"],
    [
      "a default base year that is not a year",
      (offer: Body) => (offer["default_base_year"] = "2022"),
      "/default_base_year",
    ],
    [
      "a base year range missing its end",
      (offer: Body) => ((offer["currencies"] as Body[])[0]!["base_year_max"] = null),
      "/currencies/0/base_year_max",
    ],
    [
      "a year range that is not an object",
      (offer: Body) => ((offer["currencies"] as Body[])[0]!["constant_years"] = [2015, 2022]),
      "/currencies/0/constant_years",
    ],
  ] as const) {
    test(`with ${name} raises ContractError`, () => {
      const spec = structuredClone(partSpec(ODA));
      edit(spec.resolved!["unit_conversion"] as Body);
      assert.throws(() => unitConversion(spec), {
        name: "ContractError",
        code: "contract_violation",
        pointer: `/resolved/unit_conversion${pointer}`,
      });
    });
  }
});

describe("an answer fetched in another unit", () => {
  test("posts the recorded resubmit and builds the converted reading", async () => {
    const { answer, seen, built } = answerOver(ODA, [json(CONSTANT)]);
    await answer.fetch(EUR_2022);
    assert.equal(seen.length, 1);
    assert.match(seen[0]!.url, /\/search\/resolve$/);
    assert.deepEqual(posted(seen), CONSTANT_REQUEST);
    const member = built[0]!.members[0]!;
    assert.deepEqual(member.parts, ["bilateral ODA"]);
    assert.equal(member.spec.spec_id, CONVERTED.spec_id);
    assert.equal(member.sentence, CONVERTED_SENTENCE);
    assert.match(CONVERTED_SENTENCE, /Constant 2022 euros/);
  });

  test("in current prices posts no base year", async () => {
    const reply = structuredClone(CONSTANT);
    const unit = unitOf(partSpec(reply));
    // An echo that states the absent base year as null holds the same request.
    unit["request"] = { currency: "EUR", prices: "current", base_year: null };
    const { answer, seen } = answerOver(ODA, [json(reply)]);
    await answer.fetch({ currency: "EUR" });
    const request = structuredClone(CONSTANT_REQUEST);
    const entry = (request["input"] as { entries: { identity: Spec["definition"] }[] }).entries[0]!;
    unitOf({ spec_id: "", definition: { identity: entry.identity } })["request"] = {
      currency: "EUR",
      prices: "current",
    };
    assert.deepEqual(posted(seen), request);
  });

  for (const partial of [false, true]) {
    test(`refuses a base year the tables do not cover${partial ? ", under partial" : ""}`, async () => {
      const { answer, seen, built } = answerOver(ODA, [json(RATE_GAP)]);
      const error = await rejection(answer.fetch({ ...EUR_2022, baseYear: 1900, partial }));
      assert.deepEqual(posted(seen), RATE_GAP_REQUEST);
      assert.ok(error instanceof InvalidRequestError);
      assert.equal(error.code, "rate_coverage_gap");
      assert.equal(error.traceId, "80ed7b982e2d4f14be30e26fd94c5328");
      assert.deepEqual((error.problem?.["cause"] as Body)["entities"], ["CurrencyEUR@1900"]);
      assert.match(error.detail, /"bilateral ODA"/);
      assert.match(error.detail, /CurrencyEUR@1900/);
      assert.doesNotMatch(error.detail, /narrow first/);
      assert.equal(built.length, 0);
    });
  }

  test("refused under a narrowing hints at converting after it", async () => {
    const { answer } = answerOver(ODA, [json(RATE_GAP)]);
    const error = await rejection(
      answer.fetch({ ...EUR_2022, baseYear: 1900, window: [2016, 2020] }),
    );
    assert.ok(error instanceof InvalidRequestError);
    assert.match(error.detail, /narrow first and convert ds\.members\[0\]\.spec/);
  });

  test("refuses a series no recipe converts as the server does", async () => {
    const { status, headers, body } = RECIPE_REFUSED;
    const { answer, seen, built } = answerOver(DEBT, [json(body, status, headers)]);
    const error = await rejection(answer.fetch({ currency: "EUR" }));
    assert.deepEqual(posted(seen), RECIPE_REFUSED_REQUEST);
    assert.ok(error instanceof InvalidRequestError);
    assert.equal(error.code, "recipe_not_declared");
    assert.equal(built.length, 0);
  });

  const mismatched: [string, (reply: Body) => void, string][] = [
    [
      "a spec that does not hold the request",
      (reply) => (unitOf(partSpec(reply))["request"] = { currency: "EUR", prices: "current" }),
      "contract_violation",
    ],
    [
      "another number of parts",
      (reply) => (reply["parts"] as unknown[]).push((reply["parts"] as unknown[])[0]),
      "contract_violation",
    ],
    [
      "a candidates part",
      (reply) => {
        const part = (reply["parts"] as Body[])[0]!;
        part["status"] = "candidates";
        part["candidates"] = { specs: [] };
      },
      "contract_violation",
    ],
  ];
  for (const [name, edit, code] of mismatched) {
    test(`raises ContractError on a reply with ${name}`, async () => {
      const reply = structuredClone(CONSTANT);
      edit(reply);
      const { answer, built } = answerOver(ODA, [json(reply)]);
      const error = await rejection(answer.fetch(EUR_2022));
      assert.ok(error instanceof ContractError, String(error));
      assert.equal(error.code, code);
      assert.equal(built.length, 0);
    });
  }

  test("raises a no_data reason the contract does not know as the base DfoError", async () => {
    const reply = structuredClone(RATE_GAP);
    ((reply["parts"] as Body[])[0]!["no_data"] as Body)["reason"] = "brand_new_reason";
    const { answer } = answerOver(ODA, [json(reply)]);
    const error = await rejection(answer.fetch(EUR_2022));
    assert.ok(error instanceof DfoError);
    assert.equal(error.constructor, DfoError);
    assert.equal(error.code, "brand_new_reason");
    assert.equal(error.status, 200);
    assert.equal(error.traceId, "80ed7b982e2d4f14be30e26fd94c5328");
    assert.deepEqual((error.problem?.["cause"] as Body)["entities"], ["CurrencyEUR@1900"]);
    assert.match(error.detail, /Missing: CurrencyEUR@1900/);
  });
});

/** The constant-price reply with Search's warning that constant prices left rows out. */
function withWarning(reply: Body): Body {
  const warned = structuredClone(reply);
  (warned["parts"] as Body[])[0]!["warnings"] = [
    {
      code: "deflator_missing_omitted",
      severity: "warn",
      message: "A constant-price conversion left out rows of 1 entity.",
    },
  ];
  return warned;
}

function unitOf(spec: Spec): Body {
  const identity = spec.definition["identity"] as { facets: Body };
  return identity.facets["unit"] as Body;
}

describe("conversion arguments", () => {
  const transport = replay(NO_EXCHANGES).transport;
  const spec = partSpec(ODA);
  const answer = answerFromBody(structuredClone(ODA), { transport }, null);
  const rows: [string, Body, RegExp][] = [
    ["priceBasis without currency", { priceBasis: "constant" }, /go with currency/],
    ["baseYear without currency", { baseYear: 2022 }, /go with currency/],
    ["a currency in lower case", { currency: "eur" }, /ISO 4217 code in capitals/],
    ["a currency of four letters", { currency: "EURO" }, /ISO 4217 code in capitals/],
    ["a currency that is a number", { currency: 978 }, /ISO 4217 code in capitals/],
    ["an unknown price basis", { currency: "EUR", priceBasis: "real" }, /"current" or "constant"/],
    [
      "constant prices without a base year",
      { currency: "EUR", priceBasis: "constant" },
      /defaultBaseYear/,
    ],
    [
      "current prices with a base year",
      { currency: "EUR", priceBasis: "current", baseYear: 2022 },
      /current prices are each year's own/,
    ],
    ["a base year with no price basis", { currency: "EUR", baseYear: 2022 }, /each year's own/],
    ["a base year that is not an integer", { ...EUR_2022, baseYear: 2022.5 }, /baseYear is a year/],
    ["a base year that is a boolean", { ...EUR_2022, baseYear: true }, /baseYear is a year/],
    ["a base year in a string", { ...EUR_2022, baseYear: "2022" }, /baseYear is a year/],
    [
      "facets binding the unit beside currency",
      { currency: "EUR", facets: { unit: "USDollar" } },
      /facets\.unit and currency both set the unit/,
    ],
  ];
  for (const [name, options, refusal] of rows) {
    test(`refuse ${name} before any request, from client.fetch and answer.fetch`, async () => {
      for (const call of [
        () => clientOver(transport).fetch(spec, options),
        () => answer.fetch(options),
      ]) {
        const error = await rejection(call());
        assert.ok(error instanceof InvalidRequestError);
        assert.equal(error.code, "invalid_argument");
        assert.match(error.detail, refusal);
      }
    });
  }

  const targets: [string, () => Promise<unknown>, RegExp][] = [
    [
      "a ref",
      async () => DatasetRef.fromJSON(stepOf(await scenario("fetch-ref"), 0, "fetch").ref),
      /^A ref fetch reads the versions it names and takes no currency, priceBasis/,
    ],
    [
      "a share",
      () => Promise.resolve("https://site.example/s/lBm1RKBw"),
      /^A share fetch .* takes no currency/,
    ],
    [
      "a recipe",
      () => Promise.resolve(recipe(spec).rank({ by: "destination" })),
      /^A recipe or a frame DFO computed takes no currency/,
    ],
  ];
  for (const [name, target, refusal] of targets) {
    test(`refuse a conversion of ${name} before any request`, async () => {
      const error = await rejection(fetchDataset(transport, (await target()) as never, EUR_2022));
      assert.ok(error instanceof InvalidRequestError);
      assert.equal(error.code, "invalid_argument");
      assert.match(error.detail, refusal);
    });
  }

  test("are taken by the options registries", async () => {
    // An unknown key is refused naming the nearest, so a misspelt option finds these.
    for (const call of [
      () => clientOver(transport).fetch(spec, { curency: "EUR" } as never),
      () => answer.fetch({ price_basis: "constant" } as never),
    ]) {
      const error = await rejection(call());
      assert.ok(error instanceof InvalidRequestError);
      assert.match(error.detail, /did you mean "(currency|priceBasis)"\?/);
    }
  });
});

/**
 * A replay of the conversion and then a build: the resubmit posts `request` and Search answers
 * the constant-price reading, whose build and download are answer-definite-fetch's with the
 * converted spec in place of its own.
 */
async function convertedBuild(request: Body): Promise<Scenario> {
  const base = await scenario("answer-definite-fetch");
  const [, build, ...download] = structuredClone(base.exchanges);
  const definition = CONVERTED.definition;
  build!.request.json = {
    input: { kind: "spec_id", spec_id: CONVERTED.spec_id, definition },
  };
  (build!.response.json as Body)["definition"] = definition;
  const resubmit: Exchange = {
    request: { method: "POST", path: "/search/resolve", json: request },
    response: { status: 200, headers: { "content-type": "application/json" }, json: CONSTANT },
  };
  return {
    ...base,
    name: "converted-build",
    origin: { kind: "synthetic", derived_from: base.name },
    exchanges: [resubmit, build!, ...download],
  };
}

/**
 * An answer to the recorded question whose fetch replays `convertedBuild` with `reply` as the
 * conversion's answer and `manifest` edited, recording the warnings issued. The answer's own
 * warnings are dropped. A `scoped` build posts a scope, so its request body is not checked.
 */
async function convertedRun(reply: Body, manifest?: (manifest: Body) => void, scoped = false) {
  const record = await convertedBuild(CONSTANT_REQUEST);
  record.exchanges[0]!.response.json = reply;
  const build = record.exchanges[1]!;
  manifest?.(build.response.json as Body);
  if (scoped) delete build.request.json;
  const warnings: DfoWarning[] = [];
  const { transport, remaining } = replay(record, {
    onWarning: (warning) => warnings.push(warning),
  });
  const quiet = structuredClone(ODA);
  (quiet["parts"] as Body[])[0]!["warnings"] = [];
  const answer = answerFromBody(quiet, { transport }, null);
  return { answer, warnings, remaining };
}

describe("a converted fetch", () => {
  test("of an answer builds the converted spec under its sentence", async () => {
    const { transport, remaining } = replay(await convertedBuild(CONSTANT_REQUEST));
    const answer = answerFromBody(structuredClone(ODA), { transport }, null);
    const dataset = await answer.fetch(EUR_2022);
    assert.deepEqual(remaining(), []);
    assert.equal(dataset.members[0]!.spec.spec_id, CONVERTED.spec_id);
    assert.equal(dataset.members[0]!.sentence, CONVERTED_SENTENCE);
    assert.equal(dataset.ref.members[0]!.spec.spec_id, CONVERTED.spec_id);
  });

  test("narrowed, issues Search's warnings about the built reading, not the held one", async () => {
    const record = await convertedBuild(CONSTANT_REQUEST);
    // The held reading's reply warns; the narrowed build is another spec, whose sentence
    // resubmit warns about its own years.
    record.exchanges[0]!.response.json = withWarning(CONSTANT);
    const narrowedId = `spec_${"1".repeat(32)}`;
    const narrowed = { ...CONVERTED.definition, spec_id: narrowedId };
    const build = record.exchanges[1]!;
    delete build.request.json;
    (build.response.json as Body)["definition"] = narrowed;
    const sentence = structuredClone(CONSTANT);
    const part = (sentence["parts"] as Body[])[0]!;
    part["spec"] = { ...CONVERTED, spec_id: narrowedId, definition: narrowed };
    part["warnings"] = [
      { code: "date_coverage_partial", severity: "warn", message: "The years stop in 2020." },
    ];
    record.exchanges.splice(2, 0, {
      request: { method: "POST", path: "/search/resolve" },
      response: { status: 200, headers: { "content-type": "application/json" }, json: sentence },
    });
    const warnings: DfoWarning[] = [];
    const { transport, remaining } = replay(record, {
      onWarning: (warning) => warnings.push(warning),
    });
    const answer = answerFromBody(
      structuredClone(ODA),
      { transport, onWarning: () => undefined },
      null,
    );
    const dataset = await answer.fetch({ ...EUR_2022, window: [2015, 2020] });
    assert.deepEqual(remaining(), []);
    assert.equal(dataset.members[0]!.spec.spec_id, narrowedId);
    assert.deepEqual(
      warnings.map((warning) => [warning.constructor, warning.code]),
      [[SearchWarning, "date_coverage_partial"]],
    );
  });

  test("issues Search's warnings about the converted reading once it is built", async () => {
    const warned = withWarning(CONSTANT);
    const part = (warned["parts"] as Body[])[0]!;
    // The same code twice, and an info warning, issue one warning.
    part["warnings"] = [
      ...(part["warnings"] as Body[]),
      ...(part["warnings"] as Body[]),
      { code: "unit_converted", severity: "info", message: "Converted." },
    ];
    const run = await convertedRun(warned);
    await run.answer.fetch(EUR_2022);
    assert.deepEqual(run.remaining(), []);
    assert.deepEqual(
      run.warnings.map((warning) => [warning.constructor, warning.code]),
      [[SearchWarning, "deflator_missing_omitted"]],
    );
    assert.equal(run.warnings[0]!.traceId, "45509ade64444e089de0ad9e04d41113");
    assert.match(
      run.warnings[0]!.message,
      /^Converting "bilateral ODA" to EUR at constant 2022 prices: A constant-price/,
    );
  });

  test("skips a warning the member's manifest already issued", async () => {
    const run = await convertedRun(withWarning(CONSTANT), (manifest) => {
      manifest["warnings"] = [
        { code: "deflator_missing_omitted", severity: "warn", message: "Rows left out." },
      ];
    });
    await run.answer.fetch(EUR_2022);
    assert.deepEqual(
      run.warnings.map((warning) => [warning.constructor, warning.code]),
      [[DataWarning, "deflator_missing_omitted"]],
    );
  });

  for (const window of [undefined, [2015, 2022] as const]) {
    const narrowing = window === undefined ? "" : ", narrowed to its own spec";
    test(`raises Search's warning under strict once built${narrowing}`, async () => {
      const run = await convertedRun(withWarning(CONSTANT), undefined, window !== undefined);
      const error = await rejection(
        run.answer.fetch({ ...EUR_2022, strict: true, ...(window ? { window } : {}) }),
      );
      assert.deepEqual(run.remaining(), []);
      assert.ok(error instanceof SearchWarning, String(error));
      assert.equal(error.code, "deflator_missing_omitted");
    });
  }

  test("carries the converted part's departures", async () => {
    const reply = structuredClone(CONSTANT);
    const departure = { code: "year_unavailable", binding_ref: "unit:", text: "Rates stop." };
    (reply["parts"] as Body[])[0]!["departures"] = [departure];
    const run = await convertedRun(reply);
    const dataset = await run.answer.fetch(EUR_2022);
    assert.deepEqual(dataset.departures, [departure]);
  });

  test("of a spec names no part and builds the converted spec", async () => {
    const request = structuredClone(CONSTANT_REQUEST);
    (request["input"] as { entries: Body[] }).entries[0]!["variable_text"] = "dataset";
    const { transport, remaining } = replay(await convertedBuild(request));
    const dataset = await clientOver(transport).fetch(partSpec(ODA), EUR_2022);
    assert.deepEqual(remaining(), []);
    assert.equal(dataset.members[0]!.sentence, CONVERTED_SENTENCE);
  });
});
