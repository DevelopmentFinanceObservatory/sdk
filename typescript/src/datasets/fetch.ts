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
 * and a role that `entities` rebound or dropped loses its group. Every download asks a files
 * route on the API's origin, fetches the URL it redirects to, bare on the storage host and as an
 * API request on the API's origin, and is checked against its digest before the fetch returns.
 * Members build one after another, under one deadline: each request attempt, the files route
 * ask included, waits the client's timeout within it, and a download reads until the deadline.
 */

import type { Gap } from "../search/answer.ts";
import { Dataset } from "./dataset.ts";
import type { FetchedMember } from "./dataset.ts";
import { clientError, DfoError, InvalidRequestError } from "../core/errors.ts";
import type { ClientErrorCode, DfoErrorOptions } from "../core/errors.ts";
import { build, DEFAULT_FETCH_TIMEOUT_MS, resumeOperation, startOperation } from "./operation.ts";
import type { Built, Manifest, Operation, ProgressHandler } from "./operation.ts";
import { manifestWarningsOf, partFacts } from "../core/parse.ts";
import type { PartFacts } from "../core/parse.ts";
import { renderingFor, renderingMatches, renderingOptions } from "../core/ref.ts";
import type { Layout, Rendering, SpecLike } from "../core/ref.ts";
import { checkStrict } from "../core/strict.ts";
import { describing } from "../core/trace.ts";
import { passedDeadline } from "../http/transport.ts";
import type { Target, Transport } from "../http/transport.ts";
import type { EntityGroup, Part, ResolvedSpec } from "../wire.ts";
import { DataWarning } from "../core/warnings.ts";
import { isRecord } from "../core/json.ts";

/** A year range, or every year, or the latest year. */
export type Window = "all" | "latest" | readonly [startYear: number, endYear: number];

/** How a fetch narrows a spec. The server builds a narrowed spec with its own `spec_id`. */
export type Narrowing = {
  window?: Window;
  /** Roles to rebind, as `{ origin: ["country/FRA"] }`. null unbinds a role. Every role
   *  the spec binds and this leaves out keeps its dcids, so `{}` narrows nothing. */
  entities?: Readonly<Record<string, readonly string[] | null>>;
  /** Facet axes (`provenance`, `measurementMethod`, `unit`) bound to a reference. null binds
   *  the facets that declare no value on the axis. `{}` narrows nothing. */
  facets?: Readonly<Record<string, string | null>>;
};

/** How Search resolved each role's group of places, keyed by role: a spec's
 *  `resolved.entity_groups`. */
export type EntityGroups = Readonly<Record<string, EntityGroup>>;

/** A spec to fetch, in the wire `Spec`'s shape: `candidate.spec`, a definite part's spec, or one
 *  read back from JSON. Its `resolved` gives Search's sentence and the entity groups; a spec
 *  written by hand with only `spec_id` and `definition` has neither. */
export type SpecInput = SpecLike & {
  readonly resolved?: Pick<ResolvedSpec, "rendered_sentence" | "entity_groups"> | null | undefined;
};

/** One reading to build: the answer parts it answers, its spec, and its sentence if known. */
export type MemberRequest = {
  readonly parts: readonly string[];
  readonly spec: SpecLike;
  readonly sentence?: string | null | undefined;
  /** The spec's entity groups, when the caller holds them. */
  readonly entityGroups?: EntityGroups | null | undefined;
  /** The answer parts the reading answers, when it comes from an answer. */
  readonly answerParts?: readonly Part[];
};

export type CallOptions = {
  signal?: AbortSignal;
  /** The longest the whole fetch takes, builds and downloads included, in milliseconds;
   *  `Infinity` for no limit. Defaults to 30 minutes. */
  timeout?: number;
  onProgress?: ProgressHandler;
  /** Raises the first dataset warning, a `DataWarning`, instead of passing it to the warning
   *  handler. */
  strict?: boolean;
  layout?: Layout;
};

export type FetchOptions = CallOptions & Narrowing;

