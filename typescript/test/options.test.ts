import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { Client, clientOver } from "../src/client.ts";
import type { ClientOptions } from "../src/client.ts";
import { declareOptions } from "../src/core/options.ts";
import type { FetchOptions } from "../src/datasets/fetch.ts";
import { answerFromBody } from "../src/search/answer.ts";
import type { Answer } from "../src/search/answer.ts";
import { NO_EXCHANGES, replay, scenarios } from "./replay.ts";

// Each options type's key literal is held to the type by the compiler: a key the type has and
// the literal lacks, or one the literal names and the type lacks, fails the typecheck.
export const typeChecks = (): unknown[] => [
  // @ts-expect-error -- the literal lacks `kinds`, `codeSystem` and `expandMembers`.
  declareOptions<{ kinds?: string; codeSystem?: string; expandMembers?: boolean }>("x", {}),
  declareOptions<Pick<ClientOptions, "timeout">>("x", {
    timeout: true,
    // @ts-expect-error -- `retries` is not a key of the type.
    retries: true,
  }),
  declareOptions<Pick<FetchOptions, "window">>("x", { window: true }),
];

const records = new Map((await scenarios()).map((scenario) => [scenario.name, scenario]));
const answerOf = (name: string): Answer =>
  answerFromBody(
    structuredClone(records.get(name)!.exchanges[0]!.response.json),
    { transport: replay(NO_EXCHANGES).transport },
    null,
  );

const spec = { spec_id: "spec_1", definition: { spec_id: "spec_1" } };

describe("an options key a call does not take", () => {
  const client = clientOver(replay(NO_EXCHANGES).transport);
  const definite = answerOf("answer-definite-fetch");
  const choosing = answerOf("choose-place-one-part");
  // Each row calls with one key the call does not take, and the key the refusal suggests.
  const rows: [string, () => unknown, string][] = [
    ["client.fetch", () => client.fetch(spec, { windw: [2020, 2021] } as FetchOptions), "window"],
    [
      "client.fetch, in the Python spelling",
      () => client.fetch(spec, { party_totals: true } as FetchOptions),
      "partyTotals",
    ],
    [
      "client.fetch, in the old wire spelling",
      () => client.fetch(spec, { without_party_totals: true } as FetchOptions),
      "partyTotals",
    ],
    [
      "client.fetch, in the old spelling",
      () => client.fetch(spec, { withoutPartyTotals: true } as FetchOptions),
      "partyTotals",
    ],
    [
      "answer.fetch, in the old spelling",
      () => definite.fetch({ withoutPartyTotals: true } as never),
      "partyTotals",
    ],
    ["answer.fetch", () => definite.fetch({ partal: true } as never), "partial"],
    ["answer.choose", () => choosing.choose(0, { prat: 0 } as never), "part"],
    ["client.search", () => client.search("aid", { timout: 5 } as never), "timeout"],
    ["new Client", () => new Client({ base_url: "https://a.example" } as never), "baseUrl"],
    ["client.withOptions", () => client.withOptions({ max_retries: 1 } as never), "maxRetries"],
    ["client.request", () => client.request("GET", "/x", { param: {} } as never), "params"],
    [
      "client.lookup.resolve",
      () => client.lookup.resolve("Kenya", { expand_members: true } as never),
      "expandMembers",
    ],
    [
      "client.lookup.node",
      () => client.lookup.node("country/KEN", { as_of: "x" } as never),
      "asOf",
    ],
    ["client.lookup.code", () => client.lookup.code("not_found", { singal: 1 } as never), "signal"],
    ["client.lookup.catalogue", () => client.lookup.catalogue({ plcae: "x" } as never), "place"],
  ];
  for (const [call, run, suggested] of rows) {
    test(`is refused by ${call}, naming ${suggested}, with no request`, async () => {
      // `new Client` throws; the other calls reject.
      await assert.rejects(Promise.resolve().then(run), {
        name: "InvalidRequestError",
        code: "invalid_argument",
        message: new RegExp(`did you mean "${suggested}"\\?`),
      });
    });
  }

  test("that resembles no key is refused with the keys the call takes", async () => {
    await assert.rejects(client.fetch(spec, { year: 2022 } as FetchOptions), {
      code: "invalid_argument",
      message: /its options are .*\bwindow\b.*\blatest\b/,
    });
  });

  test("is not read from options that are not an object", async () => {
    await assert.rejects(client.fetch(spec, 5 as FetchOptions), { code: "invalid_argument" });
  });
});
