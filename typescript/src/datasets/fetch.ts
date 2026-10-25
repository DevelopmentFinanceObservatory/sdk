/**
 * Building datasets: a spec's latest version, and the steps a ref's lookup shares with it.
 *
 * A spec builds its latest version as bare Parquet, narrowed by `window`, `entities` and
 * `facets`. A narrowing gives the build its own `spec_id`, so the member keeps the spec, the
 * version and the definition the server answered with. The server replaces the spec's whole
 * entity binding with the posted `entities`, so the client posts the spec's own bound roles
 * with the caller's roles replaced.
 *
 * Each member's sentence is Search's: the one the caller holds when the built `spec_id` equals
 * the posted one, else the sentence Search gives the built identity when it is resubmitted,
 * checked on `spec_id`. The resubmit carries the held spec's entity group for each role the
 * built identity binds to the same entities, so a window or facets narrowing keeps every group
 * and a role that `entities` rebound or dropped loses its group. A narrowing that holds no
 * observations builds an empty file, which Search answers with one `no_data` part, and the
 * fetch returns the empty dataset under that part's sentence, beside the manifest's warnings.
 * Every download asks a files route on the API's origin, fetches the URL it redirects to, bare
 * on the storage host and as an API request on the API's origin, and is checked against its
 * digest before the fetch returns. Members build one after another, with no deadline unless
 * the caller gives a `timeout`, which bounds them all: each request attempt, the files route
 * ask included, waits the client's timeout within it, and a download reads until the deadline
 * while bytes keep arriving.
 */

import type { Gap } from "../search/answer.ts";
import { Dataset } from "./dataset.ts";
import type { FetchedMember } from "./dataset.ts";
import {
  capped,
  clientError,
  DfoError,
  InvalidRequestError,
  messageOf,
  optionsOf,
} from "../core/errors.ts";
import type { ClientErrorCode, DfoErrorOptions } from "../core/errors.ts";
import { build, downloadBuilt, waitFor } from "./operation.ts";
import type { Built, Manifest, ProgressHandler, Wait } from "./operation.ts";
import { manifestWarningsOf, partFacts } from "../core/parse.ts";
import type { PartFacts } from "../core/parse.ts";
import { mintOptions, renderingFor, renderingMatches } from "../core/ref.ts";
import type { Layout, Rendering, Spec } from "../core/ref.ts";
import { checkStrict } from "../core/strict.ts";
import { describing } from "../core/trace.ts";
import { DEFAULT_MAX_BYTES, passedDeadline } from "../http/transport.ts";
import type { Target, Transport } from "../http/transport.ts";
import type { EntityGroup, Part } from "../wire.ts";
import { DataWarning } from "../core/warnings.ts";
import { isRecord } from "../core/json.ts";
import { nearest } from "../core/nearest.ts";
import { declareOptions } from "../core/options.ts";
import { readParquet } from "./parquet.ts";
import type { ColumnType, ParquetFile } from "./parquet.ts";

/** The Search endpoint, and the `schema_version` of the bodies posted to it. */
export const RESOLVE_PATH = "/search/resolve";
export const RESOLVE_SCHEMA_VERSION = 1;

/** A year range, or every year, or the latest year. */
export type Window = "all" | "latest" | readonly [startYear: number, endYear: number];

/** How a fetch narrows a spec. The server builds a narrowed spec with its own `spec_id`. */
export type Narrowing = {
  /** The years, from 1000 to 2200. Null or undefined reads as unset, which is `"all"`. */
  window?: Window | null | undefined;
  /** Roles to rebind, as `{ origin: ["country/FRA"] }`, each dcid read without surrounding
   *  white space. null unbinds a role. Every role the spec binds and this leaves out keeps its
   *  dcids, so `{}` narrows nothing, as do null and undefined. */
  entities?: Readonly<Record<string, readonly string[] | null>> | null | undefined;
  /** Facet axes (`provenance`, `measurementMethod`, `unit`) bound to a reference. null binds
   *  the facets that declare no value on the axis. `{}` narrows nothing, as do null and
   *  undefined. */
  facets?: Readonly<Record<string, string | null>> | null | undefined;
};

