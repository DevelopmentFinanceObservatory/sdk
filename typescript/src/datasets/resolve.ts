/**
 * Fetching a target: a spec through the build path in `fetch.ts`, or the exact versions a ref
 * names.
 *
 * A ref returns the versions it names, found in this order: the snapshot route, then the files
 * route at the stored digest; the file selector, which renders the version again from its
 * stored frame; a fresh build, which must return the same version; otherwise
 * `VersionUnavailableError`, naming the newest version in the member's rendering. A rebuilt
 * file whose digest differs from the ref's issues a `DfoWarning` (`ref_digest_changed`) naming
 * both, since the ref pins the version and the digest names one rendering of it. The steps
 * after the snapshot run only for a version whose file has expired. A version the server never
 * built (`snapshot_not_found`) raises at once. A snapshot or build that answers another spec
 * raises `ContractError`, so a recovered member keeps the ref's identity.
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
  optionsOf,
  VersionUnavailableError,
} from "../core/errors.ts";
import {
  buildBody,
  checkArtifact,
  checkedSpec,
  contentVersionOf,
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
import type { CallOptions, FetchOptions, Narrowing, SpecInput } from "./fetch.ts";
import { build, deadlineOf, readManifest } from "./operation.ts";
import type { Built, Manifest, Wait } from "./operation.ts";
import { CONTENT_VERSION, DatasetRef, fileParams, layoutOf, mintOptions } from "../core/ref.ts";
import type { Layout, Rendering, RefMember } from "../core/ref.ts";
import { describing } from "../core/trace.ts";
import type { Transport } from "../http/transport.ts";
import { isRecord, present } from "../core/json.ts";
import { clientWarning } from "../core/warnings.ts";

/** Refusals after which a stored version's lookup goes on. The version exists, but its file
 *  has expired. An unknown version (`snapshot_not_found`) ends the lookup. */
const FILE_EXPIRED = "artifact_expired";
const FILE_GONE = new Set([FILE_EXPIRED, "artifact_not_found", "not_found"]);
/**
 * Fetches a spec's latest version, or the exact versions a ref names.
 *
 * @throws {InvalidRequestError} The target is neither a ref nor a spec `checkedSpec` accepts, or a
 *   ref is narrowed or given another layout or `withoutPartyTotals`.
 * @throws {VersionUnavailableError} A ref's version can no longer be fetched.
 * @throws {DfoError} The server refused a request.
 */
export async function fetchDataset(
  transport: Transport,
  target: SpecInput | DatasetRef,
  options: FetchOptions = {},
): Promise<Dataset<never>> {
  const { window, entities, facets, ...rest } = options;
  const narrowing: Narrowing = present({ window, entities, facets });
  if (target instanceof DatasetRef) {
    if (narrows(narrowing)) {
      throw invalid(
        "A DatasetRef names exact versions and takes no narrowing; narrow the spec instead.",
      );
    }
    return fetchRef(transport, target, rest);
  }
  const spec = checkedSpec(target);
  const member = {
    parts: [],
    spec,
    sentence: spec.resolved?.rendered_sentence,
    entityGroups: spec.resolved?.entity_groups,
  };
  return fetchMembers(transport, [member], { ...rest, narrowing });
}

