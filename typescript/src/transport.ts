import type { CredentialsFileReader } from "./credentials.ts";
import type { EnvReader } from "./env.ts";
import { clientError, DfoError, errorClassFor, isRetryableStatus, serverCode } from "./errors.ts";
import type { DfoTimeoutError } from "./errors.ts";
import {
  ApiKey,
  checkKeyFormat,
  inBrowser,
  refuseSecretKeyInBrowser,
  resolveApiKey,
} from "./keys.ts";
import type { ApiKeyOption, ResolvedKey } from "./keys.ts";
import type { LongBuild } from "./operation.ts";
import { VERSION } from "./version.ts";
import { clientWarning, emitWarning, warnOnce } from "./warnings.ts";
import type { DfoWarning, WarningHandler } from "./warnings.ts";

/** The public API's base URL. */
export const DEFAULT_BASE_URL = "https://developmentfinance.org/api/v1";
/** The longest one request attempt waits, in milliseconds, unless a call sets its own. */
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 2;
/** The storage host the API's files route redirects a download to. */
export const STORAGE_ORIGIN = "https://storage.googleapis.com";

const BACKOFF_START_MS = 500;
const BACKOFF_CAP_MS = 8_000;
/** The longest delay a platform timer holds, about 24.8 days; a longer limit is clamped to it. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** The website proxy's `retry` value for a refusal that clears on its own. */
const PROXY_RETRY = "retry_after_delay";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** The media types a refusal body is read as a problem document under. */
const PROBLEM_TYPES = new Set(["application/problem+json", "application/json"]);

type Fetch = typeof globalThis.fetch;
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
export type HeaderProvider = (request: {
  method: string;
  url: URL;
}) => HeadersInit | Promise<HeadersInit>;

export type TransportOptions = {
  /** The API's base URL; a relative one, such as `/api/v1`, resolves against the page. */
  baseUrl?: string;
  apiKey?: ApiKeyOption;
  /** Sends a secret key from a browser page, where every script on the page can read it. */
  dangerouslyAllowBrowser?: boolean;
  /** The platform's `fetch`, or one that stands in for it. */
  fetch?: Fetch;
  /** The longest one request attempt waits, in milliseconds; `Infinity` for no limit. 30
   *  seconds by default. */
  timeout?: number;
  maxRetries?: number;
  /** Headers sent with every request to the API, never to a signed storage URL. */
  defaultHeaders?: Record<string, string>;
  /** Headers computed for each request to the API, never to a signed storage URL. */
  headerProvider?: HeaderProvider;
  onWarning?: WarningHandler;
  /** The clock and sleep the retry waits use. */
  now?: () => number;
  sleep?: Sleep;
  env?: EnvReader;
  readCredentialsFile?: CredentialsFileReader;
  /** Observes each long build as its polling starts; the contract replay reads its record. */
  onLongBuild?: (build: LongBuild) => void;
};

/** A request target: a `path` under the base URL, or a `url` the server returned, which
 *  resolves against the base URL's origin when root-relative. */
export type Target = { path: string; url?: never } | { url: string; path?: never };

export type CallOptions = {
  signal?: AbortSignal;
  /** The longest one attempt waits, in milliseconds, within `deadline`; `Infinity` reads until
   *  the deadline. The transport's `timeout` by default. */
  timeout?: number;
  /** The clock reading the whole call, retries and waits included, must finish by; none by
   *  default. A passed deadline raises `DfoTimeoutError` with `deadline_exceeded`. */
  deadline?: number;
  maxRetries?: number;
};

export type RequestOptions = Target &
  CallOptions & {
    method?: string;
    query?: Record<string, string | number | boolean | undefined>;
    json?: unknown;
    headers?: Record<string, string>;
  };

export type JsonResponse = {
  status: number;
  headers: Headers;
  url: URL;
  /** The parsed JSON body. */
  body: unknown;
};

/** Where a files route sends a download: the bytes it served, or the signed URL it names. */
export type Located = { data: Uint8Array; signed?: never } | { signed: URL; data?: never };

/** A response with its whole body, read under the attempt's limit. */
type Received = { response: Response; body: Uint8Array };

/** How long one attempt may run, and whether the call's deadline or the attempt's own timeout
 *  sets that. */
type Limit = { ms: number; byDeadline: boolean };

const defaultSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(
      () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      Math.min(ms, MAX_TIMER_MS),
    );
    signal?.addEventListener("abort", onAbort, { once: true });
  });

