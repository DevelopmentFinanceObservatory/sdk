import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

import { parquetWriteBuffer } from "hyparquet-writer";

import { clientOver } from "../src/client.ts";
import { envFrom } from "../src/config/env.ts";
import { download, fetchMembers } from "../src/datasets/fetch.ts";
import { fetchDataset } from "../src/datasets/resolve.ts";
import type { FetchOptions } from "../src/datasets/fetch.ts";
import { DatasetRef, isDerived, renderingFor } from "../src/core/ref.ts";
import { specRoles } from "../src/core/roles.ts";
import type { DatasetRefJson, Spec } from "../src/core/ref.ts";
import { DEFAULT_MAX_BYTES, Transport } from "../src/http/transport.ts";
import { DataWarning } from "../src/core/warnings.ts";
import type { Part, Spec as WireSpec } from "../src/wire.ts";
import type { DfoWarning } from "../src/core/warnings.ts";
import { InvalidRequestError, ServerError } from "../src/core/errors.ts";
import {
  NO_EXCHANGES,
  REPLAY_BASE_URL,
  REPLAY_KEY,
  replay,
  scenario,
  scenarioBytes,
  stepOf,
} from "./replay.ts";
import type { Exchange } from "./replay.ts";
import type { Dataset } from "../src/datasets/dataset.ts";
import { contractJson, json, mockFetch, problem } from "./support.ts";

