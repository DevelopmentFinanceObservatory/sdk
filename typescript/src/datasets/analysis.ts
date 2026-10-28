/**
 * Running recipes on DFO and reading the frames they store.
 *
 * `runRecipe` posts a recipe's tree to `POST /datasets/analysis`. The runner answers 200 with the
 * format 2 ref of the frame it stored, or 202 `pending` while a root's dataset is still
 * building, which the client posts again after the answer's `Retry-After`, else its
 * `retry_after_s`, held between 1 and 60 seconds, until the call's deadline. The post is
 * idempotent: the same tree on the same roots stores nothing new. A refusal raises as the class
 * its code maps to, with the problem document's `fix` on `error.problem`.
 *
 * A derived frame reads in two requests, both derived from the ref member: the manifest at
 * `GET /datasets/derived/{ops_id}/{ocv}`, which carries the retention, citation, recipe and the
 * series the recipe left out, and the rows at `.../file?format=parquet&bundle=false&layout=frame`.
 * That file is the frame in the layout a dataset version's file has, and its bytes hash to the
 * ref's artifact digest, which `download` checks as it does for a dataset file.
 *
 * `fetchDerived` reads a derived ref. An exact read takes the frame the ref names; when its
 * stored frame has aged out (`artifact_expired`), DFO computes the recipe again on the root
 * versions the ref names, which must answer the same version, and the client reads the frame
 * that answer names. When its digest differs from the ref's, the read issues a `DfoWarning`
 * (`ref_digest_changed`). A refusal that says the roots cannot be read again raises
 * `VersionUnavailableError`; any other error raises as it came. `latest: true` posts the bare
 * derived root with `latest: true`, so DFO computes the stored recipe again on its datasets'
 * newest versions. `fetchComputedFrame` reads a frame from its ids alone, as a share's slot
 * names it, through the bare root with `latest: false`.
 *
 * Each read that left series out issues one `SeriesLeftOutWarning`, or raises it under
 * `strict`.
 */

import type { Dataset, DerivedFacts } from "./dataset.ts";
import { derivedDataset } from "./derived.ts";
import { download, invalid } from "./fetch.ts";
import { after, BUILD_READ_TIMEOUT_MS, pollInterval, waitFor } from "./operation.ts";
import type { Wait } from "./operation.ts";
import { columnRoles, isStart, recipe } from "./recipe.ts";
import type {
  AggregateOptions,
  FilterOptions,
  GrowthOptions,
  PairOptions,
  RankOptions,
  ShareOfOptions,
  Start,
} from "./recipe.ts";
import type { Recipe } from "./recipe.ts";
import { clientError, DfoError, optionsOf, VersionUnavailableError } from "../core/errors.ts";
import type { ContractError, DfoTimeoutError } from "../core/errors.ts";
import { isRecord, present } from "../core/json.ts";
import { DatasetRef, FormatError, isDerived } from "../core/ref.ts";
import type { DerivedRefMember } from "../core/ref.ts";
import { describing } from "../core/trace.ts";
import { clientWarning } from "../core/warnings.ts";
import { passedDeadline, retryAfterMs } from "../http/transport.ts";
import type { Transport } from "../http/transport.ts";

const ANALYSIS_PATH = "/datasets/analysis";
/** The query of the derived file route that serves a frame's rows as one bare Parquet file in
 *  the frame layout, the only layout a derived frame has. */
const FRAME_FILE = "format=parquet&bundle=false&layout=frame";
const EXPIRED = "artifact_expired";
/** The refusals of a recomputation that mean DFO cannot read the expired frame's roots again,
 *  so the frame can no longer be fetched. Any other refusal, a transient one included, raises as
 *  it came. */
const ROOTS_UNREADABLE: ReadonlySet<string> = new Set([
  "snapshot_not_found",
  "artifact_expired",
  "recipe_not_found",
  "rendering_not_recorded",
]);

/** The call that recomputes a derived ref on its datasets' newest versions. */
const LATEST_CALL = "client.fetch(ref, { latest: true })";

