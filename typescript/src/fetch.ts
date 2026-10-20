/**
 * Fetching datasets: building a spec's latest version, or a ref's exact versions.
 *
 * A spec builds its latest version as bare Parquet, narrowed by `window`, `entities` and
 * `facets`. A narrowing gives the build its own `spec_id`, so the member keeps the spec, the
 * version and the definition the server answered with.
 *
 * A ref returns the versions it names, found in this order: the snapshot route, then the files
 * route at the stored digest; the file selector, which renders the version again from its
 * stored frame; a fresh build, which must return the same version; otherwise
 * `VersionUnavailableError`, naming the newest version. The steps after the snapshot run only
 * for a version whose file has expired: a version the server never built
 * (`snapshot_not_found`) raises at once.
 *
 * Each member's sentence is Search's: the one the caller holds when the built `spec_id` equals
 * the posted one, else the sentence Search gives the built identity when it is resubmitted,
 * checked on `spec_id`. Every download is a bare request to the signed URL the files route
 * redirects to, checked against its digest before the fetch returns. Members build one after
 * another, under one deadline.
 */

import type { Gap } from "./answer.ts";
import { Dataset } from "./dataset.ts";
import type { FetchedMember } from "./dataset.ts";
import {
  clientError,
  DfoError,
  InvalidRequestError,
  NotFoundError,
  PermissionDeniedError,
  VersionUnavailableError,
} from "./errors.ts";
import type { ClientErrorCode, DfoErrorOptions } from "./errors.ts";
import {
  build,
  DEFAULT_FETCH_TIMEOUT_MS,
  readManifest,
  resumeOperation,
  startOperation,
} from "./operation.ts";
import type { Manifest, Operation, ProgressHandler } from "./operation.ts";
import { DatasetRef, layoutOf, renderingFor, renderingMatches, renderingOptions } from "./ref.ts";
import type { Layout, RefMember, Rendering, SpecLike } from "./ref.ts";
import { checkStrict } from "./strict.ts";
import type { Target, Transport } from "./transport.ts";
import type { Part } from "./wire.ts";
import { DfoWarning } from "./warnings.ts";

/** A year range, or every year, or the latest year. */
export type Window = "all" | "latest" | readonly [startYear: number, endYear: number];

/** How a fetch narrows a spec. The server builds a narrowed spec with its own `spec_id`. */
export type Narrowing = {
  window?: Window;
  /** Role names bound to dcids, as `{ recipient: ["country/NGA"] }`. */
  entities?: Readonly<Record<string, readonly string[]>>;
  /** Facet axes (`provenance`, `measurementMethod`, `unit`) bound to a reference; null binds
   *  the facets that declare no value on the axis. */
  facets?: Readonly<Record<string, string | null>>;
};

/** A spec to fetch, with Search's sentence for it when the caller holds one. */
export type SpecInput = SpecLike & { readonly sentence?: string | null | undefined };

/** One reading to build: the answer parts it answers, its spec, and its sentence if known. */
export type MemberRequest = {
  readonly parts: readonly string[];
  readonly spec: SpecLike;
  readonly sentence?: string | null | undefined;
  /** The answer parts the reading answers, when it comes from an answer. */
  readonly answerParts?: readonly Part[];
};

type CallOptions = {
  signal?: AbortSignal;
  /** The longest the fetch takes, in milliseconds; `Infinity` for no limit. Defaults to 30
   *  minutes. */
  timeout?: number;
  onProgress?: ProgressHandler;
  /** Raises the first dataset warning instead of passing it to the warning handler. */
  strict?: boolean;
  layout?: Layout;
};

export type FetchOptions = CallOptions & Narrowing;

export type FetchMembersOptions<TMissing extends Gap> = CallOptions & {
  /** The parts a partial fetch leaves out; the dataset is complete when there are none. */
  missing?: readonly TMissing[];
  /** The build request's `scope`, applied to every member. */
  narrowing?: Narrowing;
};

export type MintOptions = Narrowing & {
  layout?: Layout;
  strict?: boolean;
  signal?: AbortSignal;
  onProgress?: ProgressHandler;
};

