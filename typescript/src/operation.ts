/**
 * Build requests and long builds: posting a build, polling its operation, resuming one.
 *
 * A build posts to `/datasets`. The server answers a build within its synchronous limits with
 * the manifest, and a larger one with a 202 operation the client polls at
 * `/datasets/operations/{id}` until it is done or the deadline passes.
 *
 * This module owns build retries: the build request goes with no transport retries and reads
 * for up to 150 seconds within the call's deadline, a synchronous cut-off (a retryable 504, or
 * the 150-second read running out) is retried once, other retryable refusals are retried within
 * the transport's retry count, each retry waiting its `Retry-After` or else the transport's
 * backoff, and a retryable failed operation is resubmitted once. Polls wait for a 429's
 * `Retry-After`, else the resource's `retry_after_ms`, else the `Retry-After` header, else back
 * off from 1 to 8 seconds; a 429 spends no retry, and a poll attempt that runs past the client's
 * timeout spends one.
 */

import type { Dataset } from "./dataset.ts";
import { clientError, DfoError, DfoTimeoutError, errorClassFor, serverCode } from "./errors.ts";
import { checkStrict } from "./strict.ts";
import { isRetryable, passedDeadline, retryAfterMs } from "./transport.ts";
import type { JsonResponse, Transport } from "./transport.ts";

/** The longest the client reads a synchronous build: the server cuts one off at 120 s. */
const BUILD_READ_TIMEOUT_MS = 150_000;
const POLL_BACKOFF_FIRST_MS = 1_000;
const POLL_BACKOFF_CAP_MS = 8_000;

const DONE = "done";
const FAILED = "failed";
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
  /** `pending`, `running`, `done`, `failed`, or a status this release does not know. */
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

type Wait = { readonly deadline: number; readonly signal?: AbortSignal | undefined };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null;