/** How a recipe or a derived ref is fetched. */
export type AnalysisFetchOptions = {
  readonly latest?: boolean | undefined;
  readonly strict?: boolean | undefined;
  readonly timeout?: number | undefined;
  readonly signal?: AbortSignal | undefined;
};

/** How a `client.analysis` call runs, as `client.fetch` takes the same options. */
export type RunOptions = {
  /** Raises the `SeriesLeftOutWarning` instead of passing it to the warning handler. */
  strict?: boolean;
  /** The longest the call takes, the read included, in milliseconds. None by default: the call
   *  waits as long as the readings take to build. Past it the call raises `DfoTimeoutError`
   *  (`deadline_exceeded`). */
  timeout?: number;
  /** Aborts the call, rejecting with `signal.reason`. */
  signal?: AbortSignal;
};

/** A call's options split into the step's own and the run's. Options that are not an object
 *  stay with the step, whose check refuses them. */
function split<T>(options: T & RunOptions): [T, AnalysisFetchOptions] {
  if (!isRecord(options)) return [options, {}];
  const { strict, timeout, signal, ...step } = options;
  return [step as T, present({ strict, timeout, signal })];
}

/**
 * Runs `target` on DFO and reads the frame it stores.
 *
 * @throws {InvalidRequestError} The recipe has no step and starts from a dataset version or a
 *   spec (`invalid_argument`), or DFO refused the tree.
 * @throws {DfoTimeoutError} The `timeout` passed while a root was still building
 *   (`deadline_exceeded`).
 * @throws {ContractError} DFO answered a ref or manifest this client cannot read
 *   (`contract_violation`), or a file that is not Parquet (`unexpected_response`).
 * @throws {SeriesLeftOutWarning} `strict` is true and the recipe left series out.
 */
export async function runRecipe(
  transport: Transport,
  target: Recipe,
  options: AnalysisFetchOptions = {},
): Promise<Dataset> {
  const tree = target.tree();
  const wait = waitFor(transport, options);
  const member = await analyse(transport, { tree, latest: options.latest ?? false }, wait);
  return read(transport, member, options.strict ?? false, wait, target);
}

/**
 * The derived frame a ref names, or with `latest: true` its recipe computed again on its
 * datasets' newest versions.
 *
 * @throws {InvalidRequestError} The ref holds several members, which one read cannot stack
 *   (`invalid_argument`); no request is sent.
 * @throws {VersionUnavailableError} The frame has aged out and DFO cannot read its roots again
 *   (`snapshot_not_found`, `artifact_expired`, `recipe_not_found` or `rendering_not_recorded`),
 *   or computed another version on them.
 */
export async function fetchDerived(
  transport: Transport,
  ref: DatasetRef,
  options: AnalysisFetchOptions = {},
): Promise<Dataset> {
  const member = oneMember(ref);
  const strict = options.strict ?? false;
  const wait = waitFor(transport, options);
  const root = { spec_id: member.spec.spec_id, content_version: member.contentVersion };
  if (options.latest === true) {
    const newest = await analyse(transport, { tree: root, latest: true }, wait);
    return read(transport, newest, strict, wait);
  }
  let expired: DfoError;
  try {
    return await read(transport, member, strict, wait);
  } catch (error) {
    if (!(error instanceof DfoError) || error.code !== EXPIRED) throw error;
    expired = error;
  }
  let again: DerivedRefMember;
  try {
    again = await analyse(transport, { tree: root, latest: false }, wait);
  } catch (error) {
    if (!(error instanceof DfoError) || !ROOTS_UNREADABLE.has(error.code)) throw error;
    throw unavailable(member, error);
  }
  if (again.contentVersion !== member.contentVersion) throw unavailable(member, expired);
  if (again.digest !== member.digest) noteNewDigest(transport, member, again.digest);
  return read(transport, again, strict, wait);
}

/** Issues the client's warning that DFO computed the ref's frame again with another digest. The
 *  recomputation answered the ref's version, so the rows are the frame the ref names, written to
 *  bytes with another digest. The data is returned, so strict does not raise it. */
function noteNewDigest(transport: Transport, member: DerivedRefMember, digest: string): void {
  transport.warn(
    clientWarning(
      "ref_digest_changed",
      `${member.spec.spec_id} at ${member.contentVersion} was computed again as ${digest}, not ` +
        `the ref's ${member.digest}; the version is the same, and dataset.ref names the new file.`,
    ),
  );
}

