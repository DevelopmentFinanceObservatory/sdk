import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { envFrom } from "../src/env.ts";
import { fetchDataset, fetchMembers, mint } from "../src/fetch.ts";
import type { FetchOptions, SpecInput } from "../src/fetch.ts";
import { DatasetRef } from "../src/ref.ts";
import type { SpecLike } from "../src/ref.ts";
import { Transport } from "../src/transport.ts";
import { DataWarning } from "../src/warnings.ts";
import type { DfoWarning } from "../src/warnings.ts";
import { NO_EXCHANGES, replay, scenario, stepOf } from "./replay.ts";
import { contractJson, json, mockFetch, problem } from "./support.ts";

describe("a fetched spec's ref", () => {
  test("is the contract's ref for that member", async () => {
    const record = await scenario("fetch-spec-known-sentence");
    const { spec } = stepOf(record, 0, "fetch");
    assert.ok(spec);
    const dataset = await fetchDataset(replay(record).transport, spec);
    const { ref } = await contractJson<{ ref: unknown }>("refs/ref-one-member.json");
    assert.deepEqual(JSON.parse(JSON.stringify(dataset.ref)), ref);
  });
});

describe("a manifest's warnings", () => {
  test("reach the warning handler, or raise the first under strict", async () => {
    const record = await scenario("fetch-spec-known-sentence");
    const { spec } = stepOf(record, 0, "fetch");
    assert.ok(spec);
    const seen: DfoWarning[] = [];
    await fetchDataset(
      replay(record, { onWarning: (warning) => seen.push(warning) }).transport,
      spec,
    );
    assert.deepEqual(
      seen.map((warning) => warning.code),
      ["coverage_below_scope"],
    );
    assert.ok(seen.every((warning) => warning instanceof DataWarning));
    await assert.rejects(fetchDataset(replay(record).transport, spec, { strict: true }), {
      name: "DataWarning",
      code: "coverage_below_scope",
      severity: "warn",
    });
  });
});

describe("arguments a fetch refuses before any request", () => {
  const { transport } = replay(NO_EXCHANGES);
  const spec = (id: string): SpecLike => ({ spec_id: id, definition: { spec_id: id } });

  test("the frame layout with several members", async () => {
    await assert.rejects(
      fetchMembers(
        transport,
        [
          { parts: ["a"], spec: spec("spec_1") },
          { parts: ["b"], spec: spec("spec_2") },
        ],
        { layout: "frame" },
      ),
      { name: "InvalidRequestError", code: "invalid_argument" },
    );
  });

  test("a narrowed ref", async () => {
    const record = await scenario("fetch-ref");
    const ref = DatasetRef.fromJSON(stepOf(record, 0, "fetch").ref);
    await assert.rejects(fetchDataset(transport, ref, { window: [2020, 2021] }), {
      name: "InvalidRequestError",
    });
  });

  test("a window that is not a pair of years", async () => {
    await assert.rejects(fetchDataset(transport, spec("spec_1"), { window: [2020.5, 2021] }), {
      name: "InvalidRequestError",
    });
  });
});

// The build answers the narrowed definition; the resubmit for its sentence is refused, so each
// row reads the scope the build posted and the groups the resubmit carried.
const grouped = await scenario("fetch-spec-group-origin-rebound");

describe("a fetch's entities", () => {
  const manifest = grouped.exchanges[0]!.response.json as Record<string, unknown>;
  const definitionWith = (entities: Record<string, readonly string[]>): Record<string, unknown> => {
    const definition = manifest["definition"] as Record<string, unknown>;
    const identity = definition["identity"] as Record<string, unknown>;
    return { ...definition, identity: { ...identity, entities } };
  };
  const bound = { origin: ["country/DEU"], destination: ["country/NGA", "country/GHA"] };
  const EU = { label: "European Union", group_id: "groups/EU" };
  const WEST = { label: "West Africa", group_id: "groups/WestAfrica" };
  const definition = definitionWith(bound);
  const spec: SpecInput = {
    spec_id: String(definition["spec_id"]),
    definition,
    entity_groups: { origin: EU, destination: WEST },
  };
  const rows: [string, FetchOptions, Record<string, unknown>, unknown][] = [
    [
      "replace only the role named",
      { entities: { origin: ["country/FRA"] } },
      { entities: { origin: ["country/FRA"], destination: bound.destination } },
      { destination: WEST },
    ],
    [
      "drop a role bound to null",
      { entities: { origin: null } },
      { entities: { destination: bound.destination } },
      { destination: WEST },
    ],
    [
      "keep a role rebound to its entities in another order",
      { entities: { destination: ["country/GHA", "country/NGA"] } },
      { entities: { origin: bound.origin, destination: ["country/GHA", "country/NGA"] } },
      { origin: EU, destination: WEST },
    ],
    [
      "rebind every grouped role",
      { entities: { origin: ["country/FRA"], destination: ["country/GHA"] } },
      { entities: { origin: ["country/FRA"], destination: ["country/GHA"] } },
      undefined,
    ],
    [
      "post no entities when none are given",
      { window: "latest" },
      { window: { kind: "latest" } },
      { origin: EU, destination: WEST },
    ],
  ];
  for (const [name, options, scope, groups] of rows) {
    test(name, async () => {
      const entities = (scope["entities"] ?? bound) as Record<string, readonly string[]>;
      const { fetch, seen } = mockFetch(
        json({ ...manifest, definition: definitionWith(entities) }),
        problem({ code: "request_invalid", status: 400 }),
      );
      const transport = new Transport({
        baseUrl: "https://api.example/api",
        apiKey: false,
        env: envFrom({}),
        readCredentialsFile: () => Promise.resolve(null),
        fetch,
        onWarning: () => undefined,
      });
      await assert.rejects(fetchDataset(transport, spec, options), { code: "request_invalid" });
      const posted = JSON.parse(seen[0]!.body!) as { input: { scope: unknown } };
      assert.deepEqual(posted.input.scope, scope);
      const resubmit = JSON.parse(seen[1]!.body!) as {
        input: { entries: { entity_groups?: unknown }[] };
      };
      assert.deepEqual(resubmit.input.entries[0]!.entity_groups, groups);
    });
  }
});

describe("a mint", () => {
  test("takes no narrowing", () => {
    const spec: SpecLike = { spec_id: "spec_1", definition: { spec_id: "spec_1" } };
    const { transport } = replay(NO_EXCHANGES);
    // Only checked by the type checker: the call never runs.
    const check = () => {
      // @ts-expect-error -- a mint builds the spec as it stands; a fetch narrows it.
      void mint(transport, spec, { window: [2020, 2023] });
      // @ts-expect-error -- a mint builds the spec as it stands; a fetch narrows it.
      void mint(transport, spec, { entities: { origin: ["country/FRA"] } });
      // @ts-expect-error -- a mint builds the spec as it stands; a fetch narrows it.
      void mint(transport, spec, { facets: { unit: null } });
    };
    assert.equal(typeof check, "function");
  });
});
