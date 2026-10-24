/**
 * Build requests and long builds: posting a build, polling its operation, resuming one.
 *
 * A build posts to `/datasets`. The server answers a build within its synchronous limits with
 * the manifest, and a larger one with a 202 operation the client polls at
 * `/datasets/operations/{id}` until it is done or the deadline passes.
 *
 * This module owns build retries. The build request goes with no transport retries and reads
 * for up to 150 seconds within the call's deadline. Every retryable refusal of the build shares
 * the transport's retry count, and once a synchronous cut-off (a retryable 504, or the
 * 150-second read running out) refuses it, the build is posted once more only, whatever that
 * post answers. Each retry waits its `Retry-After` or else the transport's backoff, and a
 * `Retry-After` past 60 seconds raises the refusal at once. A retryable failed operation is
 * resubmitted once, unless the poll at the deadline reads it, which raises the failure.
 *
 * Polls wait for a refused poll's `Retry-After`, whatever its status, else the resource's
 * `retry_after_ms`, else the last answered poll's `Retry-After` header, any of them clamped to
 * 1 to 60 seconds, else back off from 1 to 8 seconds, the backoff advancing only when a wait
 * uses it. A wait that would reach the deadline is cut to end at it, and the poll that follows
 * runs for one attempt of the client's timeout. The poll at the deadline follows a
 * poll the deadline cuts off at once, as it does a wait with no time left. The build is still running at the
 * deadline only when that poll does not read it finished. Once that poll reads the build done,
 * each request that downloads it runs for one attempt of the client's timeout, so the call
 * returns the data. A refused poll that is not retryable, or whose `Retry-After` is past 60
 * seconds, raises at once, a 429 included. A retryable 429 spends no retry. Any other
 * retryable refused poll, one that runs past the client's timeout included, spends one of the
 * transport's retries, which a poll that answers restores.
 *
 * An operation resource is checked as it is read: a status outside `pending`, `running`,
 * `done` and `failed`, a failed operation whose error's status is not 4xx or 5xx, or a poll
 * that answers for another operation raises `contract_violation`.
 */

import type { Dataset } from "./dataset.ts";
import { capped, clientError, DfoError, DfoTimeoutError } from "../core/errors.ts";
import { CONTENT_VERSION, mintOptions } from "../core/ref.ts";
import type { Rendering } from "../core/ref.ts";
import { checkStrict } from "../core/strict.ts";
import { describing } from "../core/trace.ts";
import { passedDeadline, RETRY_AFTER_MAX_S, retryAfterMs } from "../http/transport.ts";
import type { JsonResponse, Transport } from "../http/transport.ts";
import { isRecord } from "../core/json.ts";

/** The longest the client reads a synchronous build. The server cuts one off at 120 s. */
const BUILD_READ_TIMEOUT_MS = 150_000;
const POLL_BACKOFF_FIRST_MS = 1_000;
const POLL_BACKOFF_CAP_MS = 8_000;
/** An operation id: `op_` and 64 lower-case hex digits, one path segment as it stands. */
const OPERATION_ID = /^op_[0-9a-f]{64}$/;

const DONE = "done";
const FAILED = "failed";
/** The statuses an operation resource holds. */
const STATUSES: ReadonlySet<string> = new Set(["pending", "running", DONE, FAILED]);
const OPERATION_FAILED = "operation_failed";

/** A manifest as the server sent it, checked for the members the client acts on. */
export type Manifest = Readonly<Record<string, unknown>>;

/** How far a long build has got, as the server last reported it. */
export type Progress = {
  readonly rowsWritten: number | null;
  readonly estimateRows: number | null;
};

/** One progress report from a long build. */
export type ProgressEvent = {
  readonly operationId: string;
  readonly progress: Progress;
  readonly traceId: string | null;
};

export type ProgressHandler = (event: ProgressEvent) => void;

/** How the client followed one long build: the operation it polls, each wait before a poll
 *  in milliseconds, and how many times it posted the build again after a retryable failure. */
export type LongBuild = {
  readonly operationId: string | null;
  readonly pollWaits: readonly number[];
  readonly resubmissions: number;
};

/** One reading of an operation resource. */
type OperationState = {
  readonly operationId: string;
  /** `pending`, `running`, `done` or `failed`. */
  readonly status: string;
  readonly retryAfterMs: number | null;
  readonly progress: Progress | null;
  readonly manifest: Manifest | null;
  readonly error: Readonly<Record<string, unknown>> | null;
};