/**
 * The frame DFO computed that `specId` and `contentVersion` name, read through its bare root,
 * which answers the frame's ref member. DFO answers the stored frame, or computes its recipe
 * again on the versions it read when the stored frame has aged out.
 *
 * @throws {DfoTimeoutError} The deadline passed while a root was building
 *   (`deadline_exceeded`).
 * @throws {VersionUnavailableError} DFO computed another version on the versions the recipe
 *   read, so this one can no longer be fetched.
 * @throws {ContractError} DFO answered a ref this client cannot read (`contract_violation`).
 */
export async function fetchComputedFrame(
  transport: Transport,
  specId: string,
  contentVersion: string,
  strict: boolean,
  wait: Wait,
): Promise<Dataset> {
  const tree = { spec_id: specId, content_version: contentVersion };
  const member = await analyse(transport, { tree, latest: false }, wait);
  if (member.contentVersion !== contentVersion) {
    throw clientError("version_unavailable", {
      detail:
        `${specId} at ${contentVersion} can no longer be fetched, and DFO computed ` +
        `${member.contentVersion} on the versions it read.`,
    });
  }
  return read(transport, member, strict, wait);
}

function oneMember(ref: DatasetRef): DerivedRefMember {
  const [first, ...others] = ref.members;
  if (first === undefined || others.length > 0 || !isDerived(first)) {
    throw invalid(
      `The DatasetRef names ${ref.members.length} frames DFO computed, and one fetch reads ` +
        "one; fetch each with client.fetch(new DatasetRef([ref.members[0]])).",
    );
  }
  return first;
}

function unavailable(member: DerivedRefMember, refusal: DfoError): VersionUnavailableError {
  return new VersionUnavailableError({
    ...optionsOf(refusal),
    detail:
      `${member.spec.spec_id} at ${member.contentVersion} can no longer be fetched, and DFO ` +
      `cannot compute it again on the versions it read. For the newest version: ${LATEST_CALL}`,
    retryable: false,
    retryAfterMs: null,
    newestVersion: null,
  });
}

/**
 * Posts a recipe tree until DFO answers its stored frame's ref member.
 *
 * @throws {DfoTimeoutError} The deadline passed while a root was building
 *   (`deadline_exceeded`).
 * @throws {ContractError} DFO answered another status than 200 or 202 (`unexpected_response`),
 *   or a ref this client cannot read (`contract_violation`).
 */
async function analyse(
  transport: Transport,
  body: Readonly<Record<string, unknown>>,
  wait: Wait,
): Promise<DerivedRefMember> {
  for (;;) {
    let response;
    try {
      response = await transport.request({
        path: ANALYSIS_PATH,
        json: body,
        timeout: BUILD_READ_TIMEOUT_MS,
        deadline: wait.deadline,
        signal: wait.signal,
      });
    } catch (error) {
      if (error instanceof DfoError && passedDeadline(error)) throw stillBuilding(wait, error);
      throw error;
    }
    const { status, traceId } = response;
    if (status === 200) return describing(traceId, () => readyMember(response.body));
    if (status !== 202) {
      throw clientError("unexpected_response", {
        status,
        detail: `POST ${ANALYSIS_PATH} answered HTTP ${status}; an analysis answers 200 or 202.`,
        traceId,
      });
    }
    const ms = pollInterval(pendingWait(response.headers, response.body));
    if (transport.now() + ms >= wait.deadline) throw stillBuilding(wait);
    await transport.sleep(ms, wait.signal);
  }
}

const stillBuilding = (wait: Wait, cause?: unknown): DfoTimeoutError =>
  clientError("deadline_exceeded", {
    detail:
      `DFO is still building the data the recipe reads${after(wait)}. The same fetch joins ` +
      "those builds.",
    cause,
  });

/** The wait a pending answer asks for, in milliseconds: its `Retry-After`, else its
 *  `retry_after_s`, else none. */
