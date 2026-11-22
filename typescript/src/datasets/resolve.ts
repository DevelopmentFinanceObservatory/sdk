/**
 * Fetching a target: a spec through the build path in `fetch.ts`, the exact versions a ref
 * names, or a recipe or a ref of a frame DFO computed through the analysis runner in
 * `analysis.ts`. With `latest: true`, a ref's specs build through that path instead, in the
 * ref's one rendering, as their newest versions. With `latest: "stored"`, each member reads the
 * version DFO stores as its spec's newest, in the member's rendering (`currentManifest`), and a
 * recipe posts its tree with each root at that version (`storedRecipeTree`), downloading no
 * root's file.
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
 * A share fetch finds the frame a slot shows (`shownFrame` in `shares.ts`) and reads that exact
 * version in the frame layout. A `spec_` frame reads its stored manifest at
 * `GET /datasets/{spec_id}/{content_version}`, which holds the definition and lists the frame
 * artifact a ref member names, and then takes a ref's lookup order with that manifest. A version
 * that lists no frame artifact, as a long-layout fetch leaves it, reads the file the file
 * selector renders from its stored frame, and the manifest read again must list that file's
 * digest as the frame artifact. When it does not, the selector is asked once more; a selector
 * that finds no file rebuilds the version, as a ref member's lookup does. Once the data is read,
 * it asks Search the definition's sentence; when Search refuses, fails, or answers another spec,
 * the dataset reads as the card's title, so Search never decides whether the fetch succeeds. An
 * `ops_` frame reads through its bare derived root (`fetchComputedFrame`). The dataset's text
 * form names the share, slot, card title and day.
 *
 * The lookup reuses the build path's download, warnings and finishing steps, so this module
 * imports `fetch.ts` and `fetch.ts` imports nothing from here.
 */

import { fetchComputedFrame, fetchDerived, runRecipe } from "./analysis.ts";
import type { StoredTree } from "./analysis.ts";
import { Dataset, FRESHNESS, shownDataset } from "./dataset.ts";
import type { FetchedMember, Freshness } from "./dataset.ts";
import {
  capped,
  clientError,
  DfoError,
  InvalidRequestError,
  NotFoundError,
  optionsOf,
  serverCode,
  VersionUnavailableError,
} from "../core/errors.ts";
import {
  buildBody,
  checkArtifact,
  checkedPartyTotals,
  checkedSpec,
  contentVersionOf,
  definitionOf,
  DIGEST_MISMATCH,
  digestOf,
  download,
  FETCH_OPTIONS,
  fetchMembers,
  finish,
  invalid,
  narrowingOf,
  narrows,
  noteWarnings,
  pickArtifact,
  resolvedOf,
  sentenceFor,
  specIdOf,
} from "./fetch.ts";
import type { CallOptions, FetchOptions, Narrowing } from "./fetch.ts";
import { build, readBuilt, readManifest, waitFor } from "./operation.ts";
import { shareIdIn, shownLine } from "./publication.ts";
import type { Share, ShownFrame } from "./publication.ts";
import { Recipe, recipeRoots, treeWithRoots } from "./recipe.ts";
import type { RecipeRoot } from "./recipe.ts";
import { shownFrame } from "./shares.ts";
import type { Built, Manifest, Wait } from "./operation.ts";
import {
  CONTENT_VERSION,
  DatasetRef,
  FormatError,
  isDatasetMember,
  isDerived,
  layoutOf,
  mintOptions,
  OPS_ID,
  sameRendering,
  selectorPath,
  servedCut,
  SPEC_ID,
} from "../core/ref.ts";
import type { Layout, Rendering, RefMember, Spec } from "../core/ref.ts";
import { checkOptions } from "../core/options.ts";
import { checkedConversion, fetchConverted, givenConversion } from "./convert.ts";
import type { ConversionArgs } from "./convert.ts";
import { describing } from "../core/trace.ts";
import type { Transport } from "../http/transport.ts";
import { isRecord, present } from "../core/json.ts";
import { clientWarning } from "../core/warnings.ts";