export type ResumeOptions = Omit<MintOptions, keyof Narrowing>;

type Wait = { readonly deadline: number; readonly signal?: AbortSignal | undefined };

/** The variable text an identity resubmit sends for a spec no answer part names. Search
 *  echoes it onto the part, and it does not change the sentence. */
const UNNAMED_PART = "dataset";

/** Refusals after which a stored version's lookup goes on: the version exists, but its file
 *  has expired. An unknown version (`snapshot_not_found`) ends the lookup. */
const FILE_EXPIRED = "artifact_expired";
const FILE_GONE = new Set([FILE_EXPIRED, "artifact_not_found", "not_found"]);
const DIGEST_MISMATCH = "digest_mismatch" satisfies ClientErrorCode;

const SEARCH_AGAIN =
  " The server can no longer build this reading; search the question again for a current one.";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const invalid = (detail: string): InvalidRequestError =>
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

/** The build request's `scope` for a narrowing, or undefined when it narrows nothing. */
function scopeOf({ window, entities, facets }: Narrowing): Record<string, unknown> | undefined {
  const scope: Record<string, unknown> = {};
  if (window !== undefined) scope["window"] = windowScope(window);
  if (entities !== undefined) {
    for (const [role, dcids] of Object.entries(entities)) {
      if (!Array.isArray(dcids)) {
        throw invalid(`entities.${role} is not a list; bind the role to a list of dcids.`);
      }
    }
    scope["entities"] = Object.fromEntries(
      Object.entries(entities).map(([role, dcids]) => [role, [...dcids]]),
    );
  }
  if (facets !== undefined) {
    scope["facets"] = Object.fromEntries(
      Object.entries(facets).map(([axis, ref]) => [axis, { ref }]),
    );
  }
  return Object.keys(scope).length === 0 ? undefined : scope;
}

const narrows = ({ window, entities, facets }: Narrowing): boolean =>
  window !== undefined || entities !== undefined || facets !== undefined;

/** The `POST /datasets` body that builds a spec's latest version. It always carries the
 *  spec's unmodified definition, so a spec the server has not registered still builds. */