function pendingWait(headers: Headers, answer: unknown): number {
  const header = retryAfterMs(headers);
  if (header !== undefined) return header;
  const seconds = isRecord(answer) ? answer["retry_after_s"] : undefined;
  return typeof seconds === "number" && Number.isFinite(seconds) ? seconds * 1000 : 0;
}

/**
 * The derived member of a ready analysis answer's ref.
 *
 * @throws {ContractError} The answer holds no format 2 ref of one derived member
 *   (`contract_violation`).
 */
function readyMember(answer: unknown): DerivedRefMember {
  let ref: DatasetRef;
  try {
    ref = DatasetRef.fromJSON(isRecord(answer) ? answer["ref"] : undefined);
  } catch (error) {
    if (!(error instanceof FormatError) && !(error instanceof TypeError)) throw error;
    const pointer = `/ref${error instanceof FormatError ? error.pointer : ""}`;
    throw violation(pointer, error);
  }
  const [member, ...others] = ref.members;
  if (member === undefined || others.length > 0 || !isDerived(member)) {
    throw violation("/ref/members");
  }
  return member;
}

const violation = (pointer: string, cause?: unknown): ContractError =>
  clientError("contract_violation", {
    detail: `POST ${ANALYSIS_PATH} answered a ref whose ${pointer} this client cannot read.`,
    pointer,
    cause,
  });

/** The derived frame `member` names, from its manifest and its file. The dataset names each
 *  column by the role word `chain`, the recipe that made it, named it by. */
async function read(
  transport: Transport,
  member: DerivedRefMember,
  strict: boolean,
  wait: Wait,
  chain?: Recipe,
): Promise<Dataset> {
  const path = `/datasets/derived/${member.spec.spec_id}/${member.contentVersion}`;
  const { deadline, signal } = wait;
  const response = await transport.request({ path, deadline, signal });
  const manifest = response.body;
  if (!isRecord(manifest)) {
    throw clientError("contract_violation", {
      detail: `GET ${path} answered a manifest that is not an object.`,
      traceId: response.traceId,
    });
  }
  const target = { path: `${path}/file?${FRAME_FILE}` };
  const data = await download(transport, target, member.digest, wait);
  const recipeObject = manifest["recipe"];
  const tree = isRecord(recipeObject) ? recipeObject["tree"] : undefined;
  const roles = chain === undefined ? {} : columnRoles(chain, tree);
  const { dataset, facts } = await derivedDataset(member, manifest, data, response.traceId, roles);
  if (facts.leftOut.length > 0) noteLeftOut(transport, facts, strict);
  return dataset;
}

/** Issues the one warning that the recipe dropped series, or raises it under `strict`. */
function noteLeftOut(transport: Transport, facts: DerivedFacts, strict: boolean): void {
  const count = facts.leftOut.length.toLocaleString("en-GB");
  const least = facts.leftOutComplete ? "" : "at least ";
  const steps = [...new Set(facts.leftOut.map((series) => series.step.verb))].join(", ");
  const warning = clientWarning(
    "series_left_out",
    `${least}${count} series left out for missing data by ${steps}; the dataset's leftOut ` +
      "lists each with its step and reason",
  );
  if (strict) throw warning;
  transport.warn(warning);
}

/**
 * DFO's operations, each run at once on DFO as a recipe of one step. Each call takes a spec,
 * `DatasetRef`, `Dataset` or `Recipe` and returns a derived `Dataset`; `recipe(start)` describes
 * a longer chain to fetch in one request with `client.fetch`. Each takes `strict`, `timeout` and
 * `signal` beside its own options, as `client.fetch` does.
 */
export class Analysis {
  readonly #transport: Transport;

  /** @internal A client builds its own, as `client.analysis`. */
  constructor(transport: Transport) {
    this.#transport = transport;
  }

  /** The calls it offers, as `<Analysis: filter, aggregate, …>`. */
  toString(): string {
    return "<Analysis: filter, aggregate, growth, rank, quotientOf, shareOf, join, sumOf, compare>";
  }