export type FetchMembersOptions<TMissing extends Gap> = CallOptions & {
  /** The parts a partial fetch leaves out. The dataset is complete when there are none. */
  missing?: readonly TMissing[];
  /** The build request's `scope`, applied to every member. */
  narrowing?: Narrowing;
};

/** How a mint builds a spec. A mint builds the spec as it stands. Fetch it to narrow it. */
export type MintOptions = {
  layout?: Layout;
  signal?: AbortSignal;
  onProgress?: ProgressHandler;
};

export type ResumeOptions = MintOptions;

export type Wait = { readonly deadline: number; readonly signal?: AbortSignal | undefined };

/** The variable text an identity resubmit sends for a spec no answer part names. Search
 *  echoes it onto the part, and it does not change the sentence. */
const UNNAMED_PART = "dataset";

export const DIGEST_MISMATCH = "digest_mismatch" satisfies ClientErrorCode;

const SEARCH_AGAIN =
  " The server can no longer build this reading; search the question again for a current one.";

export const invalid = (detail: string): InvalidRequestError =>
  clientError("invalid_argument", { detail });

function windowScope(window: Window): Record<string, unknown> {
  if (window === "all" || window === "latest") return { kind: window };
  const [start, end] = window;
  if (Number.isInteger(start) && Number.isInteger(end)) {
    return { kind: "range", start_year: start, end_year: end };
  }
  throw invalid(
    `window is "all", "latest" or [startYear, endYear], not ${JSON.stringify(window)}.`,
  );
}

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
 *   bound to neither a list nor null (`invalid_argument`).
 */
function entityScope(
  spec: SpecLike,
  entities: NonNullable<Narrowing["entities"]>,
): Record<string, readonly string[]> {
  if (!isRecord(spec.definition["identity"])) {
    throw invalid(
      `The definition of ${spec.spec_id} holds no identity to rebind; use a spec from a search.`,
    );
  }
  const bound = boundRoles(spec.definition);
  for (const [role, dcids] of Object.entries(entities)) {
    if (dcids === null) {
      bound.delete(role);
    } else if (Array.isArray(dcids)) {
      bound.set(role, dcids);
    } else {
      throw invalid(`entities.${role} is not a list; bind the role to a list of dcids or null.`);
    }
  }
  return Object.fromEntries(bound);
}

/** A spec's build request `scope` for a narrowing, or undefined when it narrows nothing. */
function scopeOf(
  spec: SpecLike,
  { window, entities, facets }: Narrowing,
): Record<string, unknown> | undefined {
  const scope: Record<string, unknown> = {};
  if (window !== undefined) scope["window"] = windowScope(window);
  if (namesAny(entities)) scope["entities"] = entityScope(spec, entities);
  if (namesAny(facets)) {
    scope["facets"] = Object.fromEntries(
      Object.entries(facets).map(([axis, ref]) => [axis, { ref }]),
    );
  }
  return Object.keys(scope).length === 0 ? undefined : scope;
}

/** Whether an `entities` or `facets` map names a role or an axis; `{}` names none, and posts
 *  nothing. */
const namesAny = <TMap extends object>(map: TMap | undefined): map is TMap =>
  map !== undefined && Object.keys(map).length > 0;

export const narrows = ({ window, entities, facets }: Narrowing): boolean =>
  window !== undefined || namesAny(entities) || namesAny(facets);

/** The `POST /datasets` body that builds a spec's latest version. It always carries the
 *  spec's unmodified definition, so a spec the server has not registered still builds. */
export function buildBody(spec: SpecLike, rendering: Rendering, scope?: Record<string, unknown>) {
  return {
    schema_version: 1,
    input: {
      kind: "spec_id",
      spec_id: spec.spec_id,
      definition: spec.definition,
      ...(scope === undefined ? {} : { scope }),
    },
    options: renderingOptions(rendering),
  };
}

export const deadlineOf = (transport: Transport, timeout: number | undefined): number =>
  transport.deadlineAfter(timeout ?? DEFAULT_FETCH_TIMEOUT_MS);