function refLayout(ref: DatasetRef): Layout {
  const layouts = new Set<Layout>();
  for (const member of ref.members) {
    if (member.rendering.format !== "parquet" || member.rendering.bundle) {
      throw invalid(
        `The DatasetRef stores ${member.spec.spec_id} as ` +
          `${JSON.stringify(mintOptions(member.rendering))}; this client reads bare Parquet.`,
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
): Promise<Dataset<never>> {
  const layout = refLayout(ref);
  if (options.layout !== undefined && options.layout !== layout) {
    throw invalid(
      `The DatasetRef holds the ${layout} layout, not "${options.layout}"; fetch its specs for ` +
        "another layout.",
    );
  }
  const { withoutPartyTotals } = options;
  for (const member of ref.members) {
    const held = member.rendering.without_party_totals === true;
    if (withoutPartyTotals !== undefined && withoutPartyTotals !== held) {
      throw invalid(
        `The DatasetRef holds ${member.spec.spec_id} with withoutPartyTotals ${held}, not ` +
          `${JSON.stringify(withoutPartyTotals)}; fetch its specs for the other rendering.`,
      );
    }
  }
  const wait = { deadline: deadlineOf(transport, options.timeout), signal: options.signal };
  const fetched: FetchedMember[] = [];
  for (const member of ref.members) {
    fetched.push(await fetchVersion(transport, member, options, wait));
  }
  return new Dataset<never>(fetched, { layout });
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
    if (file.data !== undefined) {
      checkArtifact(file.data, found.manifest, member.digest);
      return stored(member, found.manifest, file.data);
    }
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
      const fetched = await finish(transport, built, finishing, wait);
      if (fetched.digest !== member.digest) noteNewDigest(transport, member, fetched.digest);
      return fetched;
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
    newest = await newestVersion(transport, member.spec.spec_id, member.rendering, wait);
  }
  throw unavailable(member, newest, refusal);
}

/** Issues the client's warning that a rebuilt file differs from the ref's. The rebuild returned
 *  the ref's version, so the rows are the version the ref names, rendered to bytes with another
 *  digest. The data is returned, so strict does not raise it. */
function noteNewDigest(transport: Transport, member: RefMember, digest: string): void {
  transport.warn(
    clientWarning(
      "ref_digest_changed",
      `${member.spec.spec_id} at ${member.contentVersion} was rebuilt as ${digest}, not the ` +
        `ref's ${member.digest}; the version is the same, and dataset.ref names the rebuilt file.`,
    ),
  );
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
    signal,
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
      return {
        data: await download(
          transport,
          { url: route.href },
          member.digest,
          wait,
          artifact["bytes"],
        ),
      };
    } catch (error) {
      if (!(error instanceof DfoError) || !FILE_GONE.has(error.code)) throw error;
      refusal = error;
    }
  }
  const query = new URLSearchParams(
    Object.entries(fileParams(member.rendering)).map(([name, value]) => [name, String(value)]),
  );
  const selector = `/datasets/${member.spec.spec_id}/${member.contentVersion}/file?${query}`;
  // The selector's rendering can outgrow the stored artifact, so its cap is the default one.
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
/** The most versions pages a newest-version lookup reads. Past them the lookup reports no
 *  newest version. */
export const VERSIONS_PAGE_BUDGET = 20;

/**
 * @internal The newest stored version of a spec in a rendering, or null. The versions route
 * lists versions newest first, `VERSIONS_PAGE` to a page, and each page's `next_cursor` names
 * the next. Each version names the rendering it is: `plain`, `without_party_totals` for a
 * party-totals cut, `groupby` or `not_recorded`. The newest version is the first listed in the
 * rendering a ref member holds, `plain` or `without_party_totals`. A list that ends without
 * one, a `NotFoundError`, or `VERSIONS_PAGE_BUDGET` pages read without one, reads as none. A
 * ref's lookup reads it, and the contract replay runs its `newest_version` step through it.
 *
 * @throws {ContractError} A page is not a `DatasetVersionsPage` this client can read: no
 *   `versions` list, a listed version whose `content_version` is not a version id or that has no
 *   `rendering` string, or a `next_cursor` that is neither a string nor null, or names a page
 *   already read.
 */
export async function newestVersion(
  transport: Transport,
  specId: string,
  rendering: Rendering,
  { deadline, signal }: Wait,
): Promise<string | null> {
  const wanted = rendering.without_party_totals === true ? "without_party_totals" : "plain";
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let read = 0; read < VERSIONS_PAGE_BUDGET; read += 1) {
    const query = new URLSearchParams({ limit: String(VERSIONS_PAGE) });
    if (cursor !== null) query.set("cursor", cursor);
    let body: unknown;
    let traceId: string | null;
    try {
      ({ body, traceId } = await transport.request({
        path: `/datasets/${specId}/versions?${query}`,
        deadline,
        signal,
      }));
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
    const page = readVersionsPage(body, specId, wanted, traceId);
    if (page.newest !== null || page.nextCursor === null) return page.newest;
    if (seen.has(page.nextCursor)) throw unreadable(specId, "/next_cursor", traceId);
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  return null;
}

/** The first version a versions page lists in the wanted rendering, or null, and the page's
 *  `next_cursor`. */
function readVersionsPage(
  body: unknown,
  specId: string,
  wanted: string,
  traceId: string | null,
): { newest: string | null; nextCursor: string | null } {
  const versions = isRecord(body) ? body["versions"] : undefined;
  if (!isRecord(body) || !Array.isArray(versions)) throw unreadable(specId, "/versions", traceId);
  let newest: string | null = null;
  for (const [index, version] of (versions as unknown[]).entries()) {
    const entry = isRecord(version) ? version : {};
    const contentVersion = entry["content_version"];
    if (typeof contentVersion !== "string" || !CONTENT_VERSION.test(contentVersion)) {
      throw unreadable(specId, `/versions/${index}/content_version`, traceId);
    }
    const listed = entry["rendering"];
    if (typeof listed !== "string") {
      throw unreadable(specId, `/versions/${index}/rendering`, traceId);
    }
    if (listed === wanted) newest ??= contentVersion;
  }
  const nextCursor = body["next_cursor"] ?? null;
  if (nextCursor !== null && typeof nextCursor !== "string") {
    throw unreadable(specId, "/next_cursor", traceId);
  }
  return { newest, nextCursor };
}

function unreadable(specId: string, pointer: string, traceId: string | null): DfoError {
  return clientError("contract_violation", {
    detail: `The versions of ${specId} are not a DatasetVersionsPage: ${pointer} cannot be read.`,
    pointer,
    traceId,
  });
}

function unavailable(
  member: RefMember,
  newest: string | null,
  refusal: DfoError | undefined,
): VersionUnavailableError {
  const hint =
    newest === null
      ? ""
      : newest === member.contentVersion
        ? "; the server lists it as the newest version"
        : `; the newest version is ${newest}, which fetching the spec returns`;
  const detail = `${member.spec.spec_id} at ${member.contentVersion} can no longer be fetched${hint}.`;
  if (refusal === undefined) {
    return clientError("version_unavailable", { detail, newestVersion: newest });
  }
  // The server's refusal names why the file is gone; its code stays on the error.
  return new VersionUnavailableError({
    ...optionsOf(refusal),
    detail,
    retryable: false,
    retryAfterMs: null,
    newestVersion: newest,
  });
}