/** Checks a manifest for the members the client acts on and returns it. */
export function readManifest(body: unknown): Manifest {
  checkStrict("Manifest", body);
  if (!isRecord(body)) {
    throw clientError("contract_violation", {
      detail: "The manifest is not an object.",
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
  if (status === DONE && !isRecord(resource["manifest"])) {
    throw clientError("contract_violation", {
      detail: `The done operation ${String(operation["operation_id"])} holds no manifest.`,
    });
  }
  return {
    operationId: String(operation["operation_id"]),
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

const replyHeaders = (response: JsonResponse) => ({
  headerWaitMs: retryAfterMs(response.headers) ?? null,
  traceId: response.headers.get("x-dfo-trace-id"),
});

/** A build answers 200 with the manifest, or 202 with the operation it started. */
function buildReply(response: JsonResponse): Reply {
  if (response.status === 200) {
    return { manifest: readManifest(response.body), state: null, ...replyHeaders(response) };
  }
  if (response.status === 202) {
    return { manifest: null, state: readOperation(response.body), ...replyHeaders(response) };
  }
  throw clientError("unexpected_response", {
    status: response.status,
    detail: `POST /datasets answered HTTP ${response.status}; a build answers 200 or 202.`,
    traceId: response.headers.get("x-dfo-trace-id"),
  });
}

/** A poll answers 200 with the operation resource. */
function pollReply(response: JsonResponse): Reply {
  if (response.status === 200) {
    return { manifest: null, state: readOperation(response.body), ...replyHeaders(response) };
  }
  throw clientError("unexpected_response", {
    status: response.status,
    detail: `${response.url.pathname} answered HTTP ${response.status}; a poll answers 200.`,
    traceId: response.headers.get("x-dfo-trace-id"),
  });
}

/** The error a failed operation's problem document stands for, at the document's status or
 *  else 500, retryable by the rule every refusal follows. A document with no `error` raises
 *  `operation_failed`; one with no `trace_id` takes the response's `x-dfo-trace-id`. */
function problemError(
  problem: Readonly<Record<string, unknown>> | null,
  headerTrace: string | null,
): DfoError {
  const code = typeof problem?.["code"] === "string" ? problem["code"] : OPERATION_FAILED;
  const status = typeof problem?.["status"] === "number" ? problem["status"] : 500;
  const ErrorClass = errorClassFor(code, status);
  return new ErrorClass({
    code: serverCode(code),
    status,
    detail: typeof problem?.["detail"] === "string" ? problem["detail"] : "The build failed.",
    traceId: typeof problem?.["trace_id"] === "string" ? problem["trace_id"] : headerTrace,
    retryable: isRetryable(status, problem),
    problem,
  });
}

/** The wait before poll `step` (from 0) when the server sends no pacing. */
const pollBackoff = (step: number): number =>
  Math.min(POLL_BACKOFF_FIRST_MS * 2 ** step, POLL_BACKOFF_CAP_MS);

const fits = (transport: Transport, wait: number, deadline: number): boolean =>
  transport.now() + wait < deadline;

/** Whether the server, or the 150-second read, cut a synchronous build off. The deadline
 *  passing is no cut-off. */
const isCutOff = (error: DfoError): boolean =>
  error.retryable &&
  !passedDeadline(error) &&
  (error.status === 504 || (error instanceof DfoTimeoutError && error.status === null));

/**
 * Posts a build request, owning its retries.
 *
 * @throws {DfoError} The refusal, once the retries a build allows are spent.
 */
async function postBuild(transport: Transport, body: unknown, { deadline, signal }: Wait) {
  let cutOffRetried = false;
  let retries = 0;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await transport.request({
        path: "/datasets",
        json: body,
        timeout: BUILD_READ_TIMEOUT_MS,
        deadline,
        maxRetries: 0,
        ...(signal === undefined ? {} : { signal }),
      });
      return buildReply(response);
    } catch (error) {
      if (!(error instanceof DfoError)) throw error;
      const wait = error.retryAfterMs ?? transport.backoff(attempt);
      if (isCutOff(error)) {
        if (cutOffRetried || !fits(transport, wait, deadline)) throw error;
        cutOffRetried = true;
        await transport.sleep(wait, signal);
        continue;
      }
      if (!error.retryable || retries >= transport.maxRetries || !fits(transport, wait, deadline)) {
        throw error;
      }
      await transport.sleep(wait, signal);
      retries += 1;
    }
  }
}

/** Polls one build until it is done, at the server's pacing. */
class Poller implements LongBuild {
  readonly #transport: Transport;
  /** The build request, resubmitted once when the operation fails retryably; undefined for a
   *  resumed operation. */
  readonly #body: unknown;
  #onProgress: ProgressHandler | undefined;
  #manifest: Manifest | null = null;
  #state: OperationState | null = null;
  #headerWaitMs: number | null = null;
  /** The `Retry-After` of a 429 that refused the last poll. */
  #refusedWaitMs: number | null = null;
  #traceId: string | null = null;
  #error: DfoError | null = null;
  #backoffStep = 0;
  #retries = 0;
  #resubmissions = 0;
  readonly #pollWaits: number[] = [];
  #started = false;

  constructor(
    transport: Transport,
    reply: Reply,
    options: { body?: unknown; onProgress?: ProgressHandler | undefined },
  ) {
    this.#transport = transport;
    this.#body = options.body;
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
    if (!this.#finished()) await this.#poll(wait);
    return this.#finished();
  }

  /** Polls until the build is done and returns its manifest. */
  async wait(wait: Wait): Promise<Manifest> {
    this.#start();
    while (!this.#finished()) {
      const ms = this.#nextWait();
      if (!fits(this.#transport, ms, wait.deadline)) throw this.#stillRunning();
      this.#pollWaits.push(ms);
      await this.#transport.sleep(ms, wait.signal);
      await this.#poll(wait);
    }
    if (this.#error !== null) throw this.#error;
    return this.#manifest!;
  }

  /** Reports the long build to the transport's observer when polling first starts; a build the
   *  server finished inline is none. */
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
    if (refused !== null) return refused;
    const paced = this.#state?.retryAfterMs ?? this.#headerWaitMs;
    if (paced !== null) return paced;
    const backoff = pollBackoff(this.#backoffStep);
    this.#backoffStep += 1;
    return backoff;
  }

  #stillRunning(cause?: unknown): DfoTimeoutError {
    return clientError("deadline_exceeded", {
      detail:
        "The build is still running at the deadline. Resume it with " +
        `client.operation("${this.operationId ?? ""}").`,
      cause,
    });
  }

  #take(reply: Reply): void {
    this.#state = reply.state ?? this.#state;
    this.#headerWaitMs = reply.headerWaitMs;
    this.#traceId = reply.traceId ?? this.#traceId;
    const { state } = reply;
    if (reply.manifest !== null || state === null) {
      this.#manifest = reply.manifest;
      return;
    }
    if (state.status === DONE) {
      this.#manifest = state.manifest;
    } else if (state.status === FAILED) {
      this.#error = problemError(state.error, this.#traceId);
    } else if (state.progress !== null) {
      this.#onProgress?.({
        operationId: state.operationId,
        progress: state.progress,
        traceId: this.#traceId,
      });
    }
  }

  async #poll(wait: Wait): Promise<void> {
    let response: JsonResponse;
    try {
      response = await this.#transport.request({
        path: `/datasets/operations/${this.operationId ?? ""}`,
        deadline: wait.deadline,
        maxRetries: 0,
        ...(wait.signal === undefined ? {} : { signal: wait.signal }),
      });
    } catch (error) {
      if (!(error instanceof DfoError)) throw error;
      // The deadline passing ends the wait; an attempt's own timeout spends a retry.
      if (passedDeadline(error)) throw this.#stillRunning(error);
      await this.#pollFailed(error, wait);
      return;
    }
    this.#retries = 0;
    this.#take(pollReply(response));
    if (this.#error !== null) await this.#failed(this.#error, wait);
  }

  /** Keeps polling after a refused poll, or raises when polling again cannot help. */
  async #pollFailed(error: DfoError, wait: Wait): Promise<void> {
    if (error.code === OPERATION_FAILED) {
      this.#error = error;
      await this.#failed(error, wait);
      return;
    }
    if (error.status === 429) {
      this.#refusedWaitMs = error.retryAfterMs;
      return;
    }
    if (!error.retryable || this.#retries >= this.#transport.maxRetries) throw error;
    this.#retries += 1;
  }

  /** Resubmits a build that failed retryably, once; otherwise holds the error. */
  async #failed(error: DfoError, wait: Wait): Promise<void> {
    if (!error.retryable || this.#body === undefined || this.#resubmissions > 0) {
      this.#error = error;
      return;
    }
    this.#resubmissions += 1;
    this.#error = null;
    this.#take(await postBuild(this.#transport, this.#body, wait));
  }
}