/** How Search resolved each role's group of places, keyed by role: a spec's
 *  `resolved.entity_groups`. */
export type EntityGroups = Readonly<Record<string, EntityGroup>>;

/** One reading to build: the answer parts it answers, its spec, and its sentence if known. */
export type MemberRequest = {
  readonly parts: readonly string[];
  readonly spec: Spec;
  readonly sentence?: string | null | undefined;
  /** The spec's entity groups, when the caller holds them. */
  readonly entityGroups?: EntityGroups | null | undefined;
  /** The answer parts the reading answers, when it comes from an answer. */
  readonly answerParts?: readonly Part[];
};

export type CallOptions = {
  /** Aborts the fetch, rejecting with `signal.reason`. A build the server has started keeps
   *  running, and the same fetch joins it. */
  signal?: AbortSignal;
  /** The longest the whole fetch takes, builds and downloads included, in milliseconds. None by
   *  default: the fetch waits as long as the build takes, which the server bounds. Past it the
   *  fetch raises `DfoTimeoutError` (`deadline_exceeded`) and the build carries on; the same
   *  fetch joins it. */
  timeout?: number;
  onProgress?: ProgressHandler;
  /** Raises the first dataset warning, a `DataWarning`, instead of passing it to the warning
   *  handler. */
  strict?: boolean;
  layout?: Layout;
  /** Keep the rows of parties the code index declares totals, such as the DAC total beside its
   *  members. False by default: on each party role a reading leaves open the build leaves them
   *  out, so a sum over the rows counts each flow once, and a role the caller binds keeps what
   *  it binds. A ref holds its own choice, and naming another raises. */
  partyTotals?: boolean;
};

export type FetchOptions = CallOptions &
  Narrowing & {
    /** For a ref, build the newest version of each member's spec in the ref's rendering, in
     *  place of the exact versions it names. A spec always fetches its newest version. */
    latest?: boolean;
  };

/** The keys `client.fetch` takes. */
export const FETCH_OPTIONS = declareOptions<FetchOptions>("client.fetch", {
  signal: true,
  timeout: true,
  onProgress: true,
  strict: true,
  layout: true,
  partyTotals: true,
  window: true,
  entities: true,
  facets: true,
  latest: true,
});

export type FetchMembersOptions = CallOptions & {
  /** The parts a partial fetch leaves out. The dataset is complete when there are none. */
  missing?: readonly Gap[];
  /** The build request's `scope`, applied to every member. */
  narrowing?: Narrowing;
};

/** The variable text an identity resubmit sends for a spec no answer part names. Search
 *  echoes it onto the part, and it does not change the sentence. */
const UNNAMED_PART = "dataset";

export const DIGEST_MISMATCH = "digest_mismatch" satisfies ClientErrorCode;

/** The longest a download goes with no byte before it fails as a retryable `network_error`. */
export const DOWNLOAD_STALL_MS = 30_000;
const UNEXPECTED_RESPONSE = "unexpected_response" satisfies ClientErrorCode;

const SEARCH_AGAIN =
  "The server can no longer build this reading; search the question again for a current one.";

export const invalid = (detail: string): InvalidRequestError =>
  clientError("invalid_argument", { detail });

/** The years a window may name. The server takes any safe integer, and a year outside these
 *  builds an identity Search cannot resolve back. */
const FIRST_YEAR = 1000;
const LAST_YEAR = 2200;

/**
 * @throws {InvalidRequestError} The window is not "all", "latest" or two integers from
 *   `FIRST_YEAR` to `LAST_YEAR`, the first no later than the second (`invalid_argument`).
 */