/** The call that fetches the newest versions of a ref's specs, which a lost version names. */
const LATEST_CALL = "client.fetch(ref, { latest: true })";
/** The `latest` value that reads each ref member's stored newest version. */
const STORED = "stored";
/** The values `latest` takes. */
const LATEST_VALUES: ReadonlySet<unknown> = new Set([true, false, STORED]);
/** The header that says how new the version a spec's route serves is. */
const FRESHNESS_HEADER = "x-dfo-freshness";

/** Refusals after which a stored version's lookup goes on. The version exists, but its file
 *  has expired. An unknown version (`snapshot_not_found`) ends the lookup. */
const FILE_EXPIRED = "artifact_expired";
const FILE_GONE: ReadonlySet<string | null> = new Set([
  FILE_EXPIRED,
  "artifact_not_found",
  "not_found",
]);
/** The rendering a share fetch reads a dataset frame in: the bare Parquet frame. Whether it
 *  leaves party totals out is the listed artifact's. */
const FRAME: Rendering = { format: "parquet", bundle: false, layout: "frame" };

/**
 * Fetches a spec's latest version, in another unit when `currency` is given, the exact versions
 * a ref names, or with `latest` the newest versions of a ref's specs; or runs a recipe, or reads
 * a ref of a frame DFO computed, which take `latest`, `strict`, `timeout` and `signal`, and
 * refuse `onProgress`, which DFO does not report for them, and the options that narrow or render
 * a spec. A share, or its URL, reads the exact version its slot shows, or with `asOf` showed
 * then; it takes `asOf`, `slot`, `strict`,
 * `timeout`, `signal` and `onProgress`, and `layout` only as `frame`.
 *
 * @throws {InvalidRequestError} The target is neither a ref, a recipe nor a spec `checkedSpec`
 *   accepts, a ref is narrowed or given another layout or `partyTotals`, `latest` is given a
 *   spec or a ref whose members differ in rendering, `latest` is not a boolean, or a recipe or
 *   a derived ref is given `window`, `entities`, `facets`, `partyTotals`, a conversion option
 *   or a layout other than `frame`; a ref is given a conversion option; a conversion option
 *   breaks its rule; a share is given a narrowing, a conversion option, `partyTotals`,
 *   `latest: true` or a layout other than `frame`, `slot` is not a number from 1, or `asOf` is malformed, all before any
 *   request; a share of several slots is given no `slot`, or one past its last; `asOf` is
 *   before the slot first served data; or `asOf` or `slot` is given another target.
 *   `entityDcids` reads a spec's entities once those checks pass, so a ref or share given a
 *   `Match` that did not resolve is refused for taking entities, as the Python client is.
 * @throws {VersionUnavailableError} A ref's version can no longer be fetched.
 * @throws {DfoError} The server refused a request.
 */