/** The server's answer to a build request or a poll. */
type Reply = {
  readonly manifest: Manifest | null;
  readonly state: OperationState | null;
  /** The wait the `Retry-After` header asks for. */
  readonly headerWaitMs: number | null;
  readonly traceId: string | null;
};

/** When a call must finish and the signal that aborts it. A download after the deadline poll
 *  also sets each request's retries and attempt timeout, which otherwise are the transport's,
 *  and a file's read, which otherwise runs until the deadline. */
export type Wait = {
  readonly deadline: number;
  readonly signal?: AbortSignal | undefined;
  readonly maxRetries?: number;
  readonly timeout?: number;
};

/** Whether a problem document's `status` is a 4xx or 5xx. */
const isErrorStatus = (value: unknown): boolean =>
  typeof value === "number" && Number.isInteger(value) && value >= 400 && value < 600;

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null;

/** Checks a manifest for the members the client acts on, its `content_version` a version id
 *  a ref can hold, and returns it. */
export function readManifest(body: unknown): Manifest {
  checkStrict("Manifest", body);
  if (!isRecord(body)) {
    throw clientError("contract_violation", {
      detail: "The manifest is not an object.",
    });
  }
  const version = body["content_version"];
  if (typeof version !== "string" || !CONTENT_VERSION.test(version)) {
    throw clientError("contract_violation", {
      detail: "The manifest's content_version is not cv_ and 32 lower-case hex digits.",
      pointer: "/content_version",
    });
  }
  return body;
}

function readOperation(body: unknown): OperationState {
  checkStrict("OperationResource", body);
  // checkStrict has proved the resource and its operation are objects with an id and status.
  const resource = body as Record<string, unknown>;
  const operation = resource["operation"] as Record<string, unknown>;
  const status = String(operation["status"]);
  const wait = operation["retry_after_ms"];
  const progress = operation["progress"];
  const error = resource["error"];
  if (
    typeof operation["operation_id"] !== "string" ||
    !OPERATION_ID.test(operation["operation_id"])
  ) {
    throw clientError("contract_violation", {
      detail: "The operation's id is not op_ and 64 lower-case hex digits.",
    });
  }
  if (!STATUSES.has(status)) {
    throw clientError("contract_violation", {
      detail: `The operation ${operation["operation_id"]} has the status ${capped(
        JSON.stringify(status),
      )}, not pending, running, done or failed.`,
      pointer: "/operation/status",
    });
  }
  const errorStatus = isRecord(error) ? error["status"] : undefined;
  if (status === FAILED && errorStatus !== undefined && !isErrorStatus(errorStatus)) {
    throw clientError("contract_violation", {
      detail: `The failed operation ${operation["operation_id"]} gives its error the status ${capped(
        JSON.stringify(errorStatus),
      )}, not a 4xx or 5xx.`,
      pointer: "/error/status",
    });
  }
  if (status === DONE && !isRecord(resource["manifest"])) {
    throw clientError("contract_violation", {
      detail: `The done operation ${operation["operation_id"]} holds no manifest.`,
    });
  }
  return {
    operationId: operation["operation_id"],
    status,
    retryAfterMs: typeof wait === "number" && wait >= 0 ? wait : null,
    progress: isRecord(progress)
      ? {
          rowsWritten: count(progress["rows_written"]),
          estimateRows: count(progress["estimate_rows"]),
        }
      : null,
    manifest: status === DONE ? readManifest(resource["manifest"]) : null,
    error: isRecord(error) ? error : null,
  };
}

/** A response carrying an operation resource, read and checked. */
const operationReply = (response: JsonResponse): Reply => ({
  manifest: null,
  state: describing(response.traceId, () => readOperation(response.body)),
  headerWaitMs: retryAfterMs(response.headers) ?? null,
  traceId: response.traceId,
});

/** A build answers 200 with the manifest, or 202 with the operation it started. */
function buildReply(response: JsonResponse): Reply {
  if (response.status === 200) {
    return {
      manifest: describing(response.traceId, () => readManifest(response.body)),
      state: null,
      headerWaitMs: retryAfterMs(response.headers) ?? null,
      traceId: response.traceId,
    };
  }
  if (response.status === 202) return operationReply(response);
  throw clientError("unexpected_response", {
    status: response.status,
    detail: `POST /datasets answered HTTP ${response.status}; a build answers 200 or 202.`,
    traceId: response.traceId,
  });
}