/** The SHA-256 digest of bytes, as the server names stored objects. */
async function digestOf(data: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data.slice()));
  return `sha256:${Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Downloads a file through the route that redirects to it, checked against its digest. The
 * route ask is an API request, which retries as one and waits the client's timeout per attempt;
 * its failure raises. The URL it names is fetched once, bare on the storage host and with the
 * client's headers on the API's origin, reading until the fetch's deadline; in a browser that
 * hid the redirect, that one fetch asks the route again with the key alone and the browser
 * follows the redirect. A retryable failure of that fetch, or bytes that do not hash to the
 * digest, ask the route again and fetch once more, with no wait of their own, and a second
 * failure raises: `download_failed` for a refused signed URL, `digest_mismatch` for the bytes.
 */
export async function download(
  transport: Transport,
  target: Target,
  digest: string,
  { deadline, signal }: Wait,
): Promise<Uint8Array> {
  const ask = { deadline, ...(signal === undefined ? {} : { signal }) };
  let failure: DfoError | undefined;
  for (let round = 0; round < 2; round += 1) {
    const located = await transport.locate({ ...target, ...ask });
    let data: Uint8Array;
    if (located.data === undefined) {
      try {
        data = await transport.fetchSigned(located.signed, {
          ...ask,
          timeout: Infinity,
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

/** The artifact a manifest lists for a rendering, or for a digest when given. Artifacts match
 *  on format, bundle and frame layout alone. */
export function pickArtifact(
  manifest: Manifest,
  rendering: Rendering,
  digest?: string,
): Record<string, unknown> | undefined {
  // readManifest has checked `artifacts` is a list.
  const artifacts = manifest["artifacts"] as unknown[];
  return artifacts
    .filter(isRecord)
    .find((artifact) =>
      digest === undefined
        ? renderingMatches(rendering, artifact["rendering"])
        : artifact["artifact_digest"] === digest,
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
 * `keptEntityGroups` keeps, which are none for a resumed operation.
 *
 * @throws {ContractError} Search did not answer with one definite part of the same `spec_id`
 *   and a sentence.
 */
async function sentenceFor(
  transport: Transport,
  definition: Readonly<Record<string, unknown>>,
  parts: readonly string[],
  held: Held | undefined,
  { deadline, signal }: Wait,
): Promise<string> {
  const specId = String(definition["spec_id"]);
  const groups = keptEntityGroups(held, definition);
  const response = await transport.request({
    path: "/search/resolve",
    json: {
      schema_version: 1,
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
    deadline,
    ...(signal === undefined ? {} : { signal }),
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
      }
    }
    if (typeof sentence !== "string" || sentence === "") {
      throw clientError("contract_violation", {
        detail: `Search did not resolve the built identity ${specId} to itself with a sentence.`,
      });
    }
    return sentence;
  });
}

/** The spec a build posted, with the entity groups the caller holds for it. */
type Held = {
  readonly spec: SpecLike;
  readonly entityGroups?: EntityGroups | null | undefined;
};

type Finishing = {
  readonly parts: readonly string[];
  /** The spec the build posted, or undefined for a resumed operation. */
  readonly posted: Held | undefined;
  readonly sentence: string | null | undefined;
  readonly rendering: Rendering;
  readonly strict: boolean;
  readonly answerFacts?: readonly PartFacts[];
};

/** Downloads a built version's artifact and gives it Search's sentence. The manifest's warnings
 *  and its artifact's `url` are checked before any request. */
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
          `The manifest of ${specId} at ${contentVersion} lists no ` +
          `${JSON.stringify(renderingOptions(rendering))} artifact.`,
      });
    }
    return { artifact: found, route: transport.originUrl(String(found["url"])) };
  });
  const known = posted?.spec.spec_id === specId && typeof sentence === "string" && sentence !== "";
  const told = known ? sentence : await sentenceFor(transport, definition, parts, posted, wait);
  const digest = String(artifact["artifact_digest"]);
  const data = await download(transport, { url: route.href }, digest, wait);
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

/** The same refusal with a hint added to its detail. */
function withHint(error: DfoError, hint: string): DfoError {
  const ErrorClass = error.constructor as new (options: DfoErrorOptions) => DfoError;
  return new ErrorClass({
    code: error.code,
    status: error.status,
    detail: `${error.detail}${hint}`,
    traceId: error.traceId,
    retryable: error.retryable,
    retryAfterMs: error.retryAfterMs,
    problem: error.problem,
    docsUrl: error.docsUrl,
    cause: error,
  });
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
export async function fetchMembers<TMissing extends Gap = never>(
  transport: Transport,
  members: readonly MemberRequest[],
  options: FetchMembersOptions<TMissing> = {},
): Promise<Dataset<TMissing>> {
  const layout = options.layout ?? "long";
  const rendering = renderingFor(layout);
  const wants = distinct(members);
  if (wants.length === 0) throw invalid("A fetch needs at least one spec.");
  if (layout === "frame" && wants.length > 1) {
    throw invalid('layout "frame" holds one reading; fetch each spec on its own for its frame.');
  }
  const narrowing = options.narrowing ?? {};
  const wait = { deadline: deadlineOf(transport, options.timeout), signal: options.signal };
  const fetched: FetchedMember[] = [];
  for (const { parts, spec, sentence, entityGroups, answerParts } of wants) {
    let built: Built;
    try {
      built = await build(transport, buildBody(spec, rendering, scopeOf(spec, narrowing)), {
        ...wait,
        onProgress: options.onProgress,
      });
    } catch (error) {
      if (error instanceof DfoError && error.code === "member_not_resolvable") {
        throw withHint(error, SEARCH_AGAIN);
      }
      throw error;
    }
    fetched.push(
      await finish(
        transport,
        built,
        {
          parts,
          posted: { spec, entityGroups },
          sentence,
          rendering,
          strict: options.strict ?? false,
          ...(answerParts === undefined ? {} : { answerFacts: answerParts.map(partFacts) }),
        },
        wait,
      ),
    );
  }
  return new Dataset<TMissing>(fetched, {
    layout,
    ...(options.missing === undefined ? {} : { missing: options.missing }),
  });
}

/**
 * Starts a spec's build and returns it as an operation, done or running.
 *
 * @throws {DfoError} The server refused the build.
 */
export function mint(
  transport: Transport,
  spec: SpecInput,
  options: MintOptions = {},
): Promise<Operation> {
  const { layout = "long", signal, onProgress } = options;
  const rendering = renderingFor(layout);
  const finishing = {
    parts: [],
    posted: { spec, entityGroups: spec.resolved?.entity_groups },
    sentence: spec.resolved?.rendered_sentence,
    rendering,
    strict: false,
  };
  // The POST reads for up to the build's own limit. `result` sets the wait's deadline.
  return startOperation(
    transport,
    buildBody(spec, rendering),
    datasetFinisher(transport, finishing, layout),
    { deadline: Infinity, signal, onProgress },
  );
}

/**
 * Resumes a build another process started, by its operation id. The build's rendering is in
 * its id, so `layout` must be the one it was started with.
 *
 * @throws {NotFoundError} The server holds no operation with that id.
 * @throws {DfoError} The operation failed.
 */
export function resume(
  transport: Transport,
  operationId: string,
  options: ResumeOptions = {},
): Promise<Operation> {
  const { layout = "long", signal, onProgress } = options;
  const rendering = renderingFor(layout);
  const finishing = { parts: [], posted: undefined, sentence: undefined, rendering, strict: false };
  return resumeOperation(transport, operationId, datasetFinisher(transport, finishing, layout), {
    deadline: Infinity,
    signal,
    onProgress,
  });
}

function datasetFinisher(transport: Transport, finishing: Finishing, layout: Layout) {
  return async (manifest: Manifest, traceId: string | null, wait: Wait): Promise<Dataset> =>
    new Dataset([await finish(transport, { manifest, traceId }, finishing, wait)], { layout });
}