function resolveBaseUrl(baseUrl: string): URL {
  const page = (globalThis as { location?: { href?: string } }).location?.href;
  try {
    return new URL(baseUrl, page);
  } catch (error) {
    throw new TypeError(`The base URL ${baseUrl} is not absolute and no page URL resolves it.`, {
      cause: error,
    });
  }
}

/** A response from a route the client does not wrap: a 2xx, or a redirect it did not follow. */
export class RawResponse {
  readonly status: number;
  readonly headers: Headers;
  /** The body's bytes. */
  readonly body: Uint8Array;

  constructor(status: number, headers: Headers, body: Uint8Array) {
    this.status = status;
    this.headers = headers;
    this.body = body;
  }

  /** The body decoded as UTF-8. */
  text(): string {
    return new TextDecoder().decode(this.body);
  }

  /**
   * The body decoded as JSON.
   *
   * @throws {SyntaxError} The body is not JSON.
   */
  json(): unknown {
    return JSON.parse(this.text());
  }
}

/** Milliseconds a `Retry-After` header asks for, or undefined when it is absent or unreadable. */
export function retryAfterMs(headers: Headers, now: number = Date.now()): number | undefined {
  const value = headers.get("retry-after")?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The timeouts raised because a call's deadline passed, which another attempt cannot clear.
 *  Their code, `deadline_exceeded`, is retryable for the caller, who may call again with a later
 *  deadline. */
const DEADLINE_PASSED = new WeakSet<DfoError>();

/** Whether an error is a timeout raised because the call's deadline passed, as opposed to one
 *  attempt running past its own timeout. */
export const passedDeadline = (error: DfoError): boolean => DEADLINE_PASSED.has(error);

/** Whether a refusal is retried: as a problem document's `retryable` says, or the website
 *  proxy's `retry`, and otherwise by its status. */
export function isRetryable(status: number, body: unknown): boolean {
  if (isRecord(body)) {
    if (!("code" in body) && "error" in body) return body["retry"] === PROXY_RETRY;
    if (typeof body["retryable"] === "boolean") return body["retryable"];
  }
  return isRetryableStatus(status);
}

/** A refusal body as a problem document: parsed when its media type is JSON, else undefined. */
function problemBody(headers: Headers, body: Uint8Array): unknown {
  const type = headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type === undefined || !PROBLEM_TYPES.has(type)) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
}

/**
 * The HTTP transport every client call goes through. It resolves URLs, sends the key to the API
 * host only, retries what the server says is retryable, bounds each attempt by its timeout and
 * the whole call by its deadline, turns refusals into errors and fetches signed storage URLs
 * bare.
 */
export class Transport {
  readonly baseUrl: URL;
  readonly timeout: number;
  readonly maxRetries: number;
  readonly #options: TransportOptions;
  readonly #fetch: Fetch;
  readonly #now: () => number;
  readonly #sleep: Sleep;
  readonly #onWarning: WarningHandler;
  /** The resolved key, shared with every copy `withOptions` makes. */
  #key: { promise?: Promise<ResolvedKey> } = {};

  constructor(options: TransportOptions = {}) {
    this.#options = options;
    this.baseUrl = resolveBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#now = options.now ?? (() => performance.now());
    this.#sleep = options.sleep ?? defaultSleep;
    this.#onWarning = options.onWarning ?? emitWarning;
    // A key given as a value is refused at once; any other key when it resolves.
    if (typeof options.apiKey === "string" || options.apiKey instanceof ApiKey) {
      refuseSecretKeyInBrowser(options.apiKey, options.dangerouslyAllowBrowser ?? false);
    }
  }

  /** The transport's clock, in milliseconds. */
  now(): number {
    return this.#now();
  }

  /** The clock reading `ms` from now; `Infinity` for no deadline. */
  deadlineAfter(ms: number): number {
    return this.#now() + ms;
  }