/** A poll answers 200 with the resource of the operation it asked for. */
function pollReply(response: JsonResponse, operationId: string): Reply {
  if (response.status !== 200) {
    throw clientError("unexpected_response", {
      status: response.status,
      detail: `${response.url.pathname} answered HTTP ${response.status}; a poll answers 200.`,
      traceId: response.traceId,
    });
  }
  const reply = operationReply(response);
  const answered = reply.state!.operationId;
  if (answered !== operationId) {
    throw clientError("contract_violation", {
      detail: `The poll of ${operationId} answered for ${answered}.`,
      pointer: "/operation/operation_id",
      traceId: response.traceId,
    });
  }
  return reply;
}

/** The bounds a long build's poll interval from the server is clamped to, in seconds. */
const POLL_INTERVAL_MIN_S = 1;
const POLL_INTERVAL_MAX_S = 60;

/** The server's poll interval, clamped to `POLL_INTERVAL_MIN_S` .. `POLL_INTERVAL_MAX_S`. */
const pollInterval = (ms: number): number =>
  Math.min(Math.max(ms, POLL_INTERVAL_MIN_S * 1000), POLL_INTERVAL_MAX_S * 1000);

/** The wait before poll `step` (from 0) when the server sends no pacing. */
const pollBackoff = (step: number): number =>
  Math.min(POLL_BACKOFF_FIRST_MS * 2 ** step, POLL_BACKOFF_CAP_MS);

/** Whether the server, or the 150-second read, cut a synchronous build off. The deadline
 *  passing is no cut-off. */
const isCutOff = (error: DfoError): boolean =>
  error.retryable &&
  !passedDeadline(error) &&
  (error.status === 504 || (error instanceof DfoTimeoutError && error.status === null));

/**
 * Posts a build request and owns its retries. Every retryable refusal spends one of the
 * transport's retries, and after a cut-off the build is posted once more only.
 *
 * @throws {DfoError} The refusal, once the retries a build allows are spent.
 */
async function postBuild(transport: Transport, body: unknown, { deadline, signal }: Wait) {
  let cutOff = false;
  for (let retries = 0; ; retries += 1) {
    try {
      const response = await transport.request({
        path: "/datasets",
        json: body,
        timeout: BUILD_READ_TIMEOUT_MS,
        deadline,
        maxRetries: 0,
        signal,
      });
      return buildReply(response);
    } catch (error) {
      if (!(error instanceof DfoError)) throw error;
      const allowed = retries < transport.maxRetries && !cutOff;
      const wait = allowed ? transport.refusalWait(error, retries, deadline) : undefined;
      if (wait === undefined) throw error;
      await transport.sleep(wait, signal);
      cutOff = isCutOff(error);
    }
  }
}

/** The `options` a build request posts, or none. */
function postedOptions(body: unknown): Readonly<Record<string, unknown>> {
  const options = isRecord(body) ? body["options"] : undefined;
  return isRecord(options) ? options : {};
}

/** Polls one build until it is done, at the server's pacing. */
export class Poller implements LongBuild {
  readonly #transport: Transport;
  /** The build request, resubmitted once when the operation fails retryably. Undefined for a
   *  resumed operation. */
  readonly #body: unknown;
  /** The build's rendering options, as its request's `options` writes them, which the resume
   *  hint names. */
  readonly #buildOptions: Readonly<Record<string, unknown>>;
  #onProgress: ProgressHandler | undefined;
  #manifest: Manifest | null = null;
  #state: OperationState | null = null;
  #headerWaitMs: number | null = null;
  /** The `Retry-After` of the refusal of the last poll. */
  #refusedWaitMs: number | null = null;
  #traceId: string | null = null;
  #error: DfoError | null = null;
  #backoffStep = 0;
  #retries = 0;
  #resubmissions = 0;
  readonly #pollWaits: number[] = [];
  #started = false;
  /** Whether the poll at the deadline read the build done. */
  #late = false;