function windowScope(window: unknown): Record<string, unknown> {
  if (window === "all" || window === "latest") return { kind: window };
  if (Array.isArray(window) && window.length === 2) {
    const [start, end] = window as unknown[];
    if (Number.isSafeInteger(start) && Number.isSafeInteger(end)) {
      const [first, last] = [start as number, end as number];
      if (first < FIRST_YEAR || last > LAST_YEAR) {
        throw invalid(
          `window years run from ${FIRST_YEAR} to ${LAST_YEAR}, not ${JSON.stringify(window)}.`,
        );
      }
      if (first <= last) return { kind: "range", start_year: first, end_year: last };
      throw invalid(
        `window is [startYear, endYear], startYear first, not ${JSON.stringify(window)}.`,
      );
    }
  }
  const year = oneYear(window);
  throw invalid(
    `window is "all", "latest" or [startYear, endYear], not ${JSON.stringify(window)}` +
      (year === undefined ? "." : `; for one year use [${year}, ${year}].`),
  );
}

/** The year a window names on its own: an integer, a string of digits, or a list of one. */
function oneYear(window: unknown): number | undefined {
  const [only] = Array.isArray(window) && window.length === 1 ? (window as unknown[]) : [window];
  if (Number.isSafeInteger(only)) return only as number;
  return typeof only === "string" && /^\d{1,4}$/.test(only) ? Number(only) : undefined;
}

/**
 * The spec a fetch builds, once it is an object with a `spec_id` and a `definition`
 * object, as an answer's specs and a ref's members hold it.
 *
 * @throws {InvalidRequestError} It is not, such as a spec id on its own (`invalid_argument`).
 */
export function checkedSpec(spec: unknown): Spec {
  if (isRecord(spec) && isText(spec["spec_id"]) && isRecord(spec["definition"])) {
    return spec as Spec;
  }
  throw invalid(
    `A fetch takes a spec or a DatasetRef, not ${described(spec)}. Fetch an answer with ` +
      "answer.fetch(), or one of its readings with client.fetch(answer.specs[0]).",
  );
}

/** What a fetch target is, for a refusal: `undefined`, a string, or an object. */
function described(value: unknown): string {
  if (value === undefined || value === null) return String(value);
  if (typeof value === "string") return `the string ${JSON.stringify(capped(value))}`;
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object with no spec_id and definition";
  return typeof value;
}

const isText = (value: unknown): value is string => typeof value === "string" && value !== "";

/** The roles a definition binds, each to its dcids. */
function boundRoles(definition: Readonly<Record<string, unknown>>): Map<string, readonly string[]> {
  const identity = definition["identity"];
  const entities = isRecord(identity) ? identity["entities"] : undefined;
  const bound = new Map<string, readonly string[]>();
  for (const [role, dcids] of Object.entries(isRecord(entities) ? entities : {})) {
    if (Array.isArray(dcids)) bound.set(role, dcids.map(String));
  }
  return bound;
}

/**
 * The spec's whole entity binding with the caller's roles replaced and its null roles dropped,
 * since the server's `scope.entities` replaces the binding outright.
 *
 * @throws {InvalidRequestError} The spec's definition holds no `identity` object, or a role is
 *   bound to neither a non-empty list of dcids nor null (`invalid_argument`).
 */
function entityScope(
  spec: Spec,
  entities: Readonly<Record<string, unknown>>,
): Record<string, readonly string[]> {
  if (!isRecord(spec.definition["identity"])) {
    throw invalid(
      `The definition of ${spec.spec_id} holds no identity to rebind; use a spec from a search.`,
    );
  }
  const bound = boundRoles(spec.definition);
  for (const [role, given] of Object.entries(entities)) {
    if (given === null) {
      bound.delete(role);
      continue;
    }
    const dcids = dcidsOf(given);
    if (dcids === undefined) {
      throw invalid(
        `entities.${role} is not a list of dcids; bind the role to a list such as ` +
          '["country/FRA"], or to null to unbind it.',
      );
    }
    bound.set(role, dcids);
  }
  return Object.fromEntries(bound);
}

/** A role's dcids, each without surrounding white space, which no dcid holds; undefined unless
 *  the value is a non-empty list of strings that are not empty once trimmed. */
function dcidsOf(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const dcids = value.map((dcid: unknown) => (typeof dcid === "string" ? dcid.trim() : ""));
  return dcids.every(isText) ? dcids : undefined;
}