  /** Node's `console.log` and `util.inspect` show it as `String(client.analysis)` does. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }

  #run(chain: Recipe, run: AnalysisFetchOptions): Promise<Dataset> {
    return runRecipe(this.#transport, chain, run);
  }

  /**
   * Keeps the rows whose role or column holds one of the values, as
   * `{ keep: { destination: ["country/KEN"] } }`.
   *
   * @throws {InvalidRequestError} `keep` is malformed, and no request is sent
   *   (`invalid_argument`); or DFO refused the step.
   * @throws {DfoTimeoutError} The `timeout` passed (`deadline_exceeded`).
   */
  async filter(data: Start, options: FilterOptions & RunOptions): Promise<Dataset> {
    const [step, run] = split(options);
    return this.#run(recipe(data).filter(step), run);
  }

  /** Totals or averages, keeping the members of `by` apart: `how` is `sum` by default, or
   *  `mean`, `max` or `min`. */
  async aggregate(data: Start, options: AggregateOptions & RunOptions = {}): Promise<Dataset> {
    const [step, run] = split(options);
    return this.#run(recipe(data).aggregate(step), run);
  }

  /** Change from the first to the last year of `window`, for each member of `by`: with
   *  `relative`, the default, the change divided by the first year's value, a fraction where
   *  0.25 is a 25% rise; with `difference`, the last year's value minus the first's, in the
   *  data's unit. */
  async growth(data: Start, options: GrowthOptions & RunOptions): Promise<Dataset> {
    const [step, run] = split(options);
    return this.#run(recipe(data).growth(step), run);
  }

  /** Orders the members of `by`, largest first, and keeps the top `limit`, from 1 to 1000. A
   *  `window` such as `[latestYear(), latestYear()]` ranks those years; none ranks every year. */
  async rank(data: Start, options: RankOptions & RunOptions): Promise<Dataset> {
    const [step, run] = split(options);
    return this.#run(recipe(data).rank(step), run);
  }

  /** Divides one reading by another, pairing roles through `on`, such as aid per person with
   *  `{ on: { destination: "place" } }`. */
  async quotientOf(
    data: Start,
    other: Start,
    options: PairOptions & RunOptions = {},
  ): Promise<Dataset> {
    const [step, run] = split(options);
    return this.#run(recipe(data).quotientOf(other, step), run);
  }

  /**
   * Each value as a percentage of the matching row of `total`, from 0 to 100 when each value is
   * part of its total, so 25 is a quarter; or of the total across all members of `by` in the
   * same year, as `client.analysis.shareOf(data, { by: "origin" })`.
   *
   * @throws {InvalidRequestError} Neither `total` nor `by` is given (`invalid_argument`); no
   *   request is sent.
   */
  async shareOf(data: Start, options: ShareOfOptions & RunOptions): Promise<Dataset>;
  async shareOf(data: Start, total: Start, options?: ShareOfOptions & RunOptions): Promise<Dataset>;
  async shareOf(
    data: Start,
    total?: Start | (ShareOfOptions & RunOptions),
    options?: ShareOfOptions & RunOptions,
  ): Promise<Dataset> {
    const chain = recipe(data);
    if (isStart(total)) {
      const [step, run] = split(options ?? {});
      return this.#run(chain.shareOf(total, step), run);
    }
    if (options !== undefined) {
      throw invalid("shareOf takes the total reading second, then its options.");
    }
    const [step, run] = split(total ?? {});
    return this.#run(chain.shareOf(step), run);
  }

  /** Both readings' matched rows in long format, told apart by `stat_var`. */
  async join(data: Start, other: Start, options: PairOptions & RunOptions = {}): Promise<Dataset> {
    const [step, run] = split(options);
    return this.#run(recipe(data).join(other, step), run);
  }

  /** The matching rows of two readings added over the years both hold. */
  async sumOf(data: Start, other: Start, options: PairOptions & RunOptions = {}): Promise<Dataset> {
    const [step, run] = split(options);
    return this.#run(recipe(data).sumOf(other, step), run);
  }

  /** `data` minus `other` for each matching member over the years both hold. DFO refuses two
   *  different units. */
  async compare(
    data: Start,
    other: Start,
    options: PairOptions & RunOptions = {},
  ): Promise<Dataset> {
    const [step, run] = split(options);
    return this.#run(recipe(data).compare(other, step), run);
  }
}