export async function fetchDataset(
  transport: Transport,
  target: Spec | DatasetRef | Recipe | Share | string,
  options: FetchOptions = {},
  entityDcids: (narrowing: Narrowing) => Narrowing = (narrowing) => narrowing,
): Promise<Dataset> {
  const { window, entities, facets, currency, priceBasis, baseYear, latest, asOf, slot, ...rest } =
    checkOptions(FETCH_OPTIONS, options);
  const narrowing = narrowingOf({ window, entities, facets });
  const conversion = { currency, priceBasis, baseYear };
  if (latest !== undefined && !LATEST_VALUES.has(latest)) {
    throw invalid(`latest is true, false or "stored", not ${capped(JSON.stringify(latest))}.`);
  }
  if (shareIdIn(target) !== null) {
    const given = [
      ...givenOptions(narrowing, rest, conversion),
      ...(latest === undefined || latest === false ? [] : [`latest: ${JSON.stringify(latest)}`]),
    ];
    if (given.length > 0) {
      throw invalid(
        `A share fetch reads the exact frame a slot shows and takes no ${given.join(", ")}; ` +
          "narrow the dataset it returns with client.analysis.filter, or pick another moment " +
          "with asOf.",
      );
    }
    const wait = waitFor(transport, rest);
    const shown = await shownFrame(transport, target, { slot, asOf }, wait);
    return shownDataset(await fetchShown(transport, shown, rest, wait), shownLine(shown));
  }
  if ([asOf, slot].some((given) => given !== undefined && given !== null)) {
    throw invalid(
      "asOf and slot pick what a share showed, so they go with a Share or its URL, such as " +
        "client.fetch(share, { slot: 1 }).",
    );
  }
  if (
    target instanceof Recipe ||
    (target instanceof DatasetRef && target.members.some(isDerived))
  ) {
    const given = givenOptions(narrowing, rest, conversion);
    if (given.length > 0) {
      throw invalid(
        `A recipe or a frame DFO computed takes no ${given.join(", ")}; set them on the ` +
          "readings the recipe starts from.",
      );
    }
    if (rest.onProgress !== undefined) {
      throw invalid(
        "DFO reports no progress while it computes a recipe, so a recipe or a frame DFO " +
          "computed takes no onProgress; drop it.",
      );
    }
    if (latest === STORED && !(target instanceof Recipe)) {
      throw invalid(
        'latest: "stored" reads the stored versions of a ref\'s readings, and DFO stores no ' +
          "newest version of a frame it computed; use latest: true, which computes it again " +
          "on the newest versions of its readings.",
      );
    }
    const computed = present({
      latest: latest === STORED ? false : latest,
      strict: rest.strict,
      timeout: rest.timeout,
      signal: rest.signal,
    });
    if (!(target instanceof Recipe)) return fetchDerived(transport, target, computed);
    if (latest !== STORED) return runRecipe(transport, target, computed);
    target.tree(); // A recipe with no step throws before any manifest is read.
    const roots = storedRoots(target);
    return runRecipe(transport, target, computed, (wait) =>
      storedRecipeTree(transport, target, roots, wait),
    );
  }
  if (target instanceof DatasetRef) {
    const members = datasetMembers(target);
    if (narrowing.window !== undefined) throw invalid(refWindowRefusal(narrowing.window, latest));
    const converting = givenConversion(conversion);
    if (converting.length > 0) {
      throw invalid(
        `A ref fetch reads the versions it names and takes no ${converting.join(", ")}; ` +
          "convert a dataset member's spec instead: " +
          `client.fetch(member.spec, { currency: ${shownCurrency(currency)} }) for a member of ` +
          "ref.members where isDatasetMember(member).",
      );
    }
    if (narrows(narrowing)) {
      throw invalid(
        "A ref fetch takes no entities or facets; narrow a dataset member's spec instead: " +
          "client.fetch(member.spec, { entities }) for a member of ref.members where " +
          "isDatasetMember(member).",
      );
    }
    if (latest === true) return fetchNewest(transport, members, rest);
    return latest === STORED
      ? fetchStored(transport, members, rest)
      : fetchRef(transport, members, rest);
  }
  const spec = checkedSpec(target);
  if (latest !== undefined && latest !== false) {
    throw invalid(
      "A spec always fetches its newest version, so latest is for a DatasetRef; drop it: " +
        "client.fetch(spec).",
    );
  }
  const request = checkedConversion(conversion, narrowing.facets);
  const member = { parts: [], spec, ...resolvedOf(spec) };
  return fetchConverted(
    transport,
    [member],
    { ...rest, narrowing: entityDcids(narrowing) },
    request,
  );
}

/** A currency as a refusal's example call shows it: the caller's when it is a string. */
const shownCurrency = (currency: unknown): string =>
  JSON.stringify(typeof currency === "string" ? capped(currency) : "EUR");

/** Why a ref fetch refuses `window`, and the call that does what it asks: `latest: true` for
 *  the newest version, else a dataset member's spec for a narrower window. */
function refWindowRefusal(window: unknown, latest: boolean | typeof STORED | undefined): string {
  if (window === "latest" && latest !== true) {
    return "A ref fetch takes no window; for the newest version use latest: true.";
  }
  return (
    "A ref fetch takes no window; to narrow the years, fetch a dataset member's spec: " +
    `client.fetch(member.spec, { window: ${capped(JSON.stringify(window))} }) for a member of ` +
    "ref.members where isDatasetMember(member)."
  );
}

/**
 * The options a call names that convert, narrow or render a spec, which a share, a recipe and a
 * frame DFO computed refuse: each reads a frame in the frame layout as DFO stored or computed
 * it. An empty `entities` or `facets` names nothing, as for a spec or a ref, and
 * `layout: "frame"` is the frame's own.
 */
