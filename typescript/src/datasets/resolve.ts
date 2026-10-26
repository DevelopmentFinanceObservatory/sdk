/**
 * Fetching a target: a spec through the build path in `fetch.ts`, or the exact versions a ref
 * names. With `latest`, a ref's specs build through that path instead, in the ref's one
 * rendering, as their newest versions.
 *
 * A ref returns the versions it names, found in this order: the snapshot route, then the files
 * route at the stored digest; the file selector, which renders the version again from its
 * stored frame; a fresh build in the ref's rendering, which must return the same version;
 * otherwise `VersionUnavailableError`, naming the newest plain build. A rebuilt
 * file whose digest differs from the ref's issues a `DfoWarning` (`ref_digest_changed`) naming
 * both, since the ref pins the version and the digest names one rendering of it. The steps
 * after the snapshot run only for a version whose file has expired. A version the server never
 * built (`snapshot_not_found`) raises at once. A snapshot or build that answers another spec
 * raises `ContractError`, so a recovered member keeps the ref's identity. A snapshot that lists
 * the ref's digest under another rendering than the ref's raises `FormatError`, since the ref's
 * label and its file disagree.
 *
 * The lookup reuses the build path's download, warnings and finishing steps, so this module
 * imports `fetch.ts` and `fetch.ts` imports nothing from here.
 */

import { Dataset } from "./dataset.ts";
import type { FetchedMember } from "./dataset.ts";
import {
  capped,
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
  checkedPartyTotals,
  checkedSpec,
  contentVersionOf,
  DIGEST_MISMATCH,
  download,
  FETCH_OPTIONS,
  fetchMembers,
  finish,
  invalid,
  narrows,
  noteWarnings,
  pickArtifact,
  specIdOf,
} from "./fetch.ts";
import type { CallOptions, FetchOptions, Narrowing } from "./fetch.ts";
import { build, readManifest, waitFor } from "./operation.ts";
import type { Built, Manifest, Wait } from "./operation.ts";
import {
  CONTENT_VERSION,
  DatasetRef,
  FormatError,
  layoutOf,
  mintOptions,
  sameRendering,
} from "../core/ref.ts";
import type { Layout, Rendering, RefMember, Spec } from "../core/ref.ts";
import { checkOptions } from "../core/options.ts";
import { describing } from "../core/trace.ts";
import type { Transport } from "../http/transport.ts";
import { isRecord, present } from "../core/json.ts";
import { clientWarning } from "../core/warnings.ts";

/** The call that fetches the newest versions of a ref's specs, which a lost version names. */
const LATEST_CALL = "client.fetch(ref, { latest: true })";

/** Refusals after which a stored version's lookup goes on. The version exists, but its file
 *  has expired. An unknown version (`snapshot_not_found`) ends the lookup. */
const FILE_EXPIRED = "artifact_expired";
const FILE_GONE = new Set([FILE_EXPIRED, "artifact_not_found", "not_found"]);
/**
 * Fetches a spec's latest version, the exact versions a ref names, or with `latest` the newest
 * versions of a ref's specs.
 *
 * @throws {InvalidRequestError} The target is neither a ref nor a spec `checkedSpec` accepts, a
 *   ref is narrowed or given another layout or `partyTotals`, `latest` is given a spec or
 *   a ref whose members differ in rendering, or `latest` is not a boolean.
 * @throws {VersionUnavailableError} A ref's version can no longer be fetched.
 * @throws {DfoError} The server refused a request.
 */
export async function fetchDataset(
  transport: Transport,
  target: Spec | DatasetRef,
  options: FetchOptions = {},
): Promise<Dataset> {
  const { window, entities, facets, latest, ...rest } = checkOptions(FETCH_OPTIONS, options);
  // Null reads as unset, as None does in the Python client.
  const narrowing: Narrowing = present({
    window: window ?? undefined,
    entities: entities ?? undefined,
    facets: facets ?? undefined,
  });
  if (latest !== undefined && typeof latest !== "boolean") {
    throw invalid(`latest is true or false, not ${JSON.stringify(latest)}.`);
  }
  if (target instanceof DatasetRef) {
    if (narrowing.window !== undefined) throw invalid(refWindowRefusal(narrowing.window, latest));
    if (narrows(narrowing)) {
      throw invalid(
        "A ref fetch takes no entities or facets; narrow a member's spec instead, as " +
          "client.fetch(ref.members[0].spec, { entities }).",
      );
    }
    return latest === true
      ? fetchNewest(transport, target, rest)
      : fetchRef(transport, target, rest);
  }
  const spec = checkedSpec(target);
  if (latest === true) {
    throw invalid(
      "A spec always fetches its newest version, so latest is for a DatasetRef; drop it: " +
        "client.fetch(spec).",
    );
  }
  const member = {
    parts: [],
    spec,
    sentence: spec.resolved?.rendered_sentence,
    entityGroups: spec.resolved?.entity_groups,
  };
  return fetchMembers(transport, [member], { ...rest, narrowing });
}

