/**
 * Fetching a target: a spec through the build path in `fetch.ts`, or the exact versions a ref
 * names.
 *
 * A ref returns the versions it names, found in this order: the snapshot route, then the files
 * route at the stored digest; the file selector, which renders the version again from its
 * stored frame; a fresh build, which must return the same version; otherwise
 * `VersionUnavailableError`, naming the newest version. The steps after the snapshot run only
 * for a version whose file has expired. A version the server never built
 * (`snapshot_not_found`) raises at once. A snapshot or build that answers another spec raises
 * `ContractError`, so a recovered member keeps the ref's identity.
 *
 * The lookup reuses the build path's download, warnings and finishing steps, so this module
 * imports `fetch.ts` and `fetch.ts` imports nothing from here.
 */

import { Dataset } from "./dataset.ts";
import type { FetchedMember } from "./dataset.ts";
import {
  clientError,
  DfoError,
  InvalidRequestError,
  NotFoundError,
  VersionUnavailableError,
} from "../core/errors.ts";
import {
  buildBody,
  contentVersionOf,
  deadlineOf,
  DIGEST_MISMATCH,
  download,
  fetchMembers,
  finish,
  invalid,
  narrows,
  noteWarnings,
  pickArtifact,
  specIdOf,
} from "./fetch.ts";
import type { CallOptions, FetchOptions, Narrowing, SpecInput, Wait } from "./fetch.ts";
import { build, readManifest } from "./operation.ts";
import type { Built, Manifest } from "./operation.ts";
import { DatasetRef, layoutOf, renderingOptions } from "../core/ref.ts";
import type { Layout, RefMember } from "../core/ref.ts";
import { describing } from "../core/trace.ts";
import type { Transport } from "../http/transport.ts";
import { isRecord } from "../core/json.ts";

/** Refusals after which a stored version's lookup goes on. The version exists, but its file
 *  has expired. An unknown version (`snapshot_not_found`) ends the lookup. */
const FILE_EXPIRED = "artifact_expired";
const FILE_GONE = new Set([FILE_EXPIRED, "artifact_not_found", "not_found"]);
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
  const member = {
    parts: [],
    spec: target,
    sentence: target.resolved?.rendered_sentence,
    entityGroups: target.resolved?.entity_groups,
  };
  return fetchMembers(transport, [member], { ...rest, narrowing });
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

  let found: Built | undefined;
  try {
    found = await snapshot(transport, member, wait);
  } catch (error) {
    if (!(error instanceof DfoError) || error.code !== FILE_EXPIRED) throw error;
    refusal = error;
  }
  if (found !== undefined) {
    noteWarnings(transport, found, strict);
    const file = await storedFile(transport, member, found, wait);
    if (file.data !== undefined) return stored(member, found.manifest, file.data);
    refusal = file.refusal;
  }

  let newest: string | null;
  try {
    const built = await build(transport, buildBody(member.spec, member.rendering), {
      ...wait,
      onProgress: options.onProgress,
    });
    describing(built.traceId, () => {
      const rebuilt = specIdOf(built.manifest);
      if (rebuilt !== member.spec.spec_id) {
        throw clientError("contract_violation", {
          detail: `The server rebuilt ${rebuilt} for ${member.spec.spec_id}.`,
          pointer: "/definition/spec_id",
        });
      }
    });
    if (contentVersionOf(built.manifest) === member.contentVersion) {
      const finishing = {
        parts: member.parts,
        posted: { spec: member.spec },
        sentence: member.sentence,
        rendering: member.rendering,
        strict,
      };
      return await finish(transport, built, finishing, wait);
    }
    newest = contentVersionOf(built.manifest);
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

/** A stored version's manifest, and the trace id of the response that carried it. */
async function snapshot(
  transport: Transport,
  member: RefMember,
  { deadline, signal }: Wait,
): Promise<Built> {
  const response = await transport.request({
    path: `/datasets/${member.spec.spec_id}/${member.contentVersion}`,
    deadline,
    ...(signal === undefined ? {} : { signal }),
  });
  const { traceId } = response;
  const manifest = describing(traceId, () => {
    const read = readManifest(response.body);
    const built = `${specIdOf(read)} at ${contentVersionOf(read)}`;
    const asked = `${member.spec.spec_id} at ${member.contentVersion}`;
    if (built !== asked) {
      throw clientError("contract_violation", {
        detail: `The server answered ${built} for ${asked}.`,
        pointer:
          specIdOf(read) === member.spec.spec_id ? "/content_version" : "/definition/spec_id",
      });
    }
    return read;
  });
  return { manifest, traceId };
}

/** The stored artifact's bytes from the files route, or else from the file selector, or the
 *  files route's refusal when neither serves bytes with the stored digest. */
async function storedFile(
  transport: Transport,
  member: RefMember,
  { manifest, traceId }: Built,
  wait: Wait,
): Promise<{ data?: Uint8Array; refusal?: DfoError | undefined }> {
  let refusal: DfoError | undefined;
  const artifact = pickArtifact(manifest, member.rendering, member.digest);
  if (artifact !== undefined) {
    const route = describing(traceId, () => transport.originUrl(String(artifact["url"])));
    try {
      return { data: await download(transport, { url: route.href }, member.digest, wait) };
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
    // The selector renders the version again, so bytes with another digest are not the stored
    // version's file.
    if (error.code === DIGEST_MISMATCH) return { refusal };
    if (FILE_GONE.has(error.code)) return { refusal: refusal ?? error };
    throw error;
  }
}

/** The versions one page of the versions route lists, the route's default page size. */
const VERSIONS_PAGE = 100;

/**
 * @internal The newest stored version of a spec, its newest plain build, or null. The versions
 * route lists versions newest first, `VERSIONS_PAGE` to a page, and each page's `next_cursor`
 * names the next. The newest version is the first listed with a null `base_content_version`, so
 * a derived version, a groupby collapse or party-totals cut of a plain build, is skipped. A list
 * that ends without a plain version, or a `NotFoundError`, reads as none. A ref's lookup reads
 * it, and the contract replay runs its `newest_version` step through it.
 *
 * @throws {ContractError} A page is not a `DatasetVersionsPage` this client can read: no
 *   `versions` list, a listed version with no `content_version` string or no
 *   `base_content_version` that is a string or null, or a `next_cursor` that is neither.
 */
export async function newestVersion(
  transport: Transport,
  specId: string,
  { deadline, signal, timeout }: Wait & { readonly timeout?: number | undefined },
): Promise<string | null> {
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ limit: String(VERSIONS_PAGE) });
    if (cursor !== null) query.set("cursor", cursor);
    let body: unknown;
    let traceId: string | null;
    try {
      ({ body, traceId } = await transport.request({
        path: `/datasets/${specId}/versions?${query}`,
        deadline,
        ...(signal === undefined ? {} : { signal }),
        ...(timeout === undefined ? {} : { timeout }),
      }));
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
    const page = readVersionsPage(body, specId, traceId);
    if (page.plain !== null) return page.plain;
    cursor = page.nextCursor;
  } while (cursor !== null);
  return null;
}