  /** Waits `ms` on the transport's sleep, rejecting with the caller's reason on abort. */
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return this.#sleep(ms, signal);
  }

  /** Passes a long build whose polling starts to the `onLongBuild` observer. */
  longBuildStarted(build: LongBuild): void {
    this.#options.onLongBuild?.(build);
  }

  /** Passes a warning to the caller's warning handler. */
  warn(warning: DfoWarning): void {
    this.#onWarning(warning);
  }

  /** A copy with other limits that shares this transport's fetch, headers, warning handler and
   *  resolved key. */
  withOptions(options: Pick<TransportOptions, "timeout" | "maxRetries">): Transport {
    const copy = new Transport({
      ...this.#options,
      timeout: options.timeout ?? this.timeout,
      maxRetries: options.maxRetries ?? this.maxRetries,
    });
    copy.#key = this.#key;
    return copy;
  }

  /** The key this transport sends, resolved on first use. */
  apiKey(): Promise<ResolvedKey> {
    this.#key.promise ??= this.#resolveKey();
    return this.#key.promise;
  }

  async #resolveKey(): Promise<ResolvedKey> {
    const resolved = await resolveApiKey({
      apiKey: this.#options.apiKey,
      env: this.#options.env,
      readCredentialsFile: this.#options.readCredentialsFile,
    });
    refuseSecretKeyInBrowser(resolved.key, this.#options.dangerouslyAllowBrowser ?? false);
    if (resolved.key !== null) {
      const verdict = checkKeyFormat(resolved.key.reveal());
      if (verdict.verdict === "warn") {
        warnOnce(
          `key:${verdict.reason}:${resolved.key.masked}`,
          clientWarning(
            `key_${verdict.reason}`,
            `The API key ${resolved.key.masked} from ${resolved.source} fails the key format ` +
              `check (${verdict.reason}); it is sent anyway.`,
          ),
          this.#onWarning,
        );
      }
    }
    return resolved;
  }

  /** The absolute URL of a target. */
  url(target: Target, query?: RequestOptions["query"]): URL {
    const url =
      target.path === undefined
        ? new URL(target.url, this.baseUrl.origin)
        : new URL(
            `${this.baseUrl.pathname.replace(/\/$/, "")}/${target.path.replace(/^\//, "")}`,
            this.baseUrl.origin,
          );
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    return url;
  }

  /** Sends a request and parses its JSON body, raising a `DfoError` for a refusal and
   *  `ContractError` `unexpected_response` for a response with no JSON body. A redirect is never
   *  followed, so no client header reaches another host. */
  async request(options: RequestOptions): Promise<JsonResponse> {
    const { response, body } = await this.#send(options);
    if (this.#isRedirect(response)) {
      throw clientError("unexpected_response", {
        status: response.status,
        detail: `${this.url(options).pathname} answered with a redirect, which this call does not follow.`,
        traceId: response.headers.get("x-dfo-trace-id"),
      });
    }
    const text = new TextDecoder().decode(body);
    const url = new URL(response.url || this.url(options, options.query));
    try {
      return { status: response.status, headers: response.headers, url, body: JSON.parse(text) };
    } catch (error) {
      throw clientError("unexpected_response", {
        status: response.status,
        detail: `The response from ${url.pathname} has no JSON body.`,
        traceId: response.headers.get("x-dfo-trace-id"),
        cause: error,
      });
    }
  }

  /** Sends a request and reads its body as bytes, raising a `DfoError` for a refusal. A
   *  redirect is returned, not followed. */
  async requestRaw(options: RequestOptions): Promise<RawResponse> {
    const { response, body } = await this.#send(options);
    return new RawResponse(response.status, response.headers, body);
  }

  /**
   * Asks a files route for a file, retrying as every API request does. The route answers the
   * bytes, or a redirect to a signed storage URL, which resolves against the response's URL;
   * `fetchSigned` fetches it. A browser hides a redirect's `Location`, so there the browser
   * follows it and the bytes come back.
   *
   * @throws {ContractError} The route or its redirect names a host other than the API's or the
   *   storage host, or a redirect has no `Location`.
   * @throws {DfoError} The route refused the request.
   */
  async locate(options: Target & CallOptions): Promise<Located> {
    const target = this.url(options);
    this.#checkFileOrigin(target, "The file URL");
    const ask = { ...options, method: "GET" };
    const { response, body } = await this.#send(ask);
    if (response.type === "opaqueredirect") {
      // The browser follows the redirect, dropping the Authorization header on the way to
      // another origin.
      return { data: (await this.#send(ask, "follow")).body };
    }
    if (!REDIRECT_STATUSES.has(response.status)) return { data: body };
    const location = response.headers.get("location");
    if (location === null) {
      throw clientError("contract_violation", {
        status: response.status,
        detail: `The redirect from ${target.pathname} has no Location header.`,
        traceId: response.headers.get("x-dfo-trace-id"),
      });
    }
    const signed = new URL(location, response.url || target);
    this.#checkFileOrigin(signed, `The redirect from ${target.pathname}`);
    return { signed };
  }

  /**
   * Fetches a signed storage URL once, with no client header and no key. A failed fetch is not
   * retried: a signed URL can expire, so the caller asks the files route for a fresh one.
   *
   * @throws {ServerError} The storage host answered other than 2xx (`download_failed`).
   * @throws {NetworkError} The connection failed.
   * @throws {DfoTimeoutError} The attempt or the call's deadline ran out.
   */
  async fetchSigned(url: URL, options: CallOptions = {}): Promise<Uint8Array> {
    options.signal?.throwIfAborted();
    const outcome = await this.#attempt(url, options, { method: "GET" });
    if (outcome instanceof DfoError) throw outcome;
    const { response, body } = outcome;
    if (!response.ok) {
      throw clientError("download_failed", {
        status: response.status,
        detail: `The signed download from ${url.host} answered HTTP ${response.status}.`,
      });
    }
    return body;
  }

  #checkFileOrigin(url: URL, what: string): void {
    if (url.origin === this.baseUrl.origin || url.origin === STORAGE_ORIGIN) return;
    throw clientError("contract_violation", {
      detail: `${what} is on ${url.origin}, which is neither the API's origin nor ${STORAGE_ORIGIN}.`,
    });
  }

  /** Sends one request with retries, returning a 2xx response or a redirect with its body.
   *  Redirects are manual unless a browser has to follow one. */
  async #send(options: RequestOptions, redirect: RequestRedirect = "manual"): Promise<Received> {
    options.signal?.throwIfAborted();
    const method = options.method ?? (options.json === undefined ? "GET" : "POST");
    const url = this.url(options, options.query);
    const retries = options.maxRetries ?? this.maxRetries;
    const deadline = options.deadline ?? Infinity;
    let reauthenticated = false;

    for (let attempt = 0; ; attempt += 1) {
      const { headers, key } = await this.#headers(method, url, options);
      const outcome = await this.#attempt(url, options, {
        method,
        headers,
        redirect,
        ...(options.json === undefined ? {} : { body: JSON.stringify(options.json) }),
      });

      let error: DfoError;
      if (outcome instanceof DfoError) {
        error = outcome;
      } else {
        const { response, body } = outcome;
        this.#warnFromHeaders(response.headers, url);
        if (response.ok || this.#isRedirect(response)) return outcome;
        if (response.status === 401 && !reauthenticated) {
          // The key is resolved again after a 401, and a different key gets one more try.
          reauthenticated = true;
          this.#key.promise = this.#resolveKey();
          const next = (await this.#key.promise).key?.reveal();
          if (next !== undefined && next !== key) {
            attempt -= 1;
            continue;
          }
        }
        error = this.#refusal(response, body);
      }

      if (!error.retryable || passedDeadline(error) || attempt >= retries) throw error;
      const wait = error.retryAfterMs ?? this.backoff(attempt);
      if (this.#now() + wait >= deadline) throw error;
      await this.#sleep(wait, options.signal);
    }
  }

  #isRedirect(response: Response): boolean {
    return response.type === "opaqueredirect" || REDIRECT_STATUSES.has(response.status);
  }

  /** The wait before retrying failed attempt `attempt` (from 0) when its refusal carries no
   *  `Retry-After`: 0.5 s, doubling to at most 8 s. */
  backoff(attempt: number): number {
    return Math.min(BACKOFF_START_MS * 2 ** attempt, BACKOFF_CAP_MS);
  }

  async #headers(
    method: string,
    url: URL,
    options: RequestOptions,
  ): Promise<{ headers: Headers; key: string | undefined }> {
    const headers = new Headers();
    if (url.origin !== this.baseUrl.origin) return { headers, key: undefined };
    for (const [name, value] of Object.entries(this.#options.defaultHeaders ?? {})) {
      headers.set(name, value);
    }
    const provided = await this.#options.headerProvider?.({ method, url });
    for (const [name, value] of new Headers(provided)) headers.set(name, value);
    headers.set("accept", "application/json");
    if (options.json !== undefined) headers.set("content-type", "application/json");
    if (!inBrowser()) headers.set("user-agent", `dfo-ts/${VERSION}`);
    for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
    const key = (await this.apiKey()).key?.reveal();
    if (key !== undefined) headers.set("authorization", `Bearer ${key}`);
    return { headers, key };
  }

  /** How long the next attempt may run: its own timeout, or the time left before the deadline
   *  when that is shorter. */
  #limit(url: URL, { timeout, deadline }: CallOptions): Limit {
    const own = timeout ?? this.timeout;
    const remaining = (deadline ?? Infinity) - this.#now();
    if (remaining <= 0) throw this.#deadlinePassed(url);
    return remaining <= own ? { ms: remaining, byDeadline: true } : { ms: own, byDeadline: false };
  }

  /**
   * One fetch and the read of its whole body, under the attempt's limit. An infinite limit arms
   * no timer. A caller's abort rejects with the caller's reason. A failure the next attempt may
   * clear returns as a retryable error: a network failure, or the attempt's own timeout. The
   * deadline passing returns a `DfoTimeoutError` that `passedDeadline` marks, which no retry
   * follows.
   */
  async #attempt(url: URL, options: CallOptions, init: RequestInit): Promise<Received | DfoError> {
    const limit = this.#limit(url, options);
    const timer = Number.isFinite(limit.ms)
      ? AbortSignal.timeout(Math.min(Math.max(1, Math.ceil(limit.ms)), MAX_TIMER_MS))
      : undefined;
    const signals = [options.signal, timer].filter((signal) => signal !== undefined);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    try {
      const response = await this.#fetch(url, { ...init, ...(signal ? { signal } : {}) });
      return { response, body: new Uint8Array(await response.arrayBuffer()) };
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (timer?.aborted) {
        if (limit.byDeadline) return this.#deadlinePassed(url, error);
        return clientError("deadline_exceeded", {
          detail: `One attempt at ${url.pathname} waited ${limit.ms} ms with no whole response.`,
          cause: error,
        });
      }
      return clientError("network_error", {
        detail: `The request to ${url.host} failed before its whole response arrived.`,
        cause: error,
      });
    }
  }

  #deadlinePassed(url: URL, cause?: unknown): DfoTimeoutError {
    const error = clientError("deadline_exceeded", {
      detail: `The call to ${url.pathname} passed its deadline.`,
      cause,
    });
    DEADLINE_PASSED.add(error);
    return error;
  }

  /** The error a refusal stands for: a problem document, the proxy's own body, or neither. */
  #refusal(response: Response, received: Uint8Array): DfoError {
    const body = problemBody(response.headers, received);
    const { status } = response;
    const headerTrace = response.headers.get("x-dfo-trace-id");
    const retryable = isRetryable(status, body);
    const retryAfter = retryAfterMs(response.headers) ?? null;

    if (isRecord(body) && typeof body["code"] === "string") {
      const code = body["code"];
      const ErrorClass = errorClassFor(code, status);
      return new ErrorClass({
        code: serverCode(code),
        status,
        detail: typeof body["detail"] === "string" ? body["detail"] : code,
        traceId: typeof body["trace_id"] === "string" ? body["trace_id"] : headerTrace,
        retryable,
        retryAfterMs: retryAfter,
        problem: body,
        docsUrl: this.#docsUrl(body["type"]),
      });
    }
    if (isRecord(body) && typeof body["error"] === "string") {
      // The website proxy's own refusal: {error, retry, detail}.
      const code = body["error"];
      const ErrorClass = errorClassFor(code, status);
      return new ErrorClass({
        code: serverCode(code),
        status,
        detail: typeof body["detail"] === "string" ? body["detail"] : code,
        traceId: headerTrace,
        retryable,
        retryAfterMs: retryAfter,
        problem: body,
      });
    }
    return clientError("refusal_without_code", {
      status,
      detail: `HTTP ${status} with no problem document.`,
      traceId: headerTrace,
      retryAfterMs: retryAfter,
    });
  }

  #docsUrl(type: unknown): string | null {
    if (typeof type !== "string" || type === "" || type === "about:blank") return null;
    try {
      return new URL(type, this.baseUrl.origin).href;
    } catch {
      return null;
    }
  }

  /** Warns once per process for each distinct pair of `Deprecation` and `Sunset` values, on
   *  either header alone, and once per `x-dfo-warning` message. */
  #warnFromHeaders(headers: Headers, url: URL): void {
    const deprecation = headers.get("deprecation");
    const sunset = headers.get("sunset");
    if (deprecation !== null || sunset !== null) {
      const marks = [
        ...(deprecation === null ? [] : [`Deprecation: ${deprecation}`]),
        ...(sunset === null ? [] : [`Sunset: ${sunset}`]),
      ].join(", ");
      warnOnce(
        `deprecation:${JSON.stringify([deprecation, sunset])}`,
        clientWarning(
          "route_deprecated",
          `The DFO API marked ${url.pathname} for removal (${marks}). Upgrade ` +
            "@developmentfinance/client.",
        ),
        this.#onWarning,
      );
    }
    const warning = headers.get("x-dfo-warning");
    if (warning !== null) {
      warnOnce(
        `x-dfo-warning:${warning}`,
        clientWarning("server_warning", warning),
        this.#onWarning,
      );
    }
  }
}
