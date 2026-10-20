import assert from "node:assert/strict";
import { test } from "node:test";

import { ContractError } from "../src/errors.ts";
import { checkStrict } from "../src/strict.ts";
import { contractJson } from "./support.ts";

type Scenario = { exchanges: { response: { json?: Record<string, unknown> } }[] };

const recorded = async (name: string): Promise<Record<string, unknown>> => {
  const scenario = await contractJson<Scenario>(`scenarios/${name}.json`);
  const body = scenario.exchanges[0]?.response.json;
  assert.ok(body !== undefined);
  return body;
};

const violation = (pointer: string) => (error: unknown) =>
  error instanceof ContractError &&
  error.code === "contract_violation" &&
  error.problem === null &&
  error.pointer === pointer;

test("recorded manifests and resolutions pass the strict checks", async () => {
  checkStrict("Manifest", await recorded("fetch-spec-known-sentence"));
  checkStrict("Resolution", await recorded("search-place-ambiguous"));
});

test("a manifest missing an artifact's url raises ContractError naming it", async () => {
  const manifest = structuredClone(await recorded("fetch-spec-known-sentence"));
  const [artifact] = manifest["artifacts"] as Record<string, unknown>[];
  delete artifact!["url"];
  assert.throws(() => {
    checkStrict("Manifest", manifest);
  }, violation("/artifacts/0/url"));
});

test("a renamed or null strict field raises ContractError", async () => {
  const manifest = structuredClone(await recorded("fetch-spec-known-sentence"));
  manifest["contentVersion"] = manifest["content_version"];
  delete manifest["content_version"];
  assert.throws(() => {
    checkStrict("Manifest", manifest);
  }, violation("/content_version"));

  const nulled = structuredClone(await recorded("fetch-spec-known-sentence"));
  (nulled["definition"] as Record<string, unknown>)["spec_id"] = null;
  assert.throws(() => {
    checkStrict("Manifest", nulled);
  }, violation("/definition/spec_id"));
});

test("a part checks against its status's schema, and an unknown status passes", async () => {
  const resolution = structuredClone(await recorded("search-place-ambiguous"));
  const parts = resolution["parts"] as Record<string, unknown>[];
  delete parts[0]!["no_data"];
  assert.throws(() => {
    checkStrict("Resolution", resolution);
  }, violation("/parts/0/no_data"));

  parts[0]!["status"] = "status_from_a_newer_server";
  checkStrict("Resolution", resolution);
});

test("an operation without a status raises ContractError", () => {
  assert.throws(() => {
    checkStrict("OperationResource", { operation: { operation_id: "op_1" } });
  }, violation("/operation/status"));
});