/** The facets' `scope`, each axis bound to its reference.
 *
 * @throws {InvalidRequestError} An axis is bound to neither a reference nor null
 *   (`invalid_argument`).
 */
function facetScope(facets: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(facets).map(([axis, ref]) => {
      if (ref !== null && !isText(ref)) {
        throw invalid(`facets.${axis} is not a reference; bind the axis to a reference or null.`);
      }
      return [axis, { ref }];
    }),
  );
}

/**
 * A spec's build request `scope` for a narrowing, or undefined when it narrows nothing.
 *
 * @throws {InvalidRequestError} A narrowing argument breaks its rule (`invalid_argument`).
 */
function scopeOf(spec: Spec, narrowing: Narrowing): Record<string, unknown> | undefined {
  // Read as unknown: a JavaScript caller's arguments need not hold the declared types.
  const { window, entities, facets }: { readonly [K in keyof Narrowing]?: unknown } = narrowing;
  const scope: Record<string, unknown> = {};
  if (window !== undefined) scope["window"] = windowScope(window);
  if (namesAny(entities)) scope["entities"] = entityScope(spec, mapOf("entities", entities));
  if (namesAny(facets)) scope["facets"] = facetScope(mapOf("facets", facets));
  return Object.keys(scope).length === 0 ? undefined : scope;
}

/** Whether an `entities` or `facets` argument narrows: any value but undefined and `{}`, which
 *  names no role or axis and posts nothing. */
const namesAny = (map: unknown): boolean =>
  map !== undefined && !(isRecord(map) && Object.keys(map).length === 0);

function mapOf(name: string, map: unknown): Readonly<Record<string, unknown>> {
  if (isRecord(map) && !Object.hasOwn(map, "")) return map;
  throw invalid(`${name} is an object keyed by non-empty names, not ${JSON.stringify(map)}.`);
}

export const narrows = ({ window, entities, facets }: Narrowing): boolean =>
  window !== undefined || namesAny(entities) || namesAny(facets);

/** The `POST /datasets` body that builds a spec's latest version. It always carries the
 *  spec's unmodified definition, so a spec the server has not registered still builds. */
export function buildBody(spec: Spec, rendering: Rendering, scope?: Record<string, unknown>) {
  return {
    schema_version: 1,
    input: {
      kind: "spec_id",
      spec_id: spec.spec_id,
      definition: spec.definition,
      ...(scope === undefined ? {} : { scope }),
    },
    options: mintOptions(rendering),
  };
}

/**
 * Whether a fetch keeps party totals: false unless the caller says true.
 *
 * @throws {InvalidRequestError} `partyTotals` is given and not a boolean (`invalid_argument`).
 */
export function checkedPartyTotals(partyTotals: unknown): boolean {
  if (partyTotals === undefined) return false;
  if (typeof partyTotals === "boolean") return partyTotals;
  throw invalid(`partyTotals is true or false, not ${JSON.stringify(partyTotals)}.`);
}