function givenOptions(
  narrowing: Narrowing,
  options: CallOptions,
  conversion: ConversionArgs,
): string[] {
  return [
    ...givenConversion(conversion),
    narrowing.window !== undefined && "window",
    narrows({ entities: narrowing.entities }) && "entities",
    narrows({ facets: narrowing.facets }) && "facets",
    options.partyTotals !== undefined && "partyTotals",
    options.layout !== undefined &&
      options.layout !== "frame" &&
      `layout: ${capped(JSON.stringify(options.layout))}`,
  ].filter((name) => name !== false);
}

/**
 * The exact version a share's slot shows, as `shownFrame` found it.
 *
 * @throws {ContractError} The slot names a frame that is neither `spec_` nor `ops_`
 *   (`contract_violation`).
 */
async function fetchShown(
  transport: Transport,
  shown: ShownFrame,
  options: CallOptions,
  wait: Wait,
): Promise<Dataset> {
  if (OPS_ID.test(shown.specId)) {
    return fetchComputedFrame(
      transport,
      shown.specId,
      shown.contentVersion,
      options.strict ?? false,
      wait,
    );
  }
  if (SPEC_ID.test(shown.specId)) {
    const fix = shown.newerNow
      ? `For what the slot shows now: client.fetch(share, { slot: ${shown.slot} })`
      : `The frame is gone, so share ${shown.shareId} cannot show slot ${shown.slot}'s data`;
    const title = shown.title ?? `Slot ${shown.slot} of share ${shown.shareId}`;
    return fetchFrame(transport, shown.specId, shown.contentVersion, { title, fix }, options, wait);
  }
  throw clientError("contract_violation", {
    detail:
      `Slot ${shown.slot} of share ${shown.shareId} names the frame ` +
      `${capped(JSON.stringify(shown.specId))}, which is neither a spec_ nor an ops_ id.`,
  });
}

/**
 * A dataset version in the frame layout, from its ids alone: the stored manifest names its
 * definition and frame artifact, or else the file selector renders the file (`renderedFrame`).
 * Once the data is read, Search words its sentence, or else `title` does.
 *
 * @throws {VersionUnavailableError} DFO no longer stores the version or its file
 *   (`artifact_expired`), and the error ends with `fix`.
 * @throws {ContractError} The selector twice served a file the manifest does not list as the
 *   frame artifact (`contract_violation`).
 */
async function fetchFrame(
  transport: Transport,
  specId: string,
  contentVersion: string,
  { title, fix }: { title: string; fix: string },
  options: CallOptions,
  wait: Wait,
): Promise<Dataset> {
  let found: Built;
  try {
    found = await storedManifest(transport, specId, contentVersion, wait);
  } catch (error) {
    if (!(error instanceof DfoError) || error.code !== FILE_EXPIRED) throw error;
    const newest = await newestVersion(transport, specId, wait);
    throw unavailable(specId, contentVersion, newest, error, fix);
  }
  const artifact = pickArtifact(found.manifest, FRAME);
  const fetched =
    artifact === undefined
      ? await renderedFrame(transport, found.manifest, title, options, wait, fix)
      : await fetchVersion(
          transport,
          frameMember(found.manifest, artifact, title),
          "/members/0",
          options,
          wait,
          found,
          fix,
        );
  const sentence = await sentenceOr(transport, fetched.manifest, title, wait);
  return Dataset.create([{ ...fetched, sentence }], { layout: "frame" });
}

/** The ref member of a version's listed frame artifact, read as `title`. */
function frameMember(
  manifest: Manifest,
  artifact: Record<string, unknown>,
  title: string,
): RefMember {
  const cut = servedCut(artifact["rendering"]);
  return {
    parts: [],
    sentence: title,
    spec: { spec_id: specIdOf(manifest), definition: definitionOf(manifest) },
    contentVersion: contentVersionOf(manifest),
    digest: String(artifact["artifact_digest"]),
    rendering: cut ? { ...FRAME, without_party_totals: true } : FRAME,
  };
}