/** The first plain version a versions page lists, or null, and the page's `next_cursor`. */
function readVersionsPage(
  body: unknown,
  specId: string,
  traceId: string | null,
): { plain: string | null; nextCursor: string | null } {
  const unreadable = (pointer: string): DfoError =>
    clientError("contract_violation", {
      detail: `The versions of ${specId} are not a DatasetVersionsPage: ${pointer} cannot be read.`,
      pointer,
      traceId,
    });
  const versions = isRecord(body) ? body["versions"] : undefined;
  if (!isRecord(body) || !Array.isArray(versions)) throw unreadable("/versions");
  let plain: string | null = null;
  for (const [index, version] of (versions as unknown[]).entries()) {
    const entry = isRecord(version) ? version : {};
    const contentVersion = entry["content_version"];
    if (typeof contentVersion !== "string") {
      throw unreadable(`/versions/${index}/content_version`);
    }
    const base = entry["base_content_version"];
    if (base !== null && typeof base !== "string") {
      throw unreadable(`/versions/${index}/base_content_version`);
    }
    if (base === null) plain ??= contentVersion;
  }
  const nextCursor = body["next_cursor"] ?? null;
  if (nextCursor !== null && typeof nextCursor !== "string") throw unreadable("/next_cursor");
  return { plain, nextCursor };
}

function unavailable(
  member: RefMember,
  newest: string | null,
  refusal: DfoError | undefined,
): VersionUnavailableError {
  const hint =
    newest === null ? "" : `; the newest version is ${newest}, which fetching the spec returns`;
  const detail = `${member.spec.spec_id} at ${member.contentVersion} can no longer be fetched${hint}.`;
  if (refusal === undefined) {
    return clientError("version_unavailable", { detail, newestVersion: newest });
  }
  // The server's refusal names why the file is gone; its code stays on the error.
  return new VersionUnavailableError({
    code: refusal.code,
    status: refusal.status,
    detail,
    traceId: refusal.traceId,
    problem: refusal.problem,
    docsUrl: refusal.docsUrl,
    cause: refusal,
    newestVersion: newest,
  });
}