function buildBody(spec: SpecLike, rendering: Rendering, scope?: Record<string, unknown>) {
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

const deadlineOf = (transport: Transport, timeout: number | undefined): number =>
  transport.deadline({ timeout: timeout ?? DEFAULT_FETCH_TIMEOUT_MS });

/** The SHA-256 digest of bytes, as the server names stored objects. */
async function digestOf(data: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data.slice()));
  return `sha256:${Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Downloads a file through the route that redirects to it, checked against its digest. The
 * transport fetches the signed URL bare and asks the route again when that fetch fails; bytes
 * that do not hash to the digest ask the route once more.
 */
async function download(
  transport: Transport,
  target: Target,
  digest: string,
  { deadline, signal }: Wait,
): Promise<Uint8Array> {
  let found = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const data = await transport.download({
      ...target,
      deadline,
      ...(signal === undefined ? {} : { signal }),
    });
    found = await digestOf(data);
    if (found === digest) return data;
  }
  throw clientError(DIGEST_MISMATCH, {
    detail: `The file at ${transport.url(target).pathname} hashes to ${found}, not ${digest}.`,
    retryable: true,
  });
}

function definitionOf(manifest: Manifest): Readonly<Record<string, unknown>> {
  // readManifest has checked the definition is an object with a spec_id.
  return manifest["definition"] as Record<string, unknown>;
}

const specIdOf = (manifest: Manifest): string => String(definitionOf(manifest)["spec_id"]);
const contentVersionOf = (manifest: Manifest): string => String(manifest["content_version"]);

/** The artifact a manifest lists for a rendering, or for a digest when given. Artifacts match
 *  on format, bundle and frame layout, never on the whole rendering object. */
function pickArtifact(
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

/** Passes a manifest's warn-level warnings to the handler, or raises the first under strict. */
function noteWarnings(transport: Transport, manifest: Manifest, strict: boolean): void {
  const warnings = manifest["warnings"];
  for (const notice of Array.isArray(warnings) ? warnings : []) {
    if (!isRecord(notice) || notice["severity"] === "info") continue;
    const warning = new DfoWarning(String(notice["code"]), String(notice["message"]));
    if (strict) throw warning;
    transport.warn(warning);
  }
}

/**
 * Search's sentence for a built identity, from resubmitting it.
 *
 * @throws {ContractError} Search did not answer with one definite part of the same `spec_id`
 *   and a sentence.
 */
async function sentenceFor(
  transport: Transport,
  definition: Readonly<Record<string, unknown>>,
  parts: readonly string[],
  { deadline, signal }: Wait,
): Promise<string> {
  const specId = String(definition["spec_id"]);
  const response = await transport.request({
    path: "/search/resolve",
    json: {
      schema_version: 1,
      input: {
        kind: "dataset_resubmit",
        entries: [
          {
            entry_kind: "identity",
            variable_text: parts.join("; ") || UNNAMED_PART,
            identity: definition["identity"],
          },
        ],
      },
    },
    deadline,
    ...(signal === undefined ? {} : { signal }),
  });
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
      traceId: response.headers.get("x-dfo-trace-id"),
    });
  }
  return sentence;
}

type Finishing = {
  readonly parts: readonly string[];
  /** The spec the build posted, or undefined for a resumed operation. */
  readonly posted: SpecLike | undefined;
  readonly sentence: string | null | undefined;
  readonly rendering: Rendering;
  readonly strict: boolean;
  readonly answerParts?: readonly Part[];
};

/** Downloads a built version's artifact and gives it Search's sentence. */
async function finish(
  transport: Transport,
  manifest: Manifest,
  { parts, posted, sentence, rendering, strict, answerParts }: Finishing,
  wait: Wait,
): Promise<FetchedMember> {
  const definition = definitionOf(manifest);
  const specId = specIdOf(manifest);
  const contentVersion = contentVersionOf(manifest);
  noteWarnings(transport, manifest, strict);
  const artifact = pickArtifact(manifest, rendering);
  if (artifact === undefined) {
    throw clientError("contract_violation", {
      detail:
        `The manifest of ${specId} at ${contentVersion} lists no ` +
        `${JSON.stringify(renderingOptions(rendering))} artifact.`,
    });
  }
  const known = posted?.spec_id === specId && typeof sentence === "string" && sentence !== "";
  const told = known ? sentence : await sentenceFor(transport, definition, parts, wait);
  const digest = String(artifact["artifact_digest"]);
  const data = await download(transport, { url: String(artifact["url"]) }, digest, wait);
  return {
    parts,
    spec: { spec_id: specId, definition },
    sentence: told,
    contentVersion,
    manifest,
    digest,
    rendering,
    data,
    ...(answerParts === undefined ? {} : { answerParts }),
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
  const scope = options.narrowing === undefined ? undefined : scopeOf(options.narrowing);
  const wait = { deadline: deadlineOf(transport, options.timeout), signal: options.signal };
  const fetched: FetchedMember[] = [];
  for (const { parts, spec, sentence, answerParts } of wants) {
    let manifest: Manifest;
    try {
      manifest = await build(transport, buildBody(spec, rendering, scope), {
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
        manifest,
        {
          parts,
          posted: spec,
          sentence,
          rendering,
          strict: options.strict ?? false,
          ...(answerParts === undefined ? {} : { answerParts }),
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
 * Fetches a spec's latest version, or the exact versions a ref names.
 *
 * @throws {InvalidRequestError} A ref is narrowed or given another layout.
 * @throws {VersionUnavailableError} A ref's version can no longer be fetched.
 * @throws {DfoError} The server refused a request.
 */
export async function fetchDataset(
  transport: Transport,
  target: SpecInput | DatasetRef,
  options: FetchOptions = {},
): Promise<Dataset> {
  const { window, entities, facets, ...rest } = options;
  const narrowing: Narrowing = {
    ...(window === undefined ? {} : { window }),
    ...(entities === undefined ? {} : { entities }),
    ...(facets === undefined ? {} : { facets }),
  };
  if (target instanceof DatasetRef) {
    if (narrows(narrowing)) {
      throw invalid(
        "A DatasetRef names exact versions and takes no narrowing; narrow the spec instead.",
      );
    }
    return fetchRef(transport, target, rest);
  }
  return fetchMembers(transport, [{ parts: [], spec: target, sentence: target.sentence }], {
    ...rest,
    narrowing,
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
  const { layout = "long", strict = false, signal, onProgress, ...narrowing } = options;
  const rendering = renderingFor(layout);
  const finishing = { parts: [], posted: spec, sentence: spec.sentence, rendering, strict };
  return startOperation(
    transport,
    buildBody(spec, rendering, scopeOf(narrowing)),
    datasetFinisher(transport, finishing, layout),
    { deadline: transport.deadline(), signal, onProgress },
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
  const { layout = "long", strict = false, signal, onProgress } = options;
  const rendering = renderingFor(layout);
  const finishing = { parts: [], posted: undefined, sentence: undefined, rendering, strict };
  return resumeOperation(transport, operationId, datasetFinisher(transport, finishing, layout), {
    deadline: transport.deadline(),
    signal,
    onProgress,
  });
}

function datasetFinisher(transport: Transport, finishing: Finishing, layout: Layout) {
  return async (manifest: Manifest, wait: Wait): Promise<Dataset> =>
    new Dataset([await finish(transport, manifest, finishing, wait)], { layout });
}

function refLayout(ref: DatasetRef): Layout {
  const layouts = new Set<Layout>();
  for (const member of ref.members) {
    if (member.rendering.format !== "parquet" || member.rendering.bundle) {
      throw invalid(
        `The DatasetRef stores ${member.spec.spec_id} as ` +
          `${JSON.stringify(renderingOptions(member.rendering))}; this client reads bare Parquet.`,
      );
    }
    layouts.add(layoutOf(member.rendering));
  }
  if (layouts.has("frame") && ref.members.length > 1) {
    throw invalid('layout "frame" holds one reading, and this DatasetRef holds several.');
  }
  return layouts.has("frame") ? "frame" : "long";
}

async function fetchRef(
  transport: Transport,
  ref: DatasetRef,
  options: CallOptions,
): Promise<Dataset> {
  const layout = refLayout(ref);
  if (options.layout !== undefined && options.layout !== layout) {
    throw invalid(
      `The DatasetRef holds the ${layout} layout, not "${options.layout}"; fetch its specs for ` +
        "another layout.",
    );
  }
  const wait = { deadline: deadlineOf(transport, options.timeout), signal: options.signal };
  const fetched: FetchedMember[] = [];
  for (const member of ref.members) {
    fetched.push(await fetchVersion(transport, member, options, wait));
  }
  return new Dataset(fetched, { layout });
}

const stored = (member: RefMember, manifest: Manifest, data: Uint8Array): FetchedMember => ({
  parts: member.parts,
  spec: member.spec,
  sentence: member.sentence,
  contentVersion: member.contentVersion,
  manifest,
  digest: member.digest,
  rendering: member.rendering,
  data,
});

/** One stored version, through the lookup order. */
async function fetchVersion(
  transport: Transport,
  member: RefMember,
  options: CallOptions,
  wait: Wait,
): Promise<FetchedMember> {
  const strict = options.strict ?? false;
  let refusal: DfoError | undefined;

  let manifest: Manifest | undefined;
  try {
    manifest = await snapshot(transport, member, wait);
  } catch (error) {
    if (!(error instanceof DfoError) || error.code !== FILE_EXPIRED) throw error;
    refusal = error;
  }
  if (manifest !== undefined) {
    noteWarnings(transport, manifest, strict);
    const file = await storedFile(transport, member, manifest, wait);
    if (file.data !== undefined) return stored(member, manifest, file.data);
    refusal = file.refusal;
  }

  let newest: string | null;
  try {
    const built = await build(transport, buildBody(member.spec, member.rendering), {
      ...wait,
      onProgress: options.onProgress,
    });
    if (contentVersionOf(built) === member.contentVersion) {
      const finishing = {
        parts: member.parts,
        posted: member.spec,
        sentence: member.sentence,
        rendering: member.rendering,
        strict,
      };
      return await finish(transport, built, finishing, wait);
    }
    newest = contentVersionOf(built);
  } catch (error) {
    if (
      !(error instanceof InvalidRequestError) &&
      !(error instanceof NotFoundError) &&
      !(error instanceof VersionUnavailableError)
    ) {
      throw error;
    }
    refusal ??= error;
    newest = await newestVersion(transport, member.spec.spec_id, wait);
  }
  throw unavailable(member, newest, refusal);
}

async function snapshot(
  transport: Transport,
  member: RefMember,
  { deadline, signal }: Wait,
): Promise<Manifest> {
  const response = await transport.request({
    path: `/datasets/${member.spec.spec_id}/${member.contentVersion}`,
    deadline,
    ...(signal === undefined ? {} : { signal }),
  });
  const manifest = readManifest(response.body);
  const built = `${specIdOf(manifest)} at ${contentVersionOf(manifest)}`;
  const asked = `${member.spec.spec_id} at ${member.contentVersion}`;
  if (built !== asked) {
    throw clientError("contract_violation", {
      detail: `The server answered ${built} for ${asked}.`,
    });
  }
  return manifest;
}

/** The stored artifact's bytes from the files route, or else from the file selector; the
 *  files route's refusal when neither serves bytes with the stored digest. */
async function storedFile(
  transport: Transport,
  member: RefMember,
  manifest: Manifest,
  wait: Wait,
): Promise<{ data?: Uint8Array; refusal?: DfoError | undefined }> {
  let refusal: DfoError | undefined;
  const artifact = pickArtifact(manifest, member.rendering, member.digest);
  if (artifact !== undefined) {
    try {
      const url = String(artifact["url"]);
      return { data: await download(transport, { url }, member.digest, wait) };
    } catch (error) {
      if (!(error instanceof DfoError) || !FILE_GONE.has(error.code)) throw error;
      refusal = error;
    }
  }
  const query = new URLSearchParams(
    Object.entries(renderingOptions(member.rendering)).map(([name, value]) => [
      name,
      String(value),
    ]),
  );
  const selector = `/datasets/${member.spec.spec_id}/${member.contentVersion}/file?${query}`;
  try {
    return { data: await download(transport, { path: selector }, member.digest, wait) };
  } catch (error) {
    if (!(error instanceof DfoError)) throw error;
    // The selector renders the version again; bytes with another digest are not the stored
    // version's file.
    if (error.code === DIGEST_MISMATCH) return { refusal };
    if (FILE_GONE.has(error.code)) return { refusal: refusal ?? error };
    throw error;
  }
}

/** The newest stored version of a spec, from the versions route, or null. */
async function newestVersion(
  transport: Transport,
  specId: string,
  { deadline, signal }: Wait,
): Promise<string | null> {
  let body: unknown;
  try {
    ({ body } = await transport.request({
      path: `/datasets/${specId}/versions`,
      query: { limit: 1 },
      deadline,
      ...(signal === undefined ? {} : { signal }),
    }));
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof PermissionDeniedError) return null;
    throw error;
  }
  const versions = isRecord(body) ? body["versions"] : undefined;
  const listed: unknown[] = Array.isArray(versions) ? versions : [];
  const newest = isRecord(listed[0]) ? listed[0]["content_version"] : undefined;
  return typeof newest === "string" ? newest : null;
}

function unavailable(
  member: RefMember,
  newest: string | null,
  refusal: DfoError | undefined,
): VersionUnavailableError {
  const hint =
    newest === null ? "" : `; the newest version is ${newest}, which fetching the spec returns`;
  const detail = `${member.spec.spec_id} at ${member.contentVersion} can no longer be fetched${hint}.`;
  if (refusal === undefined) return clientError("version_unavailable", { detail });
  // The server's refusal names why the file is gone; its code stays on the error.
  return new VersionUnavailableError({
    code: refusal.code,
    status: refusal.status,
    detail,
    traceId: refusal.traceId,
    problem: refusal.problem,
    docsUrl: refusal.docsUrl,
    cause: refusal,
  });
}
