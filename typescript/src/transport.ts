import type { CredentialsFileReader } from "./credentials.ts";
import type { EnvReader } from "./env.ts";
import { clientError, DfoError, errorClassFor, NetworkError, serverCode } from "./errors.ts";
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
import { DfoDeprecationWarning, DfoWarning, emitWarning, warnOnce } from "./warnings.ts";
import type { WarningHandler } from "./warnings.ts";

/** The public API's base URL. */
export const DEFAULT_BASE_URL = "https://developmentfinance.org/api/v1";
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RETRIES = 2;

const BACKOFF_START_MS = 500;
const BACKOFF_CAP_MS = 8_000;
/** Statuses retried when the body does not say whether the refusal is retryable. */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
/** The website proxy's `retry` value for a refusal that clears on its own. */
const PROXY_RETRY = "retry_after_delay";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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
  /** The deadline for one call, retries and waits included, in milliseconds. */
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
  /** This call's deadline in milliseconds from now, capped by `deadline`. */
  timeout?: number;
  /** An absolute deadline on the transport's clock, carried down from an enclosing call. */
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
  /** The parsed body, or null for an empty one. */
  body: unknown;
};

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
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
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

/** Whether a refusal is retried: as a problem document's `retryable` says, or the website
 *  proxy's `retry`, and otherwise by its status. */
export function isRetryable(status: number, body: unknown): boolean {
  if (isRecord(body)) {
    if (!("code" in body) && "error" in body) return body["retry"] === PROXY_RETRY;
    if (typeof body["retryable"] === "boolean") return body["retryable"];
  }
  return RETRYABLE_STATUSES.has(status);
}

