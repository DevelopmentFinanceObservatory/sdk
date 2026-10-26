import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

import { parquetWriteBuffer } from "hyparquet-writer";

import { clientOver } from "../src/client.ts";
import { envFrom } from "../src/config/env.ts";
import { download, fetchMembers, mint } from "../src/datasets/fetch.ts";
import { fetchDataset } from "../src/datasets/resolve.ts";
import type { FetchOptions } from "../src/datasets/fetch.ts";
import { DatasetRef } from "../src/core/ref.ts";
import type { DatasetRefJson, SpecLike } from "../src/core/ref.ts";
import { DEFAULT_MAX_BYTES, Transport } from "../src/http/transport.ts";
import { DataWarning } from "../src/core/warnings.ts";
import type { Spec } from "../src/wire.ts";
import type { DfoWarning } from "../src/core/warnings.ts";
import { ServerError } from "../src/core/errors.ts";
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
      message: "[2Jclearflip",
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

  for (const [name, target] of [
    ["a spec id on its own", "spec_1"],
    ["a spec without its definition", { spec_id: "spec_1" }],
    ["a spec whose definition is not an object", { spec_id: "spec_1", definition: "x" }],
    ["null", null],
  ] as const) {
    test(`${name}, to fetch or to mint`, async () => {
      const refused = { name: "InvalidRequestError", code: "invalid_argument" };
      await assert.rejects(fetchDataset(transport, target as unknown as SpecLike), refused);
      await assert.rejects(mint(transport, target as unknown as SpecLike), refused);
    });
  }

  test("a narrowed ref", async () => {
    const record = await scenario("fetch-ref");
    const ref = DatasetRef.fromJSON(stepOf(record, 0, "fetch").ref);
    await assert.rejects(fetchDataset(transport, ref, { window: [2020, 2021] }), {
      name: "InvalidRequestError",
    });
  });

  test("entities for a spec whose definition holds no identity", async () => {
    await assert.rejects(
      fetchDataset(transport, spec("spec_1"), { entities: { origin: ["country/DEU"] } }),
      { name: "InvalidRequestError", code: "invalid_argument" },
    );
  });

  for (const [name, held, withoutPartyTotals] of [
    ["a plain ref given withoutPartyTotals", false, true],
    ["a cut ref given withoutPartyTotals false", true, false],
  ] as const) {
    test(name, async () => {
      const record = await scenario("fetch-ref");
      const saved = structuredClone(stepOf(record, 0, "fetch").ref) as DatasetRefJson;
      if (held) saved.members[0]!.artifact.rendering.without_party_totals = true;
      await assert.rejects(
        fetchDataset(transport, DatasetRef.fromJSON(saved), { withoutPartyTotals }),
        {
          name: "InvalidRequestError",
          code: "invalid_argument",
          message: new RegExp(`withoutPartyTotals ${held}, not ${withoutPartyTotals}`),
        },
      );
    });
  }

  test("a withoutPartyTotals that is not a boolean", async () => {
    await assert.rejects(
      fetchDataset(transport, spec("spec_1"), { withoutPartyTotals: "yes" as unknown as boolean }),
      { name: "InvalidRequestError", code: "invalid_argument" },
    );
  });

  test("a layout that is neither long nor frame", async () => {
    await assert.rejects(fetchDataset(transport, spec("spec_1"), { layout: "wide" as "long" }), {
      name: "InvalidRequestError",
      code: "invalid_argument",
    });
  });

  const identified: SpecLike = {
    spec_id: "spec_1",
    definition: { spec_id: "spec_1", identity: { entities: { origin: ["country/DEU"] } } },
  };
  for (const [name, narrowing] of [
    ["a window of a fractional year", { window: [2020.5, 2021] }],
    ["a window of three years", { window: [2019, 2020, 2021] }],
    ["a window that ends before it starts", { window: [2021, 2019] }],
    ["a window that ends past the largest safe integer", { window: [2020, 2 ** 53] }],
    ["a window that starts before the smallest safe integer", { window: [-(2 ** 53), 2020] }],
    ["a window of null", { window: null }],
    ["entities of null", { entities: null }],
    ["entities as a list", { entities: [["origin", ["country/FRA"]]] }],
    ["a role bound to a string", { entities: { origin: "country/FRA" } }],
    ["a role with an empty name", { entities: { "": ["country/FRA"] } }],
    ["a facet axis with an empty name", { facets: { "": "USDollar" } }],
    ["a role bound to an empty list", { entities: { origin: [] } }],
    ["a role bound to a list holding a number", { entities: { origin: [5] } }],
    ["a role bound to a list holding an empty dcid", { entities: { origin: [""] } }],
    ["facets of null", { facets: null }],
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
      "post a window of the widest safe-integer years",
      { window: [-(2 ** 53 - 1), 2 ** 53 - 1] },
      { window: { kind: "range", start_year: -(2 ** 53 - 1), end_year: 2 ** 53 - 1 } },
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
      assert.equal(dataset.rows, 1);
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

  test("raises ContractError unexpected_response on reading pages that do not decode", async () => {
    const { fetched } = fetchServing(await flipped());
    const dataset = await fetched;
    await assert.rejects(dataset.toRows(), { name: "ContractError", code: "unexpected_response" });
    await assert.rejects(dataset.bytes(), { name: "ContractError", code: "unexpected_response" });
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
    assert.equal(dataset.rows, 0);
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
    [{}, {}],
    [{ withoutPartyTotals: false }, {}],
    [{ withoutPartyTotals: true }, { without_party_totals: true }],
  ] as const) {
    test(`posts ${JSON.stringify(posted)} for ${JSON.stringify(options)}`, async () => {
      const spec: SpecLike = { spec_id: "spec_1", definition: { spec_id: "spec_1" } };
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