  constructor(
    transport: Transport,
    reply: Reply,
    options: {
      body?: unknown;
      rendering?: Rendering;
      onProgress?: ProgressHandler | undefined;
    },
  ) {
    this.#transport = transport;
    this.#body = options.body;
    this.#buildOptions =
      options.rendering === undefined
        ? postedOptions(options.body)
        : mintOptions(options.rendering);
    this.#onProgress = options.onProgress;
    this.#take(reply);
  }

  get operationId(): string | null {
    return this.#state?.operationId ?? null;
  }

  get progress(): Progress | null {
    return this.#state?.progress ?? null;
  }

  get pollWaits(): readonly number[] {
    return this.#pollWaits;
  }

  get resubmissions(): number {
    return this.#resubmissions;
  }

  /** The trace id of the response the build was last read from. */
  get traceId(): string | null {
    return this.#traceId;
  }

  /** Whether the poll at the deadline read the build done, which leaves its download no time
   *  within the deadline. */
  get late(): boolean {
    return this.#late;
  }

  get status(): string {
    if (this.#error !== null) return FAILED;
    if (this.#manifest !== null) return DONE;
    return this.#state?.status ?? DONE;
  }

  set onProgress(handler: ProgressHandler | undefined) {
    this.#onProgress = handler;
  }

  async done(wait: Wait): Promise<boolean> {
    this.#start();
    if (!this.#finished()) await this.#poll(wait, false);
    return this.#finished();
  }

  /** Polls until the build is done and returns its manifest. A wait that would reach the
   *  deadline ends at it, and the poll after it runs for one attempt, so the build is still
   *  running at the deadline only when the poll at the deadline does not read it finished. */
  async wait(wait: Wait): Promise<Manifest> {
    this.#start();
    while (!this.#finished()) {
      const left = wait.deadline - this.#transport.now();
      const next = this.#nextWait();
      const last = next >= left;
      const ms = Math.max(Math.min(next, left), 0);
      this.#pollWaits.push(ms);
      await this.#transport.sleep(ms, wait.signal);
      await this.#poll(wait, last);
      if (last && !this.#finished()) throw this.#stillRunning();
      this.#late = last;
    }
    if (this.#error !== null) throw this.#error;
    return this.#manifest!;
  }

  /** Reports the long build to the transport's observer when polling first starts. A build the
   *  server finished inline reports none. */
  #start(): void {
    if (this.#started || this.operationId === null) return;
    this.#started = true;
    this.#transport.longBuildStarted(this);
  }

  #finished(): boolean {
    return this.#manifest !== null || this.#error !== null;
  }

  #nextWait(): number {
    const refused = this.#refusedWaitMs;
    this.#refusedWaitMs = null;
    if (refused !== null) return pollInterval(refused);
    const paced = this.#state?.retryAfterMs ?? this.#headerWaitMs;
    if (paced !== null) return pollInterval(paced);
    const backoff = pollBackoff(this.#backoffStep);
    this.#backoffStep += 1;
    return backoff;
  }

  #stillRunning(): DfoTimeoutError {
    return this.resumeHinted("The build is still running at the deadline.");
  }

  /** A `deadline_exceeded` error whose message ends with the call that resumes the build. */
  resumeHinted(opening: string, cause?: unknown): DfoTimeoutError {
    // The rendering is in the id, so the resuming call names the build's options.
    const options = this.#buildOptions;
    const named = [
      ...(options["layout"] === "frame" ? ['layout: "frame"'] : []),
      ...(options["without_party_totals"] === true ? ["withoutPartyTotals: true"] : []),
    ];
    const id = JSON.stringify(this.operationId ?? "");
    const call = named.length === 0 ? id : `${id}, { ${named.join(", ")} }`;
    return clientError("deadline_exceeded", {
      detail: `${opening} Resume it with client.operation(${call}).`,
      cause,
    });
  }

  #take(reply: Reply): void {
    this.#state = reply.state ?? this.#state;
    this.#headerWaitMs = reply.headerWaitMs;
    this.#traceId = reply.traceId;
    const { state } = reply;
    if (reply.manifest !== null || state === null) {
      this.#manifest = reply.manifest;
      return;
    }
    if (state.status === DONE) {
      this.#manifest = state.manifest;
    } else if (state.status === FAILED) {
      // The error's status, else 500. The read has checked a status given is a 4xx or 5xx.
      const status = state.error?.["status"];
      this.#error = this.#transport.problemError(state.error, {
        status: typeof status === "number" ? status : 500,
        traceId: this.#traceId,
        untold: "The build failed.",
        fallbackCode: OPERATION_FAILED,
      });
    } else if (state.progress !== null) {
      this.#onProgress?.({
        operationId: state.operationId,
        progress: state.progress,
        traceId: this.#traceId,
      });
    }
  }

  /** Polls once, the request bounded by the wait's deadline and the client's timeout, or by the
   *  client's timeout alone for the `last` poll, at the deadline. A resubmitted build keeps to
   *  the wait's deadline, so the last poll resubmits none. */
  async #poll(wait: Wait, last: boolean): Promise<void> {
    const operationId = this.operationId ?? "";
    let response: JsonResponse;
    try {
      response = await this.#transport.request({
        path: `/datasets/operations/${encodeURIComponent(operationId)}`,
        deadline: last ? Infinity : wait.deadline,
        maxRetries: 0,
        signal: wait.signal,
      });
    } catch (error) {
      if (!(error instanceof DfoError)) throw error;
      // A poll the deadline cut off spends no retry, since the poll at the deadline follows
      // it. An attempt's own timeout spends one.
      if (passedDeadline(error)) return;
      await this.#pollFailed(error, wait, last);
      return;
    }
    this.#retries = 0;
    this.#take(pollReply(response, operationId));
    if (this.#error !== null) await this.#failed(this.#error, wait, last);
  }

  /** Keeps polling after a refused poll, or raises when polling again cannot help. */
  async #pollFailed(error: DfoError, wait: Wait, last: boolean): Promise<void> {
    if (error.code === OPERATION_FAILED) {
      this.#error = error;
      await this.#failed(error, wait, last);
      return;
    }
    const asked = error.retryAfterMs;
    if (!error.retryable || (asked !== null && asked > RETRY_AFTER_MAX_S * 1000)) throw error;
    if (error.status !== 429) {
      if (this.#retries >= this.#transport.maxRetries) throw error;
      this.#retries += 1;
    }
    this.#refusedWaitMs = error.retryAfterMs;
  }

  /** Resubmits a build that failed retryably, once, and otherwise holds the error. The `last`
   *  poll, at the deadline, holds it, since a resubmission would start with no time left. */
  async #failed(error: DfoError, wait: Wait, last: boolean): Promise<void> {
    if (last || !error.retryable || this.#body === undefined || this.#resubmissions > 0) {
      this.#error = error;
      return;
    }
    this.#resubmissions += 1;
    this.#error = null;
    this.#take(await postBuild(this.#transport, this.#body, wait));
  }
}