/**
 * The HTTP transport every client call goes through. It resolves URLs, sends the key to the API
 * host only, retries what the server says is retryable within one deadline, turns refusals into
 * errors and fetches signed storage URLs bare.
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
          new DfoWarning(
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

  /** The absolute deadline for a call on this transport's clock. */
  deadline({ timeout, deadline }: Pick<CallOptions, "timeout" | "deadline"> = {}): number {
    const own = this.#now() + (timeout ?? this.timeout);
    return deadline === undefined ? own : Math.min(own, deadline);
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

  /** Sends a request and parses its JSON body, raising a `DfoError` for a refusal. A redirect
   *  is never followed, so no client header reaches another host. */
  async request(options: RequestOptions): Promise<JsonResponse> {
    const response = await this.#send(options, this.deadline(options));
    if (this.#isRedirect(response)) {
      throw clientError("unexpected_response", {
        status: response.status,
        detail: `${this.url(options).pathname} answered with a redirect, which this call does not follow.`,
        traceId: response.headers.get("x-dfo-trace-id"),
      });
    }
    const text = await this.#read(response, options.signal, () => response.text());
    const url = new URL(response.url || this.url(options, options.query));
    if (text === "") return { status: response.status, headers: response.headers, url, body: null };
    try {
      return { status: response.status, headers: response.headers, url, body: JSON.parse(text) };
    } catch (error) {
      throw clientError("unexpected_response", {
        status: response.status,
        detail: `The response from ${url.pathname} is not JSON.`,
        traceId: response.headers.get("x-dfo-trace-id"),
        cause: error,
      });
    }
  }

  /** Sends a request and reads its body as bytes, raising a `DfoError` for a refusal. A
   *  redirect is returned, not followed. */
  async requestRaw(options: RequestOptions): Promise<RawResponse> {
    const response = await this.#send(options, this.deadline(options));
    const body = await this.#bytes(response, options.signal);
    return new RawResponse(response.status, response.headers, body);
  }

  /**
   * Downloads a file the API serves through a redirect to a signed storage URL. The redirect is
   * read by hand and the signed URL fetched with no client headers and no key. A failed signed
   * fetch asks the API again for a fresh URL rather than retrying the old one.
   */
  async download(options: Target & CallOptions): Promise<Uint8Array> {
    const deadline = this.deadline(options);
    const retries = options.maxRetries ?? this.maxRetries;
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.#send({ ...options, method: "GET" }, deadline);
      if (response.type === "opaqueredirect") {
        // A browser hides a manual redirect's Location, so the browser follows it, dropping
        // the Authorization header on the way to another origin.
        const followed = await this.#send({ ...options, method: "GET" }, deadline, "follow");
        return this.#bytes(followed, options.signal);
      }
      if (!REDIRECT_STATUSES.has(response.status)) return this.#bytes(response, options.signal);

      const location = response.headers.get("location");
      if (location === null) {
        throw clientError("contract_violation", {
          status: response.status,
          detail: `The redirect from ${this.url(options).pathname} has no Location header.`,
        });
      }
      const signed = new URL(location, this.url(options));
      try {
        return await this.#bare(signed, deadline, options.signal);
      } catch (error) {
        if (!(error instanceof DfoError) || !error.retryable || attempt >= retries) throw error;
        await this.#wait(this.#backoff(attempt), deadline, options.signal, error);
      }
    }
  }

  /** Sends one request with retries, returning a 2xx response or a redirect with its body
   *  unread. Redirects are manual unless a browser has to follow one. */
  async #send(
    options: RequestOptions,
    deadline: number,
    redirect: RequestRedirect = "manual",
  ): Promise<Response> {
    options.signal?.throwIfAborted();
    const method = options.method ?? (options.json === undefined ? "GET" : "POST");
    const url = this.url(options, options.query);
    const retries = options.maxRetries ?? this.maxRetries;
    let reauthenticated = false;

    for (let attempt = 0; ; attempt += 1) {
      const { headers, key } = await this.#headers(method, url, options);
      let outcome: Response | NetworkError;
      try {
        outcome = await this.#fetchOnce(url, deadline, options.signal, {
          method,
          headers,
          redirect,
          ...(options.json === undefined ? {} : { body: JSON.stringify(options.json) }),
        });
      } catch (failure) {
        if (!(failure instanceof NetworkError)) throw failure;
        outcome = failure;
      }

      let error: DfoError;
      if (outcome instanceof NetworkError) {
        error = outcome;
      } else {
        this.#warnFromHeaders(outcome.headers, url);
        if (outcome.ok || this.#isRedirect(outcome)) return outcome;
        if (outcome.status === 401 && !reauthenticated) {
          // The key is resolved again after a 401, and a different key gets one more try.
          reauthenticated = true;
          this.#key.promise = this.#resolveKey();
          const next = (await this.#key.promise).key?.reveal();
          if (next !== undefined && next !== key) {
            attempt -= 1;
            continue;
          }
        }
        error = await this.#refusal(outcome, options.signal);
      }

      if (!error.retryable || attempt >= retries) throw error;
      await this.#wait(
        error.retryAfterMs ?? this.#backoff(attempt),
        deadline,
        options.signal,
        error,
      );
    }
  }

  #isRedirect(response: Response): boolean {
    return response.type === "opaqueredirect" || REDIRECT_STATUSES.has(response.status);
  }

  #backoff(attempt: number): number {
    return Math.min(BACKOFF_START_MS * 2 ** attempt, BACKOFF_CAP_MS);
  }

  /** Waits before a retry, or raises `error` when the wait would pass the deadline. */
  async #wait(ms: number, deadline: number, signal: AbortSignal | undefined, error: unknown) {
    if (this.#now() + ms >= deadline) throw error;
    await this.#sleep(ms, signal);
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

  /** One fetch under the deadline. A caller's abort rejects with the caller's reason; the
   *  deadline raises `DfoTimeoutError`; any other failure raises `NetworkError`. */
  async #fetchOnce(
    url: URL,
    deadline: number,
    signal: AbortSignal | undefined,
    init: RequestInit,
  ): Promise<Response> {
    const remaining = deadline - this.#now();
    if (remaining <= 0) throw this.#timeout(url);
    const timer = AbortSignal.timeout(Math.ceil(remaining));
    try {
      return await this.#fetch(url, {
        ...init,
        signal: signal === undefined ? timer : AbortSignal.any([signal, timer]),
      });
    } catch (error) {
      throw this.#failure(error, url, signal, timer);
    }
  }

  #failure(error: unknown, url: URL, signal: AbortSignal | undefined, timer?: AbortSignal) {
    if (signal?.aborted) return signal.reason as unknown;
    if (timer?.aborted) return this.#timeout(url, error);
    return clientError("network_error", {
      detail: `The request to ${url.host} failed before a response arrived.`,
      retryable: true,
      cause: error,
    });
  }

  #timeout(url: URL, cause?: unknown): DfoTimeoutError {
    return clientError("deadline_exceeded", {
      detail: `The call to ${url.pathname} passed its deadline.`,
      cause,
    });
  }

  /** Reads a body, mapping a failure part way through as `#fetchOnce` does. */
  async #read<T>(response: Response, signal: AbortSignal | undefined, read: () => Promise<T>) {
    try {
      return await read();
    } catch (error) {
      throw this.#failure(error, new URL(response.url || this.baseUrl), signal);
    }
  }

  async #bytes(response: Response, signal: AbortSignal | undefined): Promise<Uint8Array> {
    return new Uint8Array(await this.#read(response, signal, () => response.arrayBuffer()));
  }

  /** Fetches a signed storage URL with no headers at all. */
  async #bare(url: URL, deadline: number, signal: AbortSignal | undefined): Promise<Uint8Array> {
    const response = await this.#fetchOnce(url, deadline, signal, { method: "GET" });
    if (!response.ok) {
      throw clientError("download_failed", {
        status: response.status,
        detail: `The signed download from ${url.host} answered HTTP ${response.status}.`,
        retryable: true,
      });
    }
    return this.#bytes(response, signal);
  }

  /** The error a refusal stands for: a problem document, the proxy's own body, or neither. */
  async #refusal(response: Response, signal: AbortSignal | undefined): Promise<DfoError> {
    const text = await this.#read(response, signal, () => response.text());
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
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
      retryable,
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

  #warnFromHeaders(headers: Headers, url: URL): void {
    const deprecation = headers.get("deprecation");
    if (deprecation !== null) {
      const sunset = headers.get("sunset");
      warnOnce(
        `deprecation:${url.pathname}`,
        new DfoDeprecationWarning(
          "route_deprecated",
          `The API marks ${url.pathname} deprecated (Deprecation: ${deprecation})` +
            (sunset === null ? "." : `; it is removed after ${sunset}.`),
        ),
        this.#onWarning,
      );
    }
    const warning = headers.get("x-dfo-warning");
    if (warning !== null) {
      warnOnce(
        `x-dfo-warning:${warning}`,
        new DfoWarning("server_warning", warning),
        this.#onWarning,
      );
    }
  }
}
