import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { clientOver } from "../src/client.ts";
import { envFrom } from "../src/env.ts";
import { fetchDataset, fetchMembers, mint } from "../src/fetch.ts";
import type { FetchOptions } from "../src/fetch.ts";
import { DatasetRef } from "../src/ref.ts";
import type { SpecLike } from "../src/ref.ts";
import { Transport } from "../src/transport.ts";
import { DataWarning } from "../src/warnings.ts";
import type { Spec } from "../src/wire.ts";
import type { DfoWarning } from "../src/warnings.ts";
import { ServerError } from "../src/errors.ts";
import { NO_EXCHANGES, replay, scenario, stepOf } from "./replay.ts";
import type { Exchange } from "./replay.ts";
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
const answered = await scenario("answer-definite-fetch");

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
  // A wire Spec as Search answers it, passed whole to `client.fetch`: its groups sit under
  // `resolved`, and it holds no sentence, so the fetch resubmits for one.
  const held = (answered.exchanges[0]!.response.json as { parts: { spec: Spec }[] }).parts[0]!.spec;
  const spec: Spec = {
    spec_id: String(definition["spec_id"]),
    definition: definition as Spec["definition"],
    resolved: {
      ...held.resolved,
      rendered_sentence: null,
      entity_groups: { origin: EU, destination: WEST },
    },
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
    [
      "post no entities for a map that names no role",
      { window: "latest", entities: {} },
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
      await assert.rejects(clientOver(transport).fetch(spec, options), {
        code: "request_invalid",
      });
      const posted = JSON.parse(seen[0]!.body!) as { input: { scope: unknown } };
      assert.deepEqual(posted.input.scope, scope);
      const resubmit = JSON.parse(seen[1]!.body!) as {
        input: { entries: { entity_groups?: unknown }[] };
      };
      assert.deepEqual(resubmit.input.entries[0]!.entity_groups, groups);
    });
  }
});

describe("a download", async () => {
  // fetch-ref-signed-url-refused: the snapshot, then the files route and the signed URL, whose
  // first answer is a 403, then both again.
  const refused = await scenario("fetch-ref-signed-url-refused");
  const [, , firstSigned, , secondSigned] = refused.exchanges;
  const forbidden = firstSigned!.response;
  const wrongBytes = { status: 200, json: "not the stored file" };
  const rows: [string, Exchange["response"], Exchange["response"], string][] = [
    ["a signed URL refused twice raises download_failed", forbidden, forbidden, "download_failed"],
    [
      "a refused signed URL and then bytes of another digest raise digest_mismatch",
      forbidden,
      wrongBytes,
      "digest_mismatch",
    ],
    [
      "bytes of another digest twice raise digest_mismatch",
      wrongBytes,
      wrongBytes,
      "digest_mismatch",
    ],
  ];
  for (const [name, first, second, code] of rows) {
    test(`asks the files route twice and waits for nothing: ${name}`, async () => {
      const record = structuredClone(refused);
      record.exchanges[2] = { ...firstSigned!, response: first };
      record.exchanges[4] = { ...secondSigned!, response: second };
      const { transport, waits, remaining } = replay(record);
      const ref = DatasetRef.fromJSON(stepOf(record, 0, "fetch").ref);
      const error = await fetchDataset(transport, ref).catch((e: unknown) => e);
      assert.ok(error instanceof ServerError);
      assert.equal(error.code, code);
      assert.equal(error.retryable, code === "download_failed");
      assert.deepEqual(remaining(), []);
      assert.deepEqual(waits, []);
    });
  }

  test("raises a files route failure after its retries, with no second round", async () => {
    const record = structuredClone(refused);
    const route = record.exchanges[1]!;
    const unavailable = {
      status: 503,
      headers: { "content-type": "application/problem+json" },
      json: {
        type: "/codes/upstream_error",
        title: "Down",
        status: 503,
        code: "upstream_error",
        detail: "Down.",
        retryable: true,
      },
    };
    record.exchanges = [
      record.exchanges[0]!,
      ...[0, 1, 2].map(() => ({ ...route, response: unavailable })),
    ];
    const { transport, waits, remaining } = replay(record);
    const ref = DatasetRef.fromJSON(stepOf(record, 0, "fetch").ref);
    await assert.rejects(fetchDataset(transport, ref), {
      name: "ServerError",
      code: "upstream_error",
    });
    assert.deepEqual(remaining(), []);
    assert.deepEqual(waits, [500, 1000]);
  });

  test("refuses an artifact URL on another host before any download", async () => {
    const record = structuredClone(await scenario("fetch-spec-known-sentence"));
    const manifest = record.exchanges[0]!.response.json as { artifacts: { url: string }[] };
    for (const artifact of manifest.artifacts) artifact.url = "https://elsewhere.example/file";
    record.exchanges = record.exchanges.slice(0, 1);
    const { spec } = stepOf(record, 0, "fetch");
    const { transport, remaining } = replay(record);
    await assert.rejects(fetchDataset(transport, spec!), {
      name: "ContractError",
      code: "contract_violation",
    });
    assert.deepEqual(remaining(), []);
  });
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