/**
 * The frame-layout file the file selector renders from a version's stored frame, for a
 * `manifest` that lists none. The selector lists the file it renders in the version's manifest,
 * so the manifest read again must list the served bytes' digest as the frame artifact. When it
 * does not, the selector is asked once more, as for bytes that fail their digest. A selector or
 * snapshot refusal that the file is gone rebuilds the version, as a ref member's lookup does.
 *
 * @throws {ContractError} Both answers were files the manifest does not list as the frame
 *   artifact (`contract_violation`).
 */
async function renderedFrame(
  transport: Transport,
  manifest: Manifest,
  title: string,
  options: CallOptions,
  wait: Wait,
  fix: string,
): Promise<FetchedMember> {
  const specId = specIdOf(manifest);
  const contentVersion = contentVersionOf(manifest);
  const selector = selectorPath({ spec: { spec_id: specId }, contentVersion, rendering: FRAME });
  let digest = "";
  let traceId: string | null = null;
  try {
    for (let round = 0; round < 2; round += 1) {
      // The selector serves a file the manifest does not list, so its digest is unknown until
      // read.
      const data = await download(transport, { path: selector }, undefined, wait);
      digest = await digestOf(data);
      const found = await storedManifest(transport, specId, contentVersion, wait);
      traceId = found.traceId;
      const artifact = pickArtifact(found.manifest, FRAME, digest);
      if (artifact !== undefined) {
        const member = frameMember(found.manifest, artifact, title);
        noteWarnings(transport, found, options.strict ?? false);
        checkArtifact(data, found.manifest, member.digest);
        return stored(member, found.manifest, data);
      }
    }
  } catch (error) {
    if (!(error instanceof DfoError) || !FILE_GONE.has(error.code)) throw error;
    const cut = (manifest["artifacts"] as unknown[]).some(
      (artifact) => isRecord(artifact) && servedCut(artifact["rendering"]),
    );
    const want: Omit<RefMember, "digest"> = {
      parts: [],
      sentence: title,
      spec: { spec_id: specId, definition: definitionOf(manifest) },
      contentVersion,
      rendering: cut ? { ...FRAME, without_party_totals: true } : FRAME,
    };
    return rebuilt(transport, want, error, options, wait, fix);
  }
  throw describing(traceId, () =>
    clientError("contract_violation", {
      detail:
        `The file selector twice served ${specId} at ${contentVersion} as a file the manifest ` +
        `does not list as its ${JSON.stringify(mintOptions(FRAME))} artifact, last ${digest}.`,
    }),
  );
}

/** Search's sentence for a stored version, or `fallback` when Search refuses, fails, or no
 *  longer resolves the definition to its own spec: the data is already read, and the sentence
 *  only words it. */
async function sentenceOr(
  transport: Transport,
  manifest: Manifest,
  fallback: string,
  wait: Wait,
): Promise<string> {
  try {
    return (await sentenceFor(transport, manifest, [], undefined, wait)).sentence;
  } catch (error) {
    if (!(error instanceof DfoError)) throw error;
    return fallback;
  }
}

/** The dataset members of a ref, which holds no derived member. */
const datasetMembers = (ref: DatasetRef): readonly RefMember[] =>
  ref.members.filter(isDatasetMember);

function refLayout(members: readonly RefMember[]): Layout {
  const layouts = new Set<Layout>();
  for (const member of members) {
    if (member.rendering.format !== "parquet" || member.rendering.bundle) {
      throw invalid(
        `The DatasetRef stores ${member.spec.spec_id} as ` +
          `${JSON.stringify(mintOptions(member.rendering))}; this client reads bare Parquet.`,
      );
    }
    layouts.add(layoutOf(member.rendering));
  }
  if (layouts.has("frame") && members.length > 1) {
    throw invalid('layout "frame" holds one reading, and this DatasetRef holds several.');
  }
  return layouts.has("frame") ? "frame" : "long";
}

/**
 * The layout a ref holds, once the call's `layout` and `partyTotals`, when given, are the ref's
 * own. A member keeps party totals when its rendering holds no party-totals cut.
 *
 * @throws {InvalidRequestError} The ref holds a rendering this client does not read, or the
 *   call names another layout or `partyTotals` (`invalid_argument`).
 */