/** The error a promise rejects with; the test fails when it resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return assert.fail("the call resolved");
}

describe("a fetched spec's ref", () => {
  // The fetch leaves party totals out by default, so its ref records the cut rendering it
  // posted, as the contract's cut ref of that member does.
  test("is the contract's ref for that member", async () => {
    const record = await scenario("fetch-spec-known-sentence");
    const { spec } = stepOf(record, 0, "fetch");
    assert.ok(spec);
    const dataset = await fetchDataset(replay(record).transport, spec);
    const { ref } = await contractJson<{ ref: unknown }>("refs/ref-without-party-totals.json");
    assert.deepEqual(JSON.parse(JSON.stringify(dataset.ref)), ref);
  });
});

describe("two specs whose narrowed builds are one spec", () => {
  test("make one member answering both parts, built twice and downloaded once", async () => {
    const record = structuredClone(await scenario("fetch-spec-narrowed"));
    const { spec, window } = stepOf(record, 0, "fetch");
    assert.ok(spec);
    const otherId = `spec_${"9".repeat(32)}`;
    const other: Spec = {
      ...spec,
      spec_id: otherId,
      definition: { ...spec.definition, spec_id: otherId },
    };
    const [built, resubmit, ...download] = record.exchanges;
    const entries = (resubmit!.request.json as { input: { entries: Record<string, unknown>[] } })
      .input.entries;
    entries[0]!["variable_text"] = "health ODA";
    // The second build posts the other spec, and the server answers the same built spec.
    const rebuild = structuredClone(built!);
    const input = (rebuild.request.json as { input: Record<string, unknown> }).input;
    input["spec_id"] = otherId;
    input["definition"] = other.definition;
    const closest = { code: "closest_match", text: "The closest reading." };
    const asked = { status: "definite", spec: other, departures: [closest] } as unknown as Part;
    const { transport, remaining } = replay({
      ...record,
      origin: { kind: "synthetic", derived_from: record.name },
      exchanges: [built!, resubmit!, ...download, rebuild],
    });
    const dataset = await fetchMembers(
      transport,
      [
        { parts: ["health ODA"], spec },
        { parts: ["basic health"], spec: other, answerParts: [asked] },
      ],
      { narrowing: { window } },
    );
    assert.deepEqual(remaining(), []);
    assert.deepEqual(
      dataset.members.map((member) => member.parts),
      [["health ODA", "basic health"]],
    );
    const expected = record.expect[0]!;
    assert.ok("dataset" in expected);
    assert.equal(dataset.rowCount, expected.dataset.rows);
    assert.ok(!dataset.columns.includes("part"));
    assert.deepEqual(dataset.departures, [closest]);
    const ref = DatasetRef.fromJSON(JSON.parse(JSON.stringify(dataset.ref)));
    assert.ok(ref.equals(dataset.ref));
  });
});

describe("a ref fetched with latest", () => {
  test("builds its spec as a spec fetch does", async () => {
    const record = await scenario("fetch-spec-known-sentence");
    const { spec } = stepOf(record, 0, "fetch");
    assert.ok(spec);
    const fetched = await fetchDataset(replay(record).transport, spec);
    const { transport, remaining } = replay(record);
    const newest = await fetchDataset(transport, fetched.ref, { latest: true });
    assert.deepEqual(remaining(), []);
    assert.ok(newest.ref.equals(fetched.ref));
    assert.equal(newest.rowCount, fetched.rowCount);
  });

  test("returns the newest version where the ref names an older one", async () => {
    const record = structuredClone(await scenario("fetch-spec-known-sentence"));
    const { spec } = stepOf(record, 0, "fetch");
    assert.ok(spec);
    const fetched = await fetchDataset(replay(record).transport, spec);
    const newer = `cv_${"1".repeat(32)}`;
    (record.exchanges[0]!.response.json as Record<string, unknown>)["content_version"] = newer;
    const newest = await fetchDataset(replay(record).transport, fetched.ref, { latest: true });
    assert.equal(newest.members[0]!.contentVersion, newer);
    assert.ok(!newest.ref.equals(fetched.ref));
  });

  test("stacks an answer's members under their parts", async () => {
    const record = await scenario("answer-several-readings-folded");
    const client = clientOver(replay(record).transport);
    const answer = await client.search(stepOf(record, 0, "search").question);
    const fetched = await answer.fetch();
    const builds = { ...record, exchanges: record.exchanges.slice(1) };
    const { transport, remaining } = replay(builds);
    const newest = await fetchDataset(transport, fetched.ref, { latest: true });
    assert.deepEqual(remaining(), []);
    assert.ok(newest.ref.equals(fetched.ref));
    assert.deepEqual(
      newest.members.map((member) => member.parts),
      fetched.members.map((member) => member.parts),
    );
    assert.deepEqual(newest.columns, fetched.columns);
    assert.deepEqual(await newest.toRows(), await fetched.toRows());
  });

  // A ref records the rendering its fetch posted, so a latest fetch of a cut ref posts the cut
  // and answers the cut's own version, and one of a ref fetched with party totals posts none.
  for (const [name, cut] of [
    ["fetch-spec-party-totals-left-out", true],
    ["fetch-spec-party-totals-kept", false],
  ] as const) {
    test(`rebuilds ${name}'s ref in the ref's rendering`, async () => {
      const record = await scenario(name);
      const step = stepOf(record, 0, "fetch");
      assert.ok(step.spec);
      const fetched = await fetchDataset(replay(record).transport, step.spec, {
        window: step.window,
        entities: step.entities,
        ...(step.party_totals === undefined ? {} : { partyTotals: step.party_totals }),
      });
      const [member] = fetched.ref.members;
      assert.ok(member && !isDerived(member));
      assert.equal(member.rendering.without_party_totals === true, cut);
      // The latest fetch posts the built spec with no narrowing, and knows its sentence.
      const [built, , ...download] = record.exchanges;
      const rebuild = structuredClone(built!);
      rebuild.request.json = {
        input: {
          kind: "spec_id",
          spec_id: member.spec.spec_id,
          definition: member.spec.definition,
        },
        options: {
          format: "parquet",
          bundle: false,
          ...(cut ? { without_party_totals: true } : {}),
        },
      };
      const { transport, remaining } = replay({
        ...record,
        origin: { kind: "synthetic", derived_from: name },
        exchanges: [rebuild, ...download],
      });
      const newest = await fetchDataset(transport, fetched.ref, { latest: true });
      assert.deepEqual(remaining(), []);
      const expected = record.expect[0]!;
      assert.ok("dataset" in expected);
      assert.equal(newest.members[0]!.contentVersion, expected.dataset.members[0]!.content_version);
      assert.equal(newest.rowCount, expected.dataset.rows);
      assert.ok(newest.ref.equals(fetched.ref));
    });
  }
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

  test("lose their controls, which would reach a terminal as escapes", async () => {
    const record = structuredClone(await scenario("fetch-spec-known-sentence"));
    const { spec } = stepOf(record, 0, "fetch");
    assert.ok(spec);
    for (const exchange of record.exchanges) {
      const body = exchange.response.json as { warnings?: Record<string, unknown>[] } | undefined;
      for (const warning of body?.warnings ?? []) warning["message"] = "\u001b[2Jclear\u202eflip";
    }
    await assert.rejects(fetchDataset(replay(record).transport, spec, { strict: true }), {
      name: "DataWarning",
      message: "[2Jclearflip [coverage_below_scope]",
    });
  });

  test('a warning with no code raises under strict with the code ""', async () => {
    const record = structuredClone(await scenario("fetch-spec-known-sentence"));
    const { spec } = stepOf(record, 0, "fetch");
    assert.ok(spec);
    const withWarnings = record.exchanges
      .map((exchange) => exchange.response.json)
      .filter((body): body is { warnings: Record<string, unknown>[] } =>
        Array.isArray((body as { warnings?: unknown } | undefined)?.warnings),
      );
    assert.ok(withWarnings.length > 0);
    for (const body of withWarnings) for (const warning of body.warnings) delete warning["code"];
    await assert.rejects(fetchDataset(replay(record).transport, spec, { strict: true }), {
      name: "DataWarning",
      code: "",
      severity: "warn",
    });
  });
});

describe("arguments a fetch refuses before any request", () => {
  const { transport } = replay(NO_EXCHANGES);
  const spec = (id: string): Spec => ({ spec_id: id, definition: { spec_id: id } });

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

  // Each row gives a target that is not a spec and what the refusal says it got.
  for (const [name, target, got] of [
    ["a spec id on its own", "spec_1", 'the string "spec_1"'],
    ["a spec without its definition", { spec_id: "spec_1" }, "an object"],
    [
      "a spec whose definition is not an object",
      { spec_id: "spec_1", definition: "x" },
      "an object",
    ],
    ["null", null, "null"],
    ["undefined", undefined, "undefined"],
  ] as const) {
    test(`${name}, to fetch`, async () => {
      await assert.rejects(fetchDataset(transport, target as unknown as Spec), {
        name: "InvalidRequestError",
        code: "invalid_argument",
        message: new RegExp(`not ${got}.*answer\\.fetch\\(\\)`),
      });
    });
  }

  const storedRef = async () =>
    DatasetRef.fromJSON(stepOf(await scenario("fetch-ref"), 0, "fetch").ref);

  for (const [name, options, named] of [
    [
      "a ref given the latest window",
      { window: "latest" },
      "A ref fetch takes no window; for the newest version use latest: true.",
    ],
    [
      "a ref given a window",
      { window: [2020, 2021] },
      "fetch a member's spec: client.fetch(ref.members[0].spec, { window: [2020,2021] }).",
    ],
    [
      "a ref given the latest window and latest",
      { window: "latest", latest: true },
      `fetch a member's spec: client.fetch(ref.members[0].spec, { window: "latest" }).`,
    ],
    ["a ref given entities", { entities: { origin: ["country/FRA"] } }, "ref.members[0].spec"],
    ["a ref given latest that is not a boolean", { latest: "yes" }, "latest is true or false"],
  ] as const) {
    test(name, async () => {
      await assert.rejects(fetchDataset(transport, await storedRef(), options as FetchOptions), {
        name: "InvalidRequestError",
        code: "invalid_argument",
        message: new RegExp(named.replace(/[.[\](){}]/g, "\\$&")),
      });
    });
  }

  for (const latest of [false, true]) {
    test(`a derived ref${latest ? " given latest" : ""}`, async () => {
      const { ref } = await contractJson<{ ref: unknown }>("refs/ref-derived-member.json");
      const derived = DatasetRef.fromJSON(ref);
      await assert.rejects(fetchDataset(transport, derived, { latest }), {
        name: "InvalidRequestError",
        code: "invalid_argument",
        message: new RegExp(`${derived.members[0]!.spec.spec_id}, a frame DFO computed`),
      });
    });
  }

  test("a spec given latest", async () => {
    await assert.rejects(fetchDataset(transport, spec("spec_1"), { latest: true }), {
      name: "InvalidRequestError",
      code: "invalid_argument",
      message: /client\.fetch\(spec\)/,
    });
  });

  test("a latest fetch of a ref whose members differ in rendering", async () => {
    const [held] = (await storedRef()).members;
    assert.ok(held && !isDerived(held));
    const specId = `spec_${"0".repeat(32)}`;
    assert.equal(held.rendering.without_party_totals, true);
    const plain = {
      ...held,
      spec: { spec_id: specId, definition: { ...held.spec.definition, spec_id: specId } },
      rendering: renderingFor("long"),
    };
    await assert.rejects(fetchDataset(transport, new DatasetRef([held, plain]), { latest: true }), {
      name: "InvalidRequestError",
      code: "invalid_argument",
      message: /client\.fetch\(ref\.members\[1\]\.spec, \{ layout: "long", partyTotals: true \}\)/,
    });
  });

  test("entities for a spec whose definition holds no identity", async () => {
    await assert.rejects(
      fetchDataset(transport, spec("spec_1"), { entities: { origin: ["country/DEU"] } }),
      { name: "InvalidRequestError", code: "invalid_argument" },
    );
  });

  for (const [name, cut, partyTotals] of [
    ["a cut ref given partyTotals", true, true],
    ["a plain ref given partyTotals false", false, false],
  ] as const) {
    test(name, async () => {
      const record = await scenario("fetch-ref");
      const saved = structuredClone(stepOf(record, 0, "fetch").ref) as DatasetRefJson;
      const { rendering } = saved.members[0]!.artifact;
      if (cut) rendering.without_party_totals = true;
      else delete rendering.without_party_totals;
      await assert.rejects(fetchDataset(transport, DatasetRef.fromJSON(saved), { partyTotals }), {
        name: "InvalidRequestError",
        code: "invalid_argument",
        message: new RegExp(`partyTotals ${!partyTotals}, not ${partyTotals}`),
      });
    });
  }

  test("a partyTotals that is not a boolean", async () => {
    await assert.rejects(
      fetchDataset(transport, spec("spec_1"), { partyTotals: "yes" as unknown as boolean }),
      { name: "InvalidRequestError", code: "invalid_argument" },
    );
  });

  test("a layout that is neither long nor frame", async () => {
    await assert.rejects(fetchDataset(transport, spec("spec_1"), { layout: "wide" as "long" }), {
      name: "InvalidRequestError",
      code: "invalid_argument",
    });
  });

  for (const window of [2022, "2022", [2022], ["2022"]]) {
    test(`a one-year window ${JSON.stringify(window)} names the range of that year`, async () => {
      await assert.rejects(fetchDataset(transport, spec("spec_1"), { window } as FetchOptions), {
        code: "invalid_argument",
        message: /; for one year use \[2022, 2022\]\. \[invalid_argument\]$/,
      });
    });
  }

  const identified: Spec = {
    spec_id: "spec_1",
    definition: { spec_id: "spec_1", identity: { entities: { origin: ["country/DEU"] } } },
  };
  for (const [name, narrowing] of [
    ["a window of a fractional year", { window: [2020.5, 2021] }],
    ["a window of three years", { window: [2019, 2020, 2021] }],
    ["a window that ends before it starts", { window: [2021, 2019] }],
    ["a window that ends past the largest safe integer", { window: [2020, 2 ** 53] }],
    ["a window that starts before the smallest safe integer", { window: [-(2 ** 53), 2020] }],
    ["a window that starts before 1000", { window: [999, 2020] }],
    ["a window that ends after 2200", { window: [2020, 2201] }],
    ["a role bound to a list holding only white space", { entities: { origin: [" "] } }],
    ["entities as a list", { entities: [["origin", ["country/FRA"]]] }],
    ["a role bound to a string", { entities: { origin: "country/FRA" } }],
    ["a role with an empty name", { entities: { "": ["country/FRA"] } }],
    ["a facet axis with an empty name", { facets: { "": "USDollar" } }],
    ["a role bound to an empty list", { entities: { origin: [] } }],
    ["a role bound to a list holding a number", { entities: { origin: [5] } }],
    ["a role bound to a list holding an empty dcid", { entities: { origin: [""] } }],
    ["a facet bound to a number", { facets: { unit: 5 } }],
    ["a facet bound to an object", { facets: { unit: { ref: "USDollar" } } }],
  ] as const) {
    test(name, async () => {
      await assert.rejects(fetchDataset(transport, identified, narrowing as FetchOptions), {
        name: "InvalidRequestError",
        code: "invalid_argument",
      });
    });
  }
});

describe("a fetch's roles", () => {
  const { transport } = replay(NO_EXCHANGES);
  const top5 = (async () => {
    const record = await scenario("search-warning-top5");
    return (record.exchanges[0]!.response.json as { parts: { spec: WireSpec }[] }).parts[0]!.spec;
  })();

  test("refuses a role the spec does not take, naming its roles, with no request", async () => {
    const error = await rejection(
      fetchDataset(transport, await top5, { entities: { financingRecipient: ["country/KEN"] } }),
    );
    assert.ok(error instanceof InvalidRequestError);
    assert.equal(error.code, "invalid_argument");
    assert.equal(
      error.detail,
      'entities names "financingRecipient", a role the spec does not declare; its roles are ' +
        "destination, origin.",
    );
  });

  for (const [name, identity] of [
    ["a place spec", { entities: { observationAbout: ["country/KEN"] } }],
    ["a spec that names no role", {}],
  ] as const) {
    test(`refuses the wire name of place on ${name}, naming place`, async () => {
      const spec = { spec_id: "spec_1", definition: { spec_id: "spec_1", identity } };
      const error = await rejection(
        fetchDataset(transport, spec, { entities: { observationAbout: ["country/NGA"] } }),
      );
      assert.ok(error instanceof InvalidRequestError);
      assert.equal(
        error.detail,
        'entities names "observationAbout", the wire name of "place"; key it as "place".',
      );
    });
  }

  test("specRoles gives each role's dcids, a flow direction it binds none of as null", async () => {
    const spec = await top5;
    assert.deepEqual(specRoles(spec), { destination: ["country/ETH"], origin: null });
    const identity = spec.definition["identity"] as Record<string, unknown>;
    const place: Record<string, unknown> = {
      ...identity,
      entities: { observationAbout: ["country/KEN"] },
    };
    delete place["open_roles"];
    assert.deepEqual(specRoles({ ...spec, definition: { ...spec.definition, identity: place } }), {
      place: ["country/KEN"],
    });
    assert.deepEqual(specRoles({ spec_id: "spec_1", definition: {} }), {});
    assert.throws(() => specRoles("spec_1" as unknown as Spec), {
      name: "InvalidRequestError",
      code: "invalid_argument",
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
  const held = (answered.exchanges[0]!.response.json as { parts: { spec: WireSpec }[] }).parts[0]!
    .spec;
  const spec: Spec = {
    spec_id: String(definition["spec_id"]),
    definition,
    resolved: {
      ...held.resolved,
      rendered_sentence: null,
      entity_groups: { origin: EU, destination: WEST },
    },
  };
  const rows: [string, FetchOptions, Record<string, unknown> | undefined, unknown][] = [
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
      "post a window of the widest years",
      { window: [1000, 2200] },
      { window: { kind: "range", start_year: 1000, end_year: 2200 } },
      { origin: EU, destination: WEST },
    ],
    [
      "read null window, entities and facets as unset",
      { window: null, entities: null, facets: null },
      undefined,
      { origin: EU, destination: WEST },
    ],
    [
      "post each dcid without its surrounding white space",
      { entities: { origin: [" country/FRA\t"] } },
      { entities: { origin: ["country/FRA"], destination: bound.destination } },
      { destination: WEST },
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
      const entities = (scope?.["entities"] ?? bound) as Record<string, readonly string[]>;
      const { fetch, seen } = mockFetch(
        json({ ...manifest, definition: definitionWith(entities) }),
        problem({ code: "request_invalid", status: 400 }),
      );
      const transport = new Transport({
        baseUrl: "https://api.example/api",
        apiKey: false,
        env: envFrom({}),
        readCredentialsFile: () => null,
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

  // Search refuses the built identity's entity when the fetch resubmits it for its sentence.
  const refusedResubmit = (entities: Record<string, readonly string[]>, refusal: object) => {
    const { fetch } = mockFetch(
      json({ ...manifest, definition: definitionWith({ ...bound, ...entities }) }),
      problem({ status: 422, ...refusal }),
    );
    const transport = new Transport({
      baseUrl: "https://api.example/api",
      apiKey: false,
      env: envFrom({}),
      readCredentialsFile: () => null,
      fetch,
      onWarning: () => undefined,
    });
    return clientOver(transport).fetch(spec, { entities });
  };

  for (const [name, origin, lookup] of [
    ["a place name names the lookup that finds its dcid", "Germany", true],
    ["a dcid the graph lacks names no lookup", "country/XXX", false],
  ] as const) {
    test(name, async () => {
      const error = await rejection(
        refusedResubmit(
          { origin: [origin] },
          {
            code: "invalid_role_ref",
            detail: `posted entity reference(s) not found in the graph: ${origin}`,
            pointer: "/input/entities/origin",
          },
        ),
      );
      assert.ok(error instanceof InvalidRequestError);
      assert.equal(error.code, "invalid_role_ref");
      assert.equal(error.traceId, "trace-1");
      // The hint keeps the field the pointer names and the bracket with the code and trace id.
      assert.ok(
        error.message.startsWith(
          `posted entity reference(s) not found in the graph: ${origin} at /input/entities/origin`,
        ),
        error.message,
      );
      assert.ok(error.message.endsWith(" [invalid_role_ref · trace trace-1]"), error.message);
      assert.equal(
        error.message.includes(`client.lookup.resolve(${JSON.stringify(origin)})`),
        lookup,
      );
    });
  }

  test("a refusal that offers alternatives names the nearest", async () => {
    const error = await rejection(
      refusedResubmit(
        { origin: ["country/DEX"] },
        {
          code: "invalid_role_ref",
          alternatives: [
            { ref: "country/FRA", label: "France" },
            { ref: "country/DEU", label: "Germany" },
          ],
        },
      ),
    );
    assert.ok(error instanceof InvalidRequestError);
    assert.match(error.message, /Did you mean "country\/DEU"\?/);
    assert.match(error.message, /country\/FRA \(France\), country\/DEU \(Germany\)/);
  });
});

/** fetch-spec-narrowed, which builds a spec that holds no sentence and resubmits it, served by a
 *  mock: the build's manifest with `data` as its artifact, its `warnings` and its coverage
 *  counting `rows` (4 when not given), Search's answer to the resubmit, then the files route
 *  serving `data`. */