/** Why a ref fetch refuses `window`, and the call that does what it asks: `latest: true` for
 *  the newest version, else a member's spec for a narrower window. */
function refWindowRefusal(window: unknown, latest: boolean | undefined): string {
  if (window === "latest" && latest !== true) {
    return "A ref fetch takes no window; for the newest version use latest: true.";
  }
  return (
    "A ref fetch takes no window; to narrow the years, fetch a member's spec: " +
    `client.fetch(ref.members[0].spec, { window: ${capped(JSON.stringify(window))} }).`
  );
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

/**
 * The layout a ref holds, once the call's `layout` and `partyTotals`, when given, are the ref's
 * own. A member keeps party totals when its rendering holds no `without_party_totals`.
 *
 * @throws {InvalidRequestError} The ref holds a rendering this client does not read, or the
 *   call names another layout or `partyTotals` (`invalid_argument`).
 */
function checkedRefLayout(ref: DatasetRef, options: CallOptions): Layout {
  const layout = refLayout(ref);
  if (options.layout !== undefined && options.layout !== layout) {
    throw invalid(
      `The DatasetRef holds the ${layout} layout, not "${options.layout}"; fetch its specs for ` +
        "another layout.",
    );
  }
  if (options.partyTotals === undefined) return layout;
  const asked = checkedPartyTotals(options.partyTotals);
  for (const member of ref.members) {
    const held = keepsPartyTotals(member.rendering);
    if (asked !== held) {
      throw invalid(
        `The DatasetRef holds ${member.spec.spec_id} with partyTotals ${held}, not ${asked}; ` +
          "fetch its specs for the other rendering.",
      );
    }
  }
  return layout;
}

const keepsPartyTotals = (rendering: Rendering): boolean => rendering.without_party_totals !== true;

/**
 * Builds the newest version of each member's spec in the ref's rendering, stacked under the
 * members' parts as an answer's fetch stacks them.
 *
 * @throws {InvalidRequestError} The members hold different renderings, since one fetch builds
 *   one (`invalid_argument`).
 */
async function fetchNewest(
  transport: Transport,
  ref: DatasetRef,
  options: CallOptions,
): Promise<Dataset> {
  const layout = checkedRefLayout(ref, options);
  const [first, ...others] = ref.members;
  // A ref holds at least one member: fromJSON refuses an empty one, and a dataset has one.
  const rendering = first!.rendering;
  const index = others.findIndex((member) => !sameRendering(member.rendering, rendering));
  if (index !== -1) {
    const other = others[index]!;
    throw invalid(
      `The DatasetRef holds ${first!.spec.spec_id} and ${other.spec.spec_id} in different ` +
        "renderings, and a latest fetch builds one; fetch each spec on its own, as " +
        `client.fetch(ref.members[${index + 1}].spec, { layout: "${layoutOf(other.rendering)}", ` +
        `partyTotals: ${keepsPartyTotals(other.rendering)} }).`,
    );
  }
  const members = ref.members.map(({ parts, spec, sentence }) => ({ parts, spec, sentence }));
  return fetchMembers(transport, members, {
    ...options,
    layout,
    partyTotals: keepsPartyTotals(rendering),
  });
}

async function fetchRef(
  transport: Transport,
  ref: DatasetRef,
  options: CallOptions,
): Promise<Dataset> {
  const layout = checkedRefLayout(ref, options);
  const wait = waitFor(transport, options);
  const fetched: FetchedMember[] = [];
  for (const [index, member] of ref.members.entries()) {
    fetched.push(await fetchVersion(transport, member, `/members/${index}`, options, wait));
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

/** One stored version, through the lookup order. `pointer` locates the member in the ref. */
async function fetchVersion(
  transport: Transport,
  member: RefMember,
  pointer: string,
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
    const file = await storedFile(transport, member, pointer, found, wait);
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
          detail: `The server rebuilt ${capped(rebuilt)} for ${member.spec.spec_id}.`,
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
    newest = await newestVersion(transport, member.spec.spec_id, wait);
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
        detail: `The server answered ${capped(built)} for ${asked}.`,
        pointer:
          specIdOf(read) === member.spec.spec_id ? "/content_version" : "/definition/spec_id",
      });
    }
    return read;
  });
  return { manifest, traceId };
}