function checkedRefLayout(members: readonly RefMember[], options: CallOptions): Layout {
  const layout = refLayout(members);
  if (options.layout !== undefined && options.layout !== layout) {
    throw invalid(
      `The DatasetRef holds the ${layout} layout, not "${options.layout}"; fetch its specs for ` +
        "another layout.",
    );
  }
  if (options.partyTotals === undefined) return layout;
  const asked = checkedPartyTotals(options.partyTotals);
  for (const member of members) {
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
  refMembers: readonly RefMember[],
  options: CallOptions,
): Promise<Dataset> {
  const layout = checkedRefLayout(refMembers, options);
  const [first, ...others] = refMembers;
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
  const members = refMembers.map(({ parts, spec, sentence }) => ({ parts, spec, sentence }));
  return fetchMembers(transport, members, {
    ...options,
    layout,
    partyTotals: keepsPartyTotals(rendering),
  });
}

async function fetchRef(
  transport: Transport,
  members: readonly RefMember[],
  options: CallOptions,
): Promise<Dataset> {
  const layout = checkedRefLayout(members, options);
  const wait = waitFor(transport, options);
  const fetched: FetchedMember[] = [];
  for (const [index, member] of members.entries()) {
    fetched.push(await fetchVersion(transport, member, `/members/${index}`, options, wait));
  }
  return Dataset.create(fetched, { layout });
}

/**
 * Reads the stored newest version of each member's spec in the member's rendering
 * (`currentManifest`), and downloads its file in that rendering, checked against the manifest's
 * digest. The dataset's `freshness` is the worst of the members' (`currentManifest`), and null
 * when any member's is unknown.
 */
async function fetchStored(
  transport: Transport,
  members: readonly RefMember[],
  options: CallOptions,
): Promise<Dataset> {
  const layout = checkedRefLayout(members, options);
  const wait = waitFor(transport, options);
  const fetched: FetchedMember[] = [];
  const stated: (Freshness | null)[] = [];
  for (const member of members) {
    const current = await currentManifest(transport, member.spec.spec_id, member.rendering, {
      ...wait,
      onProgress: options.onProgress,
    });
    const finishing = {
      parts: member.parts,
      posted: { spec: member.spec },
      sentence: member.sentence,
      rendering: member.rendering,
      strict: options.strict ?? false,
    };
    fetched.push(await finish(transport, current, finishing, wait));
    stated.push(current.freshness);
  }
  return Dataset.create(fetched, { layout, freshness: worstFreshness(stated) });
}

/** One reading a stored recipe resolves: its spec in one rendering. */
type StoredReading = { readonly specId: string; readonly rendering: Rendering };

/** The rendering a recipe's spec root reads at its stored version: the frame, without party
 *  totals, as the root's own rendering states. */
const SPEC_ROOT_RENDERING: Rendering = { ...FRAME, without_party_totals: true };

/** The key two roots of one spec in one rendering share, so a stored recipe reads its manifest
 *  once. */
const readingKey = ({ specId, rendering }: StoredReading): string =>
  `${specId} ${JSON.stringify(mintOptions(rendering))}`;

/**
 * Each reading a recipe's roots name, once each: a spec root's spec without party totals, and
 * each dataset member of a ref or dataset root in its rendering.
 *
 * @throws {InvalidRequestError} A root is a frame DFO computed, whose stored newest version DFO
 *   does not keep (`invalid_argument`), or a root holds several readings, which DFO refuses
 *   with `several_members`; no request is sent.
 */
function storedRoots(chain: Recipe): Map<string, StoredReading> {
  const readings = new Map<string, StoredReading>();
  for (const root of recipeRoots(chain)) {
    const found = rootReadings(root);
    if (found.length > 1) {
      throw new InvalidRequestError({
        code: serverCode("several_members"),
        detail:
          `A recipe root of ${found.length} readings cannot run: an operation takes one reading ` +
          'per side, and DFO refuses a root of several with `several_members`. latest: "stored" ' +
          "sends no request; start the recipe from a root of one reading.",
      });
    }
    for (const reading of found) readings.set(readingKey(reading), reading);
  }
  return readings;
}

function rootReadings({ node, ref }: RecipeRoot): StoredReading[] {
  if (ref === undefined) {
    return [{ specId: String(node["spec_id"]), rendering: SPEC_ROOT_RENDERING }];
  }
  return ref.members.map((member) => {
    if (!isDatasetMember(member)) {
      throw invalid(
        `latest: "stored" reads each reading's stored newest version, and the recipe reads ` +
          `${member.spec.spec_id}, a frame DFO computed, which has none; start the recipe from ` +
          "the readings that frame read, or fetch the recipe with latest: true.",
      );
    }
    return { specId: member.spec.spec_id, rendering: member.rendering };
  });
}

/**
 * A recipe's tree with each root at the version DFO stores as its spec's newest, and the worst
 * freshness those versions state. Each reading's manifest is read once, all at the same time,
 * from `GET /datasets/{specId}` in its rendering, and no file is downloaded. A one-member root
 * sends the stored version.
 *
 * @throws {ContractError} A manifest answers another spec (`contract_violation`).
 * @throws {DfoTimeoutError} The deadline passed before a manifest was read
 *   (`deadline_exceeded`).
 */
async function storedRecipeTree(
  transport: Transport,
  chain: Recipe,
  readings: ReadonlyMap<string, StoredReading>,
  wait: Wait,
): Promise<StoredTree> {
  // One failed read aborts the others, so a refusal leaves no request running.
  const failed = new AbortController();
  const signal =
    wait.signal === undefined ? failed.signal : AbortSignal.any([wait.signal, failed.signal]);
  const read = await Promise.all(
    [...readings].map(async ([key, { specId, rendering }]) => {
      try {
        const current = await currentManifest(transport, specId, rendering, { ...wait, signal });
        return [key, current] as const;
      } catch (error) {
        failed.abort();
        throw error;
      }
    }),
  );
  const manifests = new Map(read);
  const storedOf = (reading: StoredReading) => manifests.get(readingKey(reading))!;
  const tree = treeWithRoots(chain, (root) => {
    const node = structuredClone(root.node) as Record<string, unknown>;
    const [first] = rootReadings(root);
    return { ...node, content_version: contentVersionOf(storedOf(first!).manifest) };
  });
  return {
    tree,
    freshness: worstFreshness([...manifests.values()].map((current) => current.freshness)),
  };
}

/** The worst of the members' freshness, or null when any member's is unknown. */
function worstFreshness(stated: readonly (Freshness | null)[]): Freshness | null {
  if (stated.some((freshness) => freshness === null)) return null;
  const rank = Math.max(...stated.map((freshness) => FRESHNESS.indexOf(freshness!)));
  return FRESHNESS[rank] ?? null;
}

/** The freshness an answer's `x-dfo-freshness` header states, or null when it states none this
 *  client knows. */
function freshnessOf(headers: Headers): Freshness | null {
  const value = headers.get(FRESHNESS_HEADER)?.trim().toLowerCase();
  return FRESHNESS.find((freshness) => freshness === value) ?? null;
}

/**
 * The manifest of the version DFO stores as the newest of a spec in `rendering`, from
 * `GET /datasets/{specId}` with the rendering as its query, and the freshness its answer states.
 * A 202 is followed to the built manifest through the operation it names, and the version is
 * `current` whatever the 202 states, since the operation has just checked or built it.
 *
 * @throws {ContractError} The answer is another spec's (`contract_violation`).
 * @throws {DfoTimeoutError} The caller's deadline passed before a build was done
 *   (`deadline_exceeded`).
 */
export async function currentManifest(
  transport: Transport,
  specId: string,
  rendering: Rendering,
  wait: Wait & { onProgress?: CallOptions["onProgress"] },
): Promise<Built & { readonly freshness: Freshness | null }> {
  if (!SPEC_ID.test(specId)) {
    throw clientError("invalid_argument", {
      detail: `The DatasetRef member '${specId}' does not name a spec_ id; load refs with DatasetRef.fromJSON.`,
    });
  }
  const query = new URLSearchParams(
    Object.entries(mintOptions(rendering)).map(([key, value]) => [key, String(value)]),
  );
  const { response, ...built } = await readBuilt(transport, `/datasets/${specId}?${query}`, wait);
  describing(built.traceId, () => {
    const answered = specIdOf(built.manifest);
    if (answered !== specId) {
      throw clientError("contract_violation", {
        detail: `The server answered ${capped(answered)} for ${specId}.`,
        pointer: "/definition/spec_id",
      });
    }
  });
  const freshness = response.status === 202 ? "current" : freshnessOf(response.headers);
  return { ...built, freshness };
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

/** One stored version, through the lookup order. `pointer` locates the member in the ref.
 *  `snapshotted` is the version's manifest when the caller already read it, which spares the
 *  snapshot request. `fix` ends the error when the version can no longer be fetched. */
async function fetchVersion(
  transport: Transport,
  member: RefMember,
  pointer: string,
  options: CallOptions,
  wait: Wait,
  snapshotted?: Built,
  fix = `For the newest version: ${LATEST_CALL}`,
): Promise<FetchedMember> {
  const strict = options.strict ?? false;
  let refusal: DfoError | undefined;

  let found: Built | undefined;
  try {
    found =
      snapshotted ??
      (await storedManifest(transport, member.spec.spec_id, member.contentVersion, wait));
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

  const fetched = await rebuilt(transport, member, refusal, options, wait, fix);
  if (fetched.digest !== member.digest) noteNewDigest(transport, member, fetched.digest);
  return fetched;
}

/**
 * A stored version built again in its rendering, the last step of its lookup.
 *
 * @throws {VersionUnavailableError} The build refused, or built another version; the error
 *   carries `refusal`, the lookup's earlier refusal, when there was one, and ends with `fix`.
 */
async function rebuilt(
  transport: Transport,
  want: Omit<RefMember, "digest">,
  refusal: DfoError | undefined,
  options: CallOptions,
  wait: Wait,
  fix: string,
): Promise<FetchedMember> {
  let newest: string | null;
  try {
    const built = await build(transport, buildBody(want.spec, want.rendering), {
      ...wait,
      onProgress: options.onProgress,
    });
    describing(built.traceId, () => {
      const rebuiltId = specIdOf(built.manifest);
      if (rebuiltId !== want.spec.spec_id) {
        throw clientError("contract_violation", {
          detail: `The server rebuilt ${capped(rebuiltId)} for ${want.spec.spec_id}.`,
          pointer: "/definition/spec_id",
        });
      }
    });
    if (contentVersionOf(built.manifest) === want.contentVersion) {
      const finishing = {
        parts: want.parts,
        posted: { spec: want.spec },
        sentence: want.sentence,
        rendering: want.rendering,
        strict: options.strict ?? false,
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
    newest = await newestVersion(transport, want.spec.spec_id, wait);
  }
  throw unavailable(want.spec.spec_id, want.contentVersion, newest, refusal, fix);
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
export async function storedManifest(
  transport: Transport,
  specId: string,
  contentVersion: string,
  { deadline, signal }: Wait,
): Promise<Built> {
  const response = await transport.request({
    path: `/datasets/${specId}/${contentVersion}`,
    deadline,
    signal,
  });
  const { traceId } = response;
  const manifest = describing(traceId, () => {
    const read = readManifest(response.body);
    const built = `${specIdOf(read)} at ${contentVersionOf(read)}`;
    const asked = `${specId} at ${contentVersion}`;
    if (built !== asked) {
      throw clientError("contract_violation", {
        detail: `The server answered ${capped(built)} for ${asked}.`,
        pointer: specIdOf(read) === specId ? "/content_version" : "/definition/spec_id",
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
  const selector = selectorPath(member);
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

/** The error that a version can no longer be fetched, ending with `fix`, the call that reads
 *  newer data, unless the newest version is this one. */
function unavailable(
  specId: string,
  contentVersion: string,
  newest: string | null,
  refusal: DfoError | undefined,
  fix: string,
): VersionUnavailableError {
  const lost = `${specId} at ${contentVersion} can no longer be fetched`;
  // The newest version names a plain build, which a cut ref's version need not equal even when
  // no newer data exists, so only an equal id says something.
  const detail =
    newest === contentVersion
      ? `${lost}, though the server lists it as the newest version.`
      : `${lost}. ${fix}`;
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