const narrowedRecord = await scenario("fetch-spec-narrowed");
function fetchServing(
  data: Uint8Array,
  {
    resolution,
    warnings,
    rows,
  }: { resolution?: unknown; warnings?: unknown[]; rows?: number | undefined } = {},
): { fetched: Promise<Dataset>; seen: DfoWarning[] } {
  const [built, resubmit] = narrowedRecord.exchanges;
  const manifest = structuredClone(built!.response.json) as Record<string, unknown>;
  const [artifact] = manifest["artifacts"] as Record<string, unknown>[];
  artifact!["artifact_digest"] = `sha256:${createHash("sha256").update(data).digest("hex")}`;
  artifact!["bytes"] = data.byteLength;
  if (warnings !== undefined) manifest["warnings"] = warnings;
  if (rows !== undefined) (manifest["coverage"] as Record<string, unknown>)["rows"] = rows;
  const { fetch } = mockFetch(
    json(manifest),
    json(resolution ?? resubmit!.response.json),
    () => new Response(data.slice(), { status: 200 }),
  );
  const seen: DfoWarning[] = [];
  const transport = new Transport({
    baseUrl: "https://api.example/api",
    apiKey: false,
    env: envFrom({}),
    readCredentialsFile: () => null,
    fetch,
    onWarning: (warning) => seen.push(warning),
  });
  return { fetched: fetchDataset(transport, stepOf(narrowedRecord, 0, "fetch").spec!), seen };
}