/** The SHA-256 digest of bytes, as the server names stored objects. */
async function digestOf(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return `sha256:${Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** The columns every data file holds. */
const REQUIRED_COLUMNS = ["time_period", "value"] as const;

/** The column types a data file's `value` column may have. */
const VALUE_KINDS: ReadonlySet<ColumnType["kind"]> = new Set(["int", "float", "decimal", "null"]);

/** The rows a manifest's coverage counts, or 0 when it counts none or gives no count. */
function countedRows(manifest: Manifest): number {
  const coverage = manifest["coverage"];
  const rows = isRecord(coverage) ? coverage["rows"] : undefined;
  return Number.isSafeInteger(rows) && (rows as number) > 0 ? (rows as number) : 0;
}

/**
 * Checks that a member's downloaded artifact is a dataset's table: Parquet the client reads,
 * with distinct column names, `time_period` and `value` columns, rows when the manifest's
 * coverage counts some, and, when it holds rows, a numeric `value`. The server writes every
 * column of an empty file as a string, so the type of `value` is checked only in a file with
 * rows.
 *
 * @throws {ContractError} The bytes do not decode as Parquet (`unexpected_response`), or the file
 *   is not such a table or holds a column of a type the client cannot read
 *   (`contract_violation`).
 */
export function checkArtifact(data: Uint8Array, manifest: Manifest, digest: string): void {
  const name = `The artifact ${capped(digest)} of ${capped(specIdOf(manifest))}`;
  let file: ParquetFile;
  try {
    file = readParquet(data);
  } catch (error) {
    if (!(error instanceof DfoError) || error.code !== UNEXPECTED_RESPONSE) throw error;
    throw clientError(UNEXPECTED_RESPONSE, { detail: `${name}: ${error.detail}`, cause: error });
  }
  const fault = artifactFault(file, countedRows(manifest));
  if (fault !== undefined) {
    throw clientError("contract_violation", { detail: `${name} ${fault}.` });
  }
}

function artifactFault({ columns, rows }: ParquetFile, counted: number): string | undefined {
  const missing = REQUIRED_COLUMNS.find((name) => !columns.some((column) => column.name === name));
  if (missing !== undefined) return `holds no ${missing} column`;
  if (rows === 0) {
    return counted > 0 ? `holds no rows, and its manifest counts ${counted}` : undefined;
  }
  const value = columns.find((column) => column.name === "value")!;
  if (!VALUE_KINDS.has(value.type.kind)) {
    return `holds a ${value.type.kind} value column, not numbers`;
  }
  return undefined;
}

/**
 * Downloads a file through the route that redirects to it, checked against its digest. The
 * route ask is an API request, which retries as one and waits the client's timeout per attempt;
 * its failure raises. The URL it names is fetched once, bare on the storage host and with the
 * client's headers on the API's origin, reading until the fetch's deadline, if any, while a byte
 * arrives at least every `DOWNLOAD_STALL_MS`; in a browser that
 * hid the redirect, that one fetch asks the route again with the key alone and the browser
 * follows the redirect. A retryable failure of that fetch, or bytes that do not hash to the
 * digest, ask the route again and fetch once more, with no wait of their own, and a second
 * failure raises: `download_failed` for a refused signed URL, `digest_mismatch` for the bytes.
 * Reading stops once the decoded file passes `size`, the manifest's `bytes` for the artifact,
 * or `DEFAULT_MAX_BYTES` when that is smaller or `size` is not a byte count, and raises
 * `response_too_large`. The limit bounds the response that carries the file; a redirect or a
 * refusal is read under `JSON_BODY_MAX_BYTES`, as on any other route.
 */
export async function download(
  transport: Transport,
  target: Target,
  digest: string,
  wait: Wait,
  size?: unknown,
): Promise<Uint8Array<ArrayBuffer>> {
  const maxBytes =
    typeof size === "number" && Number.isSafeInteger(size) && size >= 0
      ? Math.min(size, DEFAULT_MAX_BYTES)
      : DEFAULT_MAX_BYTES;
  const ask = { ...wait, maxBytes };
  let failure: DfoError | undefined;
  for (let round = 0; round < 2; round += 1) {
    const located = await transport.locate({ ...target, ...ask });
    let data: Uint8Array<ArrayBuffer>;
    if (located.data === undefined) {
      try {
        data = await transport.fetchSigned(located.signed, {
          ...ask,
          timeout: wait.timeout ?? Infinity,
          stall: DOWNLOAD_STALL_MS,
          follow: located.follow,
        });
      } catch (error) {
        if (!(error instanceof DfoError) || !error.retryable || passedDeadline(error)) throw error;
        failure = error;
        continue;
      }
    } else {
      data = located.data;
    }
    const found = await digestOf(data);
    if (found === digest) return data;
    failure = clientError(DIGEST_MISMATCH, {
      detail: `The file at ${transport.url(target).pathname} hashes to ${found}, not ${digest}.`,
    });
  }
  throw failure!;
}

function definitionOf(manifest: Manifest): Readonly<Record<string, unknown>> {
  // readManifest has checked the definition is an object with a spec_id.
  return manifest["definition"] as Record<string, unknown>;
}

export const specIdOf = (manifest: Manifest): string => String(definitionOf(manifest)["spec_id"]);
export const contentVersionOf = (manifest: Manifest): string => String(manifest["content_version"]);

/** The artifact a manifest lists for a rendering, and with a digest when given. Artifacts
 *  match on `renderingMatches`: format, bundle and frame layout, whatever party totals they
 *  leave out. */
export function pickArtifact(
  manifest: Manifest,
  rendering: Rendering,
  digest?: string,
): Record<string, unknown> | undefined {
  // readManifest has checked `artifacts` is a list.
  const artifacts = manifest["artifacts"] as unknown[];
  return artifacts
    .filter(isRecord)
    .find(
      (artifact) =>
        renderingMatches(rendering, artifact["rendering"]) &&
        (digest === undefined || artifact["artifact_digest"] === digest),
    );
}

/** Passes a manifest's warnings above `info` to the handler as `DataWarning`s, or raises the
 *  first under strict. Each carries `traceId`, the trace id of the response that carried the
 *  manifest. */
export function noteWarnings(
  transport: Transport,
  { manifest, traceId }: Built,
  strict: boolean,
): void {
  for (const { code, message, severity } of manifestWarningsOf(manifest["warnings"])) {
    if (severity === "info") continue;
    const warning = new DataWarning(code, message, severity, traceId);
    if (strict) throw warning;
    transport.warn(warning);
  }
}

const sameEntities = (a: readonly string[], b: readonly string[]): boolean => {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((entity) => right.has(entity));
};

/** The held entity groups a built definition keeps: the group of each role the built identity
 *  binds to the same entities as the held definition. A role the build rebound or dropped loses
 *  its group, since the server drops a posted group whose members differ from the role's entities. */
function keptEntityGroups(
  held: Held | undefined,
  built: Readonly<Record<string, unknown>>,
): Record<string, EntityGroup> {
  if (held?.entityGroups == null) return {};
  const before = boundRoles(held.spec.definition);
  const after = boundRoles(built);
  return Object.fromEntries(
    Object.entries(held.entityGroups).filter(([role]) => {
      const now = after.get(role);
      return now !== undefined && sameEntities(now, before.get(role) ?? []);
    }),
  );
}

/**
 * Search's sentence for a built identity, from resubmitting it with the held spec's groups that
 * `keptEntityGroups` keeps, which are none for a build read by its operation id. Search answers one definite
 * part of the same `spec_id`, or one `no_data` part for a build whose manifest counts no rows,
 * such as a window before the data starts; that part's sentence labels the empty dataset.
 *
 * @throws {ContractError} Search did not answer with one definite part of the same `spec_id`
 *   and a sentence, or, for a build that counts no rows, one `no_data` part with a sentence.
 */
async function sentenceFor(
  transport: Transport,
  manifest: Manifest,
  parts: readonly string[],
  held: Held | undefined,
  wait: Wait,
): Promise<string> {
  const definition = definitionOf(manifest);
  const specId = specIdOf(manifest);
  const groups = keptEntityGroups(held, definition);
  const response = await transport.request({
    path: RESOLVE_PATH,
    json: {
      schema_version: RESOLVE_SCHEMA_VERSION,
      input: {
        kind: "dataset_resubmit",
        entries: [
          {
            entry_kind: "identity",
            variable_text: parts[0] ?? UNNAMED_PART,
            identity: definition["identity"],
            ...(Object.keys(groups).length === 0 ? {} : { entity_groups: groups }),
          },
        ],
      },
    },
    ...wait,
  });
  return describing(response.traceId, () => {
    const answer = response.body;
    let sentence: unknown;
    if (isRecord(answer) && answer["kind"] === "resolution") {
      checkStrict("Resolution", answer);
      // checkStrict has checked `parts` is a list and a definite part holds a spec.
      const resolved = answer["parts"] as unknown[];
      const [part] = resolved;
      if (resolved.length === 1 && isRecord(part) && part["status"] === "definite") {
        const spec = part["spec"] as Record<string, unknown>;
        const meta = spec["resolved"];
        if (spec["spec_id"] === specId && isRecord(meta)) sentence = meta["rendered_sentence"];
      } else if (
        resolved.length === 1 &&
        isRecord(part) &&
        part["status"] === "no_data" &&
        countedRows(manifest) === 0
      ) {
        // A build that holds no observations. Search names what it checked and found empty.
        sentence = part["rendered_sentence"];
      }
    }
    if (!isText(sentence)) {
      throw clientError("contract_violation", {
        detail:
          `Search did not resolve the built identity ${capped(specId)} to itself, or to one no_data ` +
          "part, with a sentence.",
      });
    }
    return sentence;
  });
}

/** The spec a build posted, with the entity groups the caller holds for it. */
type Held = {
  readonly spec: Spec;
  readonly entityGroups?: EntityGroups | null | undefined;
};

export type Finishing = {
  readonly parts: readonly string[];
  /** The spec the build posted, or undefined for a build read by its operation id. */
  readonly posted: Held | undefined;
  readonly sentence: string | null | undefined;
  readonly rendering: Rendering;
  readonly strict: boolean;
  readonly answerFacts?: readonly PartFacts[];
};

/** Downloads a built version's artifact and gives it Search's sentence, within `downloadBuilt`'s
 *  time. The manifest's warnings and its artifact's `url` are checked before any request. */
export async function finish(
  transport: Transport,
  built: Built,
  { parts, posted, sentence, rendering, strict, answerFacts }: Finishing,
  wait: Wait,
): Promise<FetchedMember> {
  const { manifest } = built;
  const definition = definitionOf(manifest);
  const specId = specIdOf(manifest);
  const contentVersion = contentVersionOf(manifest);
  noteWarnings(transport, built, strict);
  const { artifact, route } = describing(built.traceId, () => {
    const found = pickArtifact(manifest, rendering);
    if (found === undefined) {
      throw clientError("contract_violation", {
        detail:
          `The manifest of ${capped(specId)} at ${contentVersion} lists no ` +
          `${JSON.stringify(mintOptions(rendering))} artifact.`,
      });
    }
    return { artifact: found, route: transport.originUrl(String(found["url"])) };
  });
  const known = posted?.spec.spec_id === specId && isText(sentence);
  const digest = String(artifact["artifact_digest"]);
  const { told, data } = await downloadBuilt(transport, built, wait, async (within) => ({
    told: known ? sentence : await sentenceFor(transport, manifest, parts, posted, within),
    data: await download(transport, { url: route.href }, digest, within, artifact["bytes"]),
  }));
  checkArtifact(data, manifest, digest);
  return {
    parts,
    spec: { spec_id: specId, definition },
    sentence: told,
    contentVersion,
    manifest,
    digest,
    rendering,
    data,
    ...(answerFacts === undefined ? {} : { answerFacts }),
  };
}

/** The same refusal with hints, each a sentence, added to its detail and its message, which
 *  keeps the field the refusal's pointer names and the bracket with its code and trace id. */
function withHint(error: DfoError, ...hints: readonly string[]): DfoError {
  const ErrorClass = error.constructor as new (options: DfoErrorOptions) => DfoError;
  const hinted = (text: string) => `${text.replace(/[.\s]*$/, ".")} ${hints.join(" ")}`;
  return new ErrorClass({
    ...optionsOf(error),
    detail: hinted(error.detail),
    message: hinted(messageOf(error)),
  });
}

/** The code of a refusal of a role's entities the graph does not hold. */
const INVALID_ROLE_REF = "invalid_role_ref";

/**
 * A build's refusal with what helps the caller fix the narrowing: the alternatives the server
 * offers and the nearest of them to what the caller posted, and, for a role's entity the graph
 * does not hold, the lookup that turns a name into a dcid. A value with no `/` reads as a name,
 * since a place's dcid names its namespace, as `country/DEU` does. Any other error stays as it
 * is.
 */
function narrowingRefusal(error: unknown, narrowing: Narrowing): unknown {
  if (!(error instanceof InvalidRequestError)) return error;
  const posted = Object.values(narrowing.entities ?? {}).flatMap((dcids) =>
    Array.isArray(dcids) ? dcids.filter(isText).map((dcid) => dcid.trim()) : [],
  );
  const hints: string[] = [];
  const offered = [error.alternatives, ...error.issues.map((issue) => issue.alternatives ?? [])]
    .flat()
    .filter((item) => isRecord(item) && isText(item.ref) && typeof item.label === "string");
  if (offered.length > 0) {
    const asked = [
      ...posted,
      ...Object.entries(narrowing.facets ?? {})
        .flat()
        .filter(isText),
    ];
    const refs = offered.map((item) => item.ref);
    const near = asked.map((word) => nearest(word, refs)).find((ref) => ref !== undefined);
    if (near !== undefined) hints.push(`Did you mean ${JSON.stringify(near)}?`);
    hints.push(
      `The server offers ${offered.map(({ ref, label }) => `${ref} (${label})`).join(", ")}.`,
    );
  }
  const name =
    error.code === INVALID_ROLE_REF ? posted.find((dcid) => !dcid.includes("/")) : undefined;
  if (name !== undefined) {
    hints.push(`Entities take dcids; client.lookup.resolve(${JSON.stringify(name)}) finds one.`);
  }
  return hints.length === 0 ? error : withHint(error, ...hints);
}

/** One entry per `spec_id`, in first-seen order, with the parts merged. */
function distinct(members: readonly MemberRequest[]): MemberRequest[] {
  const merged = new Map<string, MemberRequest>();
  for (const member of members) {
    const seen = merged.get(member.spec.spec_id);
    merged.set(
      member.spec.spec_id,
      seen === undefined
        ? member
        : {
            parts: [...seen.parts, ...member.parts.filter((part) => !seen.parts.includes(part))],
            spec: seen.spec,
            sentence: seen.sentence ?? member.sentence,
            entityGroups: seen.entityGroups ?? member.entityGroups,
            answerParts: [...(seen.answerParts ?? []), ...(member.answerParts ?? [])],
          },
    );
  }
  return [...merged.values()];
}

/**
 * Builds the latest version of each spec and assembles one dataset. A spec listed twice builds
 * once, answering both parts.
 *
 * @throws {InvalidRequestError} `layout: "frame"` with several members, or a build the server
 *   refused as malformed.
 * @throws {DfoTimeoutError} The deadline passed.
 * @throws {DfoError} The server refused a request.
 */
export async function fetchMembers(
  transport: Transport,
  members: readonly MemberRequest[],
  options: FetchMembersOptions = {},
): Promise<Dataset> {
  const layout = options.layout ?? "long";
  const rendering = renderingFor(layout, !checkedPartyTotals(options.partyTotals));
  const wants = distinct(members);
  if (wants.length === 0) throw invalid("A fetch needs at least one spec.");
  if (layout === "frame" && wants.length > 1) {
    throw invalid('layout "frame" holds one reading; fetch each spec on its own for its frame.');
  }
  const narrowing = options.narrowing ?? {};
  const wait = waitFor(transport, options);
  const fetched: FetchedMember[] = [];
  for (const { parts, spec, sentence, entityGroups, answerParts } of wants) {
    const scope = scopeOf(spec, narrowing);
    let built: Built;
    try {
      built = await build(transport, buildBody(spec, rendering, scope), {
        ...wait,
        onProgress: options.onProgress,
      });
    } catch (error) {
      if (error instanceof DfoError && error.code === "member_not_resolvable") {
        throw withHint(error, SEARCH_AGAIN);
      }
      throw narrowingRefusal(error, narrowing);
    }
    const finishing = {
      parts,
      posted: { spec, entityGroups },
      sentence,
      rendering,
      strict: options.strict ?? false,
      ...(answerParts === undefined ? {} : { answerFacts: answerParts.map(partFacts) }),
    };
    try {
      fetched.push(await finish(transport, built, finishing, wait));
    } catch (error) {
      // Search refuses an entity of the built identity when it resubmits it for its sentence.
      throw narrowingRefusal(error, narrowing);
    }
  }
  return new Dataset(fetched, {
    layout,
    ...(options.missing === undefined ? {} : { missing: options.missing }),
  });
}