/** The stored artifact's bytes from the files route, or else from the file selector, or the
 *  files route's refusal when neither serves bytes with the stored digest.
 *
 * @throws {FormatError} The manifest lists the ref's digest only under another rendering
 *   (`format_invalid` at the member's `artifact/rendering`).
 */
async function storedFile(
  transport: Transport,
  member: RefMember,
  pointer: string,
  { manifest, traceId }: Built,
  wait: Wait,
): Promise<{ data?: Uint8Array; refusal?: DfoError | undefined }> {
  let refusal: DfoError | undefined;
  const artifact = pickArtifact(manifest, member.rendering, member.digest);
  if (artifact === undefined && listsDigest(manifest, member.digest)) {
    throw new FormatError(
      "format_invalid",
      `${pointer}/artifact/rendering`,
      `${JSON.stringify(mintOptions(member.rendering))} is not the rendering the server lists ` +
        `for ${member.digest}`,
    );
  }
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
    Object.entries(mintOptions(member.rendering)).map(([name, value]) => [name, String(value)]),
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

/** Whether a manifest lists an artifact with `digest`, in any rendering. */
const listsDigest = (manifest: Manifest, digest: string): boolean =>
  // readManifest has checked `artifacts` is a list.
  (manifest["artifacts"] as unknown[]).some(
    (artifact) => isRecord(artifact) && artifact["artifact_digest"] === digest,
  );

/** The versions one page of the versions route lists, the route's default page size. */
const VERSIONS_PAGE = 100;
/** The most versions pages a newest-version lookup reads. Past them the lookup reports no
 *  newest version. */
export const VERSIONS_PAGE_BUDGET = 20;

/**
 * @internal The newest plain build of a spec, or null. The versions route lists versions newest
 * first, `VERSIONS_PAGE` to a page, and each page's `next_cursor` names the next. A version with
 * a `base_content_version` is derived from a plain build, by a groupby collapse or a
 * party-totals cut, and is skipped, so the newest version is the first listed with a null
 * `base_content_version`. A list that ends without one, a `NotFoundError`, or
 * `VERSIONS_PAGE_BUDGET` pages read without one, reads as none. A fetch that leaves party totals
 * out answers this build only when the cut leaves no row out, so the version is not comparable
 * with a cut ref's. A ref's lookup reads it, and the contract replay runs its `newest_version`
 * step through it.
 *
 * @throws {ContractError} A page is not a `DatasetVersionsPage` this client can read: no
 *   `versions` list, a listed version whose `content_version` is not a version id or whose
 *   `base_content_version` is neither a string nor null, or a `next_cursor` that is neither a
 *   string nor null, or names a page already read.
 */
export async function newestVersion(
  transport: Transport,
  specId: string,
  { deadline, signal }: Wait,
): Promise<string | null> {
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
    const page = readVersionsPage(body, specId, traceId);
    if (page.newest !== null || page.nextCursor === null) return page.newest;
    if (seen.has(page.nextCursor)) throw unreadable(specId, "/next_cursor", traceId);
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  return null;
}

/** The first plain build a versions page lists, or null, and the page's `next_cursor`. */
function readVersionsPage(
  body: unknown,
  specId: string,
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
    const base = entry["base_content_version"];
    if (base !== null && typeof base !== "string") {
      throw unreadable(specId, `/versions/${index}/base_content_version`, traceId);
    }
    if (base === null) newest ??= contentVersion;
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
  const lost = `${member.spec.spec_id} at ${member.contentVersion} can no longer be fetched`;
  // The newest version names a plain build, which a cut ref's version need not equal even when
  // no newer data exists, so only an equal id says something.
  const detail =
    newest === member.contentVersion
      ? `${lost}, though the server lists it as the newest version.`
      : `${lost}. For the newest version: ${LATEST_CALL}`;
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