const parquet = (columns: { name: string; data: unknown[] }[]): Uint8Array =>
  new Uint8Array(parquetWriteBuffer({ columnData: columns }));

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

  test("times a hung files route ask out at the client's timeout and asks again", async () => {
    const record = await scenario("fetch-spec-known-sentence");
    const [build, route] = record.exchanges;
    const bytes = await scenarioBytes("fetch-spec-known-sentence.parquet");
    const hang = (_request: unknown, init: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        // The timer stands in for the socket a real hung request holds open.
        const socket = setTimeout(() => undefined, 5_000);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(socket);
          reject(init.signal?.reason);
        });
      });
    const { fetch, seen } = mockFetch(
      json(build!.response.json),
      hang,
      () => new Response(null, { status: 302, headers: route!.response.headers ?? {} }),
      () => new Response(bytes),
    );
    const transport = new Transport({
      baseUrl: REPLAY_BASE_URL,
      apiKey: REPLAY_KEY,
      fetch,
      timeout: 50,
      sleep: () => Promise.resolve(),
      env: envFrom({}),
      readCredentialsFile: () => null,
    });
    const { spec } = stepOf(record, 0, "fetch");
    // The fetch's own deadline is longer than the attempt timeout and short enough to fail fast
    // when the route ask waits for the deadline.
    const dataset = await fetchDataset(transport, spec!, { timeout: 2_000 });
    assert.deepEqual(dataset.memberBytes(0), bytes);
    assert.equal(seen.length, 4);
  });

  test("asks the files route again after a followed browser redirect answers 403", async () => {
    const record = await scenario("fetch-spec-known-sentence");
    const bytes = await scenarioBytes("fetch-spec-known-sentence.parquet");
    const opaque = () => {
      const response = new Response(null, { status: 200 });
      Object.defineProperty(response, "type", { value: "opaqueredirect" });
      return response;
    };
    const { fetch, seen } = mockFetch(
      json(record.exchanges[0]!.response.json),
      opaque,
      () => new Response("<Error>ExpiredToken</Error>", { status: 403 }),
      opaque,
      () => new Response(bytes),
    );
    const waits: number[] = [];
    const transport = new Transport({
      baseUrl: REPLAY_BASE_URL,
      apiKey: REPLAY_KEY,
      fetch,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      env: envFrom({}),
      readCredentialsFile: () => null,
    });
    const dataset = await fetchDataset(transport, stepOf(record, 0, "fetch").spec!);
    assert.deepEqual(dataset.memberBytes(0), bytes);
    assert.equal(seen.length, 5);
    assert.deepEqual(waits, []);
  });

  // Each row gives the manifest's size, the limit the download reads under, and the code it
  // raises.
  for (const [name, size, limit, code] of [
    [
      "one byte short of the file",
      (bytes: number) => bytes - 1,
      (bytes: number) => bytes - 1,
      "response_too_large",
    ],
    ["the file's size", (bytes: number) => bytes, (bytes: number) => bytes, null],
    ["not a byte count", () => "large", () => DEFAULT_MAX_BYTES, null],
    ["past the download cap", () => 10 ** 15, () => DEFAULT_MAX_BYTES, null],
  ] as const) {
    test(`reads a file whose manifest gives a size ${name}`, async () => {
      const record = structuredClone(await scenario("fetch-spec-known-sentence"));
      const manifest = record.exchanges[0]!.response.json as {
        artifacts: { bytes: unknown }[];
      };
      const file = await scenarioBytes("fetch-spec-known-sentence.parquet");
      for (const artifact of manifest.artifacts) artifact.bytes = size(file.byteLength);
      const { transport } = replay(record);
      const limits: (number | undefined)[] = [];
      const locate = transport.locate.bind(transport);
      transport.locate = (options) => {
        limits.push(options.maxBytes);
        return locate(options);
      };
      const fetched = fetchDataset(transport, stepOf(record, 0, "fetch").spec!);
      await fetched.catch(() => undefined);
      assert.deepEqual(limits, [limit(file.byteLength)]);
      if (code === null) {
        assert.deepEqual((await fetched).memberBytes(0), file);
      } else {
        await assert.rejects(fetched, { name: "ServerError", code, retryable: false });
      }
    });
  }

  // The artifact's size bounds the response that carries it. Each row gives a files route's
  // first answer, with a body longer than the file, that the download reads through.
  const file = new TextEncoder().encode("PAR1 file");
  const page = "<html>bad gateway</html>".padEnd(4096, " ");
  for (const [name, first] of [
    ["a 502 page, which it retries", () => new Response(page, { status: 502 })],
    [
      "a redirect with a body",
      () =>
        new Response(page, {
          status: 302,
          headers: { location: "https://storage.googleapis.com/bucket/object" },
        }),
    ],
  ] as const) {
    test(`reads a small file through ${name}`, async () => {
      const { fetch, seen } = mockFetch(first, () => new Response(file));
      const transport = new Transport({
        baseUrl: "https://api.example/api",
        apiKey: false,
        fetch,
        sleep: () => Promise.resolve(),
        env: envFrom({}),
        readCredentialsFile: () => null,
      });
      const digest = `sha256:${createHash("sha256").update(file).digest("hex")}`;
      const data = await download(
        transport,
        { path: "/files/x" },
        digest,
        { deadline: Infinity },
        file.byteLength,
      );
      assert.deepEqual(data, file);
      assert.equal(seen.length, 2);
    });
  }

  test("refuses an artifact URL off the API's origin before the sentence and any download", async () => {
    const record = structuredClone(await scenario("fetch-spec-known-sentence"));
    const built = record.exchanges[0]!.response;
    const trace = "7".repeat(32);
    built.headers = { ...built.headers, "x-dfo-trace-id": trace };
    const manifest = built.json as { artifacts: { url: string }[] };
    record.exchanges = record.exchanges.slice(0, 1);
    const { spec } = stepOf(record, 0, "fetch");
    // Without its sentence the spec needs Search's, which the client would ask for next.
    const unsentenced = { spec_id: spec!.spec_id, definition: spec!.definition };
    for (const held of [spec!, unsentenced]) {
      for (const url of [
        "https://elsewhere.example/file",
        "https://storage.googleapis.com/bucket/object?X-Goog-Signature=redacted",
      ]) {
        for (const artifact of manifest.artifacts) artifact.url = url;
        const { transport, remaining } = replay(record);
        await assert.rejects(fetchDataset(transport, held), {
          name: "ContractError",
          code: "contract_violation",
          traceId: trace,
        });
        assert.deepEqual(remaining(), []);
      }
    }
  });

  const real = scenarioBytes("fetch-spec-narrowed.parquet");
  const flipped = async () => {
    const bytes = (await real).slice();
    for (let index = 8; index < 2000; index += 7) bytes[index]! ^= 0x5a;
    return bytes;
  };
  const decimal = { type: "DECIMAL", precision: 12, scale: 2 } as const;
  const year = { name: "time_period", data: ["2020"] };
  const decimalValue = new Uint8Array(
    parquetWriteBuffer({
      columnData: [year, { name: "value", data: [1234n] }],
      schema: [
        { name: "root", num_children: 2 },
        { name: "time_period", type: "BYTE_ARRAY", converted_type: "UTF8" },
        {
          name: "value",
          type: "INT64",
          repetition_type: "OPTIONAL",
          converted_type: "DECIMAL",
          logical_type: decimal,
          precision: decimal.precision,
          scale: decimal.scale,
        },
      ],
    }),
  );
  // Each row gives a file and the code the fetch raises for it: bytes that do not decode are
  // unexpected_response, and a decoded file that is not a dataset's table is contract_violation.
  const files: [string, () => Uint8Array | Promise<Uint8Array>, string][] = [
    [
      "bytes that are not Parquet",
      () => new TextEncoder().encode("not parquet PAR1"),
      "unexpected_response",
    ],
    ["an empty file", () => new Uint8Array(), "unexpected_response"],
    ["a truncated file", async () => (await real).slice(0, 3000), "unexpected_response"],
    ["no value column", () => parquet([year, { name: "a", data: [1] }]), "contract_violation"],
    ["no time_period column", () => parquet([{ name: "value", data: [1] }]), "contract_violation"],
    [
      "rows whose value is text",
      () => parquet([year, { name: "value", data: ["1.5"] }]),
      "contract_violation",
    ],
    [
      "two columns of one name",
      () => parquet([year, { name: "value", data: [1] }, { name: "value", data: [2] }]),
      "contract_violation",
    ],
    [
      "no rows where the manifest counts 4",
      () =>
        parquet([
          { ...year, data: [] },
          { name: "value", data: [] },
        ]),
      "contract_violation",
    ],
  ];
  for (const [name, bytes, code] of files) {
    test(`raises ContractError ${code} from the fetch for a file of its digest with ${name}`, async () => {
      const { fetched } = fetchServing(await bytes());
      await assert.rejects(fetched, { name: "ContractError", code });
    });
  }

  // A value column of any numeric or null type passes, as does an empty file's text value.
  for (const [name, bytes, rows] of [
    ["rows whose value is an integer", () => parquet([year, { name: "value", data: [1] }]), 1],
    ["rows whose value is a decimal", () => decimalValue, 1],
    [
      "rows whose value is null-typed",
      () =>
        new Uint8Array(
          parquetWriteBuffer({
            columnData: [year, { name: "value", data: [null] }],
            schema: [
              { name: "root", num_children: 2 },
              { name: "time_period", type: "BYTE_ARRAY", converted_type: "UTF8" },
              {
                name: "value",
                type: "INT32",
                repetition_type: "OPTIONAL",
                logical_type: { type: "NULL" },
              },
            ],
          }),
        ),
      1,
    ],
  ] as const) {
    test(`accepts a file with ${name}`, async () => {
      const dataset = await fetchServing(bytes(), { rows }).fetched;
      assert.equal(dataset.rowCount, 1);
    });
  }

  test("raises ContractError contract_violation for a ref's stored file with no value column", async () => {
    const record = await scenario("fetch-ref");
    const data = parquet([year, { name: "a", data: [1] }]);
    const digest = `sha256:${createHash("sha256").update(data).digest("hex")}`;
    const ref = structuredClone(stepOf(record, 0, "fetch").ref) as DatasetRefJson;
    const stored = ref.members[0]!.artifact.digest;
    ref.members[0]!.artifact.digest = digest;
    const manifest = structuredClone(record.exchanges[0]!.response.json) as {
      artifacts: Record<string, unknown>[];
    };
    // The plain file and the cut that leaves nothing out both list the stored digest.
    for (const artifact of manifest.artifacts.filter((a) => a["artifact_digest"] === stored)) {
      artifact["artifact_digest"] = digest;
      artifact["bytes"] = data.byteLength;
    }
    const { fetch } = mockFetch(json(manifest), () => new Response(data.slice(), { status: 200 }));
    const transport = new Transport({
      baseUrl: "https://api.example/api",
      apiKey: false,
      env: envFrom({}),
      readCredentialsFile: () => null,
      fetch,
    });
    await assert.rejects(fetchDataset(transport, DatasetRef.fromJSON(ref)), {
      name: "ContractError",
      code: "contract_violation",
    });
  });

  test("raises ContractError unexpected_response on pages that do not decode", async () => {
    // The fetch decodes every page to read the reading order, so it raises before it returns.
    const { fetched } = fetchServing(await flipped());
    await assert.rejects(fetched, { name: "ContractError", code: "unexpected_response" });
  });
});

