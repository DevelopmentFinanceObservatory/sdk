import assert from "node:assert/strict";
import { test } from "node:test";

import { ContractError } from "../src/core/errors.ts";
import { checkStrict } from "../src/core/strict.ts";
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

test("a nested spec the client never reads passes without its strict fields", async () => {
  const definite = structuredClone(await recorded("answer-definite-fetch"));
  const [part] = definite["parts"] as { spec: { resolved: Record<string, unknown> } }[];
  const [alternative] = part!.spec.resolved["alternative_measures"] as {
    definition: Record<string, unknown>;
  }[];
  delete alternative!.definition["spec_id"];
  checkStrict("Resolution", definite);

  const folded = structuredClone(await recorded("answer-several-readings-folded"));
  const gdp = (folded["parts"] as { spec: { resolved: Record<string, unknown> } }[])[2]!;
  const [reading] = gdp.spec.resolved["equivalent_readings"] as Record<string, unknown>[];
  delete reading!["definition"];
  checkStrict("Resolution", folded);
});

test("an operation without a status raises ContractError", () => {
  assert.throws(() => {
    checkStrict("OperationResource", { operation: { operation_id: "op_1" } });
  }, violation("/operation/status"));
});

type Edit = (body: Record<string, unknown>) => void;
const first = (body: Record<string, unknown>, member: string): Record<string, unknown> =>
  (body[member] as Record<string, unknown>[])[0]!;
const wrongTypes: [string, "Manifest" | "Resolution", string, Edit, string][] = [
  [
    "a numeric spec_id",
    "Manifest",
    "fetch-spec-known-sentence",
    (b) => ((b["definition"] as Record<string, unknown>)["spec_id"] = 7),
    "/definition/spec_id",
  ],
  [
    "a boolean schema_version",
    "Manifest",
    "fetch-spec-known-sentence",
    (b) => ((b["definition"] as Record<string, unknown>)["schema_version"] = true),
    "/definition/schema_version",
  ],
  [
    "a fractional schema_version",
    "Manifest",
    "fetch-spec-known-sentence",
    (b) => ((b["definition"] as Record<string, unknown>)["schema_version"] = 1.5),
    "/definition/schema_version",
  ],
  [
    "a non-string artifact_digest",
    "Manifest",
    "fetch-spec-known-sentence",
    (b) => (first(b, "artifacts")["artifact_digest"] = {}),
    "/artifacts/0/artifact_digest",
  ],
  [
    "a non-string url",
    "Manifest",
    "fetch-spec-known-sentence",
    (b) => (first(b, "artifacts")["url"] = ["/x"]),
    "/artifacts/0/url",
  ],
  [
    "artifacts that is not an array",
    "Manifest",
    "fetch-spec-known-sentence",
    (b) => (b["artifacts"] = {}),
    "/artifacts",
  ],
  [
    "an artifact that is not an object",
    "Manifest",
    "fetch-spec-known-sentence",
    (b) => ((b["artifacts"] as unknown[])[0] = "x"),
    "/artifacts/0",
  ],
  [
    "a string resolved",
    "Resolution",
    "answer-definite-fetch",
    (b) => ((first(b, "parts")["spec"] as Record<string, unknown>)["resolved"] = "x"),
    "/parts/0/spec/resolved",
  ],
  [
    "a string identity",
    "Resolution",
    "answer-definite-fetch",
    (b) =>
      ((
        (first(b, "parts")["spec"] as Record<string, unknown>)["definition"] as Record<
          string,
          unknown
        >
      )["identity"] = "x"),
    "/parts/0/spec/definition/identity",
  ],
  [
    "parts that is not an array",
    "Resolution",
    "answer-definite-fetch",
    (b) => (b["parts"] = {}),
    "/parts",
  ],
  [
    "candidates.specs that is not an array",
    "Resolution",
    "answer-candidates-choose-fetch",
    (b) => ((first(b, "parts")["candidates"] as Record<string, unknown>)["specs"] = {}),
    "/parts/0/candidates/specs",
  ],
];
for (const [name, schema, scenario, edit, pointer] of wrongTypes) {
  test(`${name} raises ContractError at ${pointer}`, async () => {
    const body = structuredClone(await recorded(scenario));
    checkStrict(schema, body);
    edit(body);
    assert.throws(() => {
      checkStrict(schema, body);
    }, violation(pointer));
  });
}