/** Turns a done build's manifest into the dataset an operation returns. */
export type Finish = (manifest: Manifest, wait: Wait) => Promise<Dataset>;

/** Options for waiting on a long build. */
export type ResultOptions = {
  /** The longest to wait, polls and downloads included, in milliseconds; `Infinity` waits
   *  without limit. Defaults to 30 minutes. Each poll attempt waits the client's timeout
   *  within it. */
  timeout?: number;
  signal?: AbortSignal;
  onProgress?: ProgressHandler;
};

export const DEFAULT_FETCH_TIMEOUT_MS = 1_800_000;

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

  /** `pending`, `running`, `done` or `failed`, as last read. */
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
   * @throws {DfoTimeoutError} The build was still running at the deadline; the message names
   *   the call that resumes it.
   * @throws {DfoError} The build failed.
   */
  async result(options: ResultOptions = {}): Promise<Dataset> {
    const wait = {
      deadline: this.#transport.deadlineAfter(options.timeout ?? DEFAULT_FETCH_TIMEOUT_MS),
      signal: options.signal,
    };
    if (options.onProgress !== undefined) this.#poller.onProgress = options.onProgress;
    return this.#finish(await this.#poller.wait(wait), wait);
  }
}

/** Posts a build and waits for its manifest, through a long build when the server starts one. */
export async function build(
  transport: Transport,
  body: unknown,
  wait: Wait & { onProgress?: ProgressHandler | undefined },
): Promise<Manifest> {
  const reply = await postBuild(transport, body, wait);
  if (reply.manifest !== null) return reply.manifest;
  return new Poller(transport, reply, { body, onProgress: wait.onProgress }).wait(wait);
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
 * Reads a running build's operation by id, to poll it from this process.
 *
 * @throws {NotFoundError} The server holds no operation with that id.
 */
export async function resumeOperation(
  transport: Transport,
  operationId: string,
  finish: Finish,
  wait: Wait & { onProgress?: ProgressHandler | undefined },
): Promise<Operation> {
  const response = await transport.request({
    path: `/datasets/operations/${encodeURIComponent(operationId)}`,
    deadline: wait.deadline,
    ...(wait.signal === undefined ? {} : { signal: wait.signal }),
  });
  const poller = new Poller(transport, pollReply(response), {
    onProgress: wait.onProgress,
  });
  return new Operation(transport, poller, finish);
}