describe("a fetch that builds no rows", () => {
  // The file and the no_data part dev answered for a window before the data starts. The server
  // writes every column of an empty file as a string.
  const empty = readFile(new URL("data/empty-build.parquet", import.meta.url));
  const answered = structuredClone(narrowedRecord.exchanges[1]!.response.json) as Record<
    string,
    unknown
  >;
  const SENTENCE =
    "No data for official development assistance (gross disbursements). Try a different " +
    "place, time period, or indicator.";
  const noData = {
    ...answered,
    status: "no_data",
    parts: [
      {
        variable_text: "dataset",
        warnings: [],
        rendered_sentence: SENTENCE,
        operations: [],
        departures: [],
        assumptions: [],
        status: "no_data",
        no_data: { reason: "no_observations", message: SENTENCE, options: [] },
      },
    ],
  };
  const EMPTY_RESULT = {
    code: "empty_result",
    severity: "warn",
    message: "The materialised frame holds zero observations.",
  };

  test("returns the empty dataset under Search's no_data sentence, with the manifest's warning", async () => {
    const { fetched, seen } = fetchServing(new Uint8Array(await empty), {
      resolution: noData,
      rows: 0,
      warnings: [EMPTY_RESULT],
    });
    const dataset = await fetched;
    assert.equal(dataset.rowCount, 0);
    assert.equal(dataset.sentence, SENTENCE);
    assert.equal(dataset.members[0]!.sentence, SENTENCE);
    assert.deepEqual(await dataset.toRows(), []);
    assert.deepEqual(
      seen.map((warning) => warning.code),
      ["empty_result"],
    );
  });

  for (const [name, edit] of [
    ["no sentence", (part: Record<string, unknown>) => delete part["rendered_sentence"]],
    ["an empty sentence", (part: Record<string, unknown>) => (part["rendered_sentence"] = "")],
  ] as const) {
    test(`raises ContractError for a no_data part with ${name}`, async () => {
      const resolution = structuredClone(noData);
      edit(resolution.parts[0]!);
      const { fetched } = fetchServing(new Uint8Array(await empty), { resolution, rows: 0 });
      await assert.rejects(fetched, { name: "ContractError", code: "contract_violation" });
    });
  }

  test("raises ContractError for a no_data part when the manifest counts rows", async () => {
    const { fetched } = fetchServing(new Uint8Array(await empty), { resolution: noData, rows: 4 });
    await assert.rejects(fetched, { name: "ContractError", code: "contract_violation" });
  });

  test("raises ContractError for two no_data parts", async () => {
    const resolution = { ...noData, parts: [noData.parts[0], noData.parts[0]] };
    const { fetched } = fetchServing(new Uint8Array(await empty), { resolution, rows: 0 });
    await assert.rejects(fetched, { name: "ContractError", code: "contract_violation" });
  });
});

describe("a fetch's party-totals cut", () => {
  for (const [options, posted] of [
    [{}, { without_party_totals: true }],
    [{ partyTotals: false }, { without_party_totals: true }],
    [{ partyTotals: true }, {}],
  ] as const) {
    test(`posts ${JSON.stringify(posted)} for ${JSON.stringify(options)}`, async () => {
      const spec: Spec = { spec_id: "spec_1", definition: { spec_id: "spec_1" } };
      const { fetch, seen } = mockFetch(problem({ code: "invalid_argument", status: 400 }));
      const transport = new Transport({
        baseUrl: "https://api.example/api",
        apiKey: false,
        env: envFrom({}),
        readCredentialsFile: () => null,
        fetch,
      });
      await assert.rejects(fetchDataset(transport, spec, options), { code: "invalid_argument" });
      const body = JSON.parse(seen[0]!.body!) as { options: Record<string, unknown> };
      assert.deepEqual(body.options, { format: "parquet", bundle: false, ...posted });
    });
  }
});