/** Turns a done build into the dataset an operation returns. */
export type Finish = (built: Built, wait: Wait) => Promise<Dataset<never>>;

/** Options for waiting on a long build. */
export type ResultOptions = {
  /** The longest to wait, polls and downloads included, in milliseconds; `Infinity` waits
   *  without limit. Defaults to 30 minutes. Each poll attempt waits the client's timeout
   *  within it. */
  timeout?: number;
  signal?: AbortSignal;
  onProgress?: ProgressHandler;
};

const DEFAULT_FETCH_TIMEOUT_MS = 1_800_000;

/** The deadline `timeout` milliseconds from now, or 30 minutes from now when none is given. */
export const deadlineOf = (transport: Transport, timeout: number | undefined): number =>
  transport.deadlineAfter(timeout ?? DEFAULT_FETCH_TIMEOUT_MS);

/**
 * A long dataset build, running on the server or already done. `client.mint(spec)` returns
 * one, and `client.operation(id)` resumes one from another process. `operationId` is null for
 * a build the server finished inline.
 */
export class Operation {
  readonly #transport: Transport;
  readonly #poller: Poller;
  readonly #finish: Finish;

  /** @internal Built by `mint` and `resumeOperation`. */
  constructor(transport: Transport, poller: Poller, finish: Finish) {
    this.#transport = transport;
    this.#poller = poller;
    this.#finish = finish;
  }

  /** The operation's id, `op_` and 64 hex digits, or null for a build finished inline. */
  get operationId(): string | null {
    return this.#poller.operationId;
  }

  /** `pending`, `running`, `done` or `failed`, as last read. A status outside these raises
   *  `contract_violation` on the poll that reads it. */
  get status(): string {
    return this.#poller.status;
  }

  /** The progress the server last reported, or null. */
  get progress(): Progress | null {
    return this.#poller.progress;
  }

  /** Whether the build has finished, polling once when it had not, for as long as the client's
   *  timeout lets one poll attempt run. */
  done(options: { signal?: AbortSignal } = {}): Promise<boolean> {
    return this.#poller.done({ deadline: Infinity, signal: options.signal });
  }

  /**
   * Waits for the build and returns its dataset.
   *
   * @throws {DfoTimeoutError} The build was still running at the deadline, or its download ran
   *   out of time. The message names the call that resumes it.
   * @throws {DfoError} The build failed.
   */
  async result(options: ResultOptions = {}): Promise<Dataset<never>> {
    const wait = { deadline: deadlineOf(this.#transport, options.timeout), signal: options.signal };
    if (options.onProgress !== undefined) this.#poller.onProgress = options.onProgress;
    const manifest = await this.#poller.wait(wait);
    return this.#finish({ manifest, traceId: this.#poller.traceId, poller: this.#poller }, wait);
  }
}

/** A built version's manifest, the trace id of the response that carried it, and the poller
 *  of the long build that made it, if any. */
export type Built = {
  readonly manifest: Manifest;
  readonly traceId: string | null;
  readonly poller?: Poller;
};

/**
 * Runs the requests that download a done build. Once the poll at the deadline has read the
 * build done, each request runs for one attempt of the client's timeout, so the call returns
 * the data. Any `deadline_exceeded` the download of a long build raises, an attempt's own
 * timeout with no retry left included, names the call that resumes it.
 */
export async function downloadBuilt<T>(
  transport: Transport,
  built: Built,
  wait: Wait,
  run: (wait: Wait) => Promise<T>,
): Promise<T> {
  const { poller } = built;
  if (poller === undefined || poller.operationId === null) return run(wait);
  const late = poller.late;
  const once = {
    deadline: Infinity,
    maxRetries: 0,
    timeout: transport.timeout,
    signal: wait.signal,
  };
  try {
    return await run(late ? once : wait);
  } catch (error) {
    if (error instanceof DfoTimeoutError && error.code === "deadline_exceeded") {
      throw poller.resumeHinted("The build is done, but its download ran out of time.", error);
    }
    throw error;
  }
}

/** Posts a build and waits for its manifest, through a long build when the server starts one. */
export async function build(
  transport: Transport,
  body: unknown,
  wait: Wait & { onProgress?: ProgressHandler | undefined },
): Promise<Built> {
  const reply = await postBuild(transport, body, wait);
  if (reply.manifest !== null) return { manifest: reply.manifest, traceId: reply.traceId };
  const poller = new Poller(transport, reply, { body, onProgress: wait.onProgress });
  const manifest = await poller.wait(wait);
  return { manifest, traceId: poller.traceId, poller };
}

/** Posts a build and returns it as an operation, done or running. */
export async function startOperation(
  transport: Transport,
  body: unknown,
  finish: Finish,
  wait: Wait & { onProgress?: ProgressHandler | undefined },
): Promise<Operation> {
  const reply = await postBuild(transport, body, wait);
  return new Operation(
    transport,
    new Poller(transport, reply, { body, onProgress: wait.onProgress }),
    finish,
  );
}

/**
 * Reads a running build's operation by id, to poll it from this process. `rendering` is the
 * one the build was started with, which the resume hint in a deadline's message names.
 *
 * @throws {InvalidRequestError} The id is not `op_` and 64 lower-case hex digits
 *   (`invalid_argument`).
 * @throws {NotFoundError} The server holds no operation with that id.
 */
export async function resumeOperation(
  transport: Transport,
  operationId: string,
  rendering: Rendering,
  finish: Finish,
  wait: Wait & { onProgress?: ProgressHandler | undefined },
): Promise<Operation> {
  if (!OPERATION_ID.test(operationId)) {
    throw clientError("invalid_argument", {
      detail:
        "The operation id is not op_ and 64 lower-case hex digits, as Operation.operationId " +
        "gives.",
    });
  }
  const response = await transport.request({
    path: `/datasets/operations/${operationId}`,
    deadline: wait.deadline,
    signal: wait.signal,
  });
  const poller = new Poller(transport, pollReply(response, operationId), {
    rendering,
    onProgress: wait.onProgress,
  });
  return new Operation(transport, poller, finish);
}
