import type { CredentialsFileReader } from "../config/credentials.ts";
import type { EnvReader } from "../config/env.ts";
import {
  clientError,
  DfoError,
  errorClassFor,
  InvalidRequestError,
  isRetryableStatus,
  REFUSAL_CODE,
  refusalMessage,
  serverCode,
} from "../core/errors.ts";
import type { DfoTimeoutError } from "../core/errors.ts";
import {
  checkKeyFormat,
  inBrowser,
  lookUpApiKey,
  refuseSecretKeyInBrowser,
} from "../config/keys.ts";
import type { ApiKeyOption, ResolvedKey } from "../config/keys.ts";
import type { LongBuild } from "../datasets/operation.ts";
import { traceIdOf } from "../core/trace.ts";
import { VERSION } from "../version.ts";
import { clientWarning, emitWarning, warnOnce } from "../core/warnings.ts";
import type { DfoWarning, WarningHandler } from "../core/warnings.ts";
import { isRecord, parseJson } from "../core/json.ts";
import { controlFault, hasDotSegment, headerFault, keyFault } from "../core/text.ts";

/** The public API's base URL. */
const DEFAULT_BASE_URL = "https://developmentfinance.org/api/v1";
/** The longest one request attempt waits, in milliseconds, unless a call sets its own. */
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
/** The storage host the API's files route redirects a download to. */
const STORAGE_ORIGIN = "https://storage.googleapis.com";

const BACKOFF_START_MS = 500;
const BACKOFF_CAP_MS = 8_000;
/** The longest `Retry-After` a refusal is waited for, in seconds. A longer one, or one past the
 *  call's deadline, raises the refusal at once with its `retryAfterMs` set. */
export const RETRY_AFTER_MAX_S = 60;
/** The bounds a long build's poll interval from the server is clamped to, in seconds. */
export const POLL_INTERVAL_MIN_S = 1;
export const POLL_INTERVAL_MAX_S = 60;
/** The decoded bytes a downloaded file may hold when its manifest gives no size. */
export const DEFAULT_MAX_BYTES = 2 * 2 ** 30;
/** The decoded bytes an API response's body may hold, 16 MiB. The largest JSON body recorded
 *  is the `/search/schema` body in python/tests/data/search-schema.json, 267,493 bytes, and the
 *  largest response under contract/scenarios is 137,679 bytes as compact JSON, so the limit
 *  leaves over 60 times the largest as headroom while bounding what a faulty server can make
 *  the client hold. The Python client uses the same value. */
export const JSON_BODY_MAX_BYTES = 16 * 2 ** 20;
/** The most retries a client takes. */
const RETRIES_MAX = 10;
/** The methods a request may use. */
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
/** A `Retry-After` value: ASCII digits, a count of seconds, or an IMF-fixdate. */
const RETRY_SECONDS = /^[0-9]+$/;
const IMF_FIXDATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/;
/** The longest delay a platform timer holds, about 24.8 days; a longer limit is clamped to it. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** A timer's delay for `ms`: whole milliseconds, at least 1 and at most `MAX_TIMER_MS`. */
const timerMs = (ms: number): number => Math.min(Math.max(1, Math.ceil(ms)), MAX_TIMER_MS);
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
  /** The API's base URL. A relative one, such as `/api/v1`, resolves against the page. */
  baseUrl?: string;
  apiKey?: ApiKeyOption;
  /** Sends a secret key from a browser page or worker, where every visitor can read it. */
  dangerouslyAllowBrowser?: boolean;
  /** The platform's `fetch`, or one that stands in for it. */
  fetch?: Fetch;
  /** The longest one request attempt waits, in milliseconds, a finite number above 0. 30
   *  seconds by default. */
  timeout?: number;
  /** Further attempts after a failure the server says can clear, an integer from 0 to 10. */
  maxRetries?: number;
  /** Headers sent with every request to the API. A signed storage URL gets none. */
  defaultHeaders?: Record<string, string>;
  /** Headers computed for each request to the API. A signed storage URL gets none. An error it
   *  raises reaches the caller as `header_invalid`, with that error as the `cause`. */
  headerProvider?: HeaderProvider;
  onWarning?: WarningHandler;
  /** The clock and sleep the retry waits use. */
  now?: () => number;
  sleep?: Sleep;
  env?: EnvReader;
  readCredentialsFile?: CredentialsFileReader;
  /** Observes each long build as its polling starts. The contract replay reads its record. */
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
  /** The most decoded bytes a 2xx response's body may hold; `JSON_BODY_MAX_BYTES` by default,
   *  and `DEFAULT_MAX_BYTES` for a signed fetch. A redirect or a refusal is read under
   *  `JSON_BODY_MAX_BYTES` whatever this says, so a refusal reads as on any other route. */
  maxBytes?: number;
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
  /** The response's trace id: the body's `trace_id`, else the `x-dfo-trace-id` header. */
  traceId: string | null;
};

/** Where a files route sends a download: the bytes it served, or the URL `fetchSigned` fetches
 *  them from. That URL is the signed URL the route's redirect names, or, with `follow`, the
 *  route itself, whose redirect a browser hid and follows on the fetch. */
export type Located =
  | { data: Uint8Array; signed?: never; follow?: never }
  | { signed: URL; follow: boolean; data?: never };

export type SignedFetchOptions = CallOptions & {
  /** Fetches the files route and lets the browser follow its redirect, carrying the key alone. */
  follow?: boolean;
};

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

/** An IPv4 address written as four decimal octets with no leading zeros. */
const DOTTED_QUAD =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/** A host lower-cased, with one trailing dot stripped. */
const bareHost = (host: string): string => host.toLowerCase().replace(/\.$/, "");

/** The loopback hosts a key may reach over plain http: `localhost` and its subdomains, a
 *  dotted-quad address in 127.0.0.0/8 and the IPv6 loopback address. */
function isLoopback(hostname: string): boolean {
  const host = bareHost(hostname);
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    (DOTTED_QUAD.test(host) && host.startsWith("127.")) ||
    host === "[::1]"
  );
}

/**
 * The base URL as an absolute http or https URL. A relative one resolves against the page. The
 * errors leave the URL out, since it may carry a password.
 *
 * @throws {InvalidRequestError} The base URL is empty, holds a character outside visible ASCII,
 *   does not resolve to an absolute http or https URL, carries userinfo, a query, a fragment
 *   or a dot segment, or writes an IPv4 host other than as four decimal octets
 *   (`base_url_invalid`).
 */
function resolveBaseUrl(baseUrl: string): URL {
  const refuse = (problem: string, cause?: unknown) =>
    clientError("base_url_invalid", {
      detail: `The base URL ${problem}. Pass an absolute https URL, such as ${DEFAULT_BASE_URL}.`,
      cause,
    });
  if (baseUrl.trim() === "") throw refuse("is empty; leave baseUrl out for the public API");
  const fault = keyFault(baseUrl);
  if (fault !== null) throw refuse(`holds ${fault}`);
  if (/[?#]/.test(baseUrl)) throw refuse("carries a query or a fragment");
  const page = (globalThis as { location?: { href?: string } }).location?.href;
  let url: URL;
  try {
    url = new URL(baseUrl, page);
  } catch (error) {
    throw refuse(
      page === undefined
        ? "is not an absolute URL, and no page URL resolves a relative one"
        : "is not a URL",
      error,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw refuse(`has the scheme ${url.protocol}, not https or http`);
  }
  if (url.username !== "" || url.password !== "") {
    throw refuse("carries userinfo; pass the key as apiKey");
  }
  // URL rewrites any IPv4 form, such as 127.1, 0x7f.1 or 2130706433, as a dotted quad, so the
  // host as written is read from the string.
  const written = /^[a-z][a-z0-9+.-]*:[/\\]*([^/\\]*)/i.exec(baseUrl)?.[1];
  if (
    written !== undefined &&
    DOTTED_QUAD.test(url.hostname) &&
    bareHost(written.replace(/:[^:]*$/, "")) !== url.hostname
  ) {
    throw refuse("writes an IPv4 host in a form other than four decimal octets");
  }
  if (hasDotSegment(baseUrl.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, ""))) {
    throw refuse("holds a . or .. path segment");
  }
  return url;
}

/** The value of each header `init` gives, as name and value pairs, in order. Any iterable of
 *  pairs reads as one, by its shape, since a `Headers` from another realm or package, such as
 *  npm undici's, is no instance of this realm's class. */
const headerPairs = (init: HeadersInit): Iterable<[string, unknown]> =>
  typeof (init as Partial<Iterable<unknown>>)[Symbol.iterator] === "function"
    ? (init as Iterable<[string, string]>)
    : Object.entries(init);

/**
 * Sets each header after checking its value is a string of visible ASCII, spaces and tabs. The
 * error names the header, its source and the character's position, and leaves the value out,
 * since it may be a token.
 *
 * @throws {InvalidRequestError} A value is not a string or holds another character, or a name is
 *   one HTTP cannot carry (`header_invalid`).
 */
function setHeaders(headers: Headers, pairs: Iterable<[string, unknown]>, source: string): void {
  for (const [name, value] of pairs) {
    const fault = typeof value === "string" ? headerFault(value) : "a value that is not a string";
    if (fault !== null || typeof value !== "string") {
      throw clientError("header_invalid", {
        detail:
          `The ${name} header from ${source} holds ${fault}; a header value holds visible ASCII, ` +
          "spaces and tabs only. Strip the line break a command's output ends with.",
      });
    }
    try {
      headers.set(name, value);
    } catch {
      // The platform's error quotes the value, so it is left out.
      throw clientError("header_invalid", {
        detail:
          `The header ${JSON.stringify(name)} from ${source} has a name or a value with a ` +
          "character HTTP cannot carry.",
      });
    }
  }
}

/** Decodes a body as UTF-8. */
const UTF8 = new TextDecoder();

/** What the client's key reads as in server text it surfaces. */
const REDACTED = "[redacted]";

/** Server text with the key sent, if any, replaced by `[redacted]`. */
const redactedText = (text: string, key: string | undefined): string =>
  key === undefined ? text : text.replaceAll(key, REDACTED);

/** Every string in a parsed body with the key sent, if any, replaced by `[redacted]`. */
function redacted(value: unknown, key: string | undefined): unknown {
  if (key === undefined) return value;
  if (typeof value === "string") return redactedText(value, key);
  if (Array.isArray(value)) return value.map((item) => redacted(item, key));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => [name, redacted(item, key)]),
  );
}

/** Why a fetch failed, from the platform's error: its cause's code, such as `ECONNREFUSED`,
 *  else its message. */
function failureReason(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  const code = isRecord(cause) ? cause["code"] : undefined;
  if (typeof code === "string") return code;
  if (cause instanceof Error) return cause.message;
  return error instanceof Error ? error.message : String(error);
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
    return UTF8.decode(this.body);
  }

  /**
   * The body decoded as JSON.
   *
   * @throws {SyntaxError} The body is not JSON, or nests arrays and objects deeper than 256 levels.
   */
  json(): unknown {
    return parseJson(this.text());
  }
}

/** Milliseconds a `Retry-After` header asks for: ASCII digits, a count of seconds, or an
 *  IMF-fixdate such as `Sun, 06 Nov 1994 08:49:37 GMT`, of which a past date asks for 0. Any
 *  other value, or none, gives undefined, and the caller backs off on its own. */
export function retryAfterMs(headers: Headers, now: number = Date.now()): number | undefined {
  const value = headers.get("retry-after")?.trim() ?? "";
  if (RETRY_SECONDS.test(value)) return Number(value) * 1000;
  if (!IMF_FIXDATE.test(value)) return undefined;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** A number as text, else a name for the value's type, which keeps a string's text out of an
 *  error message. */
const described = (value: unknown): string =>
  typeof value === "number"
    ? String(value)
    : value === null
      ? "null"
      : typeof value === "object"
        ? "an object"
        : `a ${typeof value}`;

/**
 * A timeout in milliseconds once it is a number above 0: finite, or with `infinite`, `Infinity`
 * for no limit.
 *
 * @throws {InvalidRequestError} It is not (`invalid_argument`).
 */
function checkedTimeout(value: unknown, name: string, infinite: boolean): number {
  if (
    typeof value !== "number" ||
    Number.isNaN(value) ||
    value <= 0 ||
    (!infinite && !Number.isFinite(value))
  ) {
    throw clientError("invalid_argument", {
      detail:
        `${name} is a ${infinite ? "" : "finite "}number of milliseconds above 0` +
        `${infinite ? ", or Infinity" : ""}, not ${described(value)}.`,
    });
  }
  return value;
}

/**
 * A retry count once it is an integer from 0 to 10.
 *
 * @throws {InvalidRequestError} It is not (`invalid_argument`).
 */
function checkedRetries(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > RETRIES_MAX) {
    throw clientError("invalid_argument", {
      detail: `maxRetries is an integer from 0 to ${RETRIES_MAX}, not ${described(value)}.`,
    });
  }
  return value as number;
}

/**
 * A request's JSON body as text, as `JSON.stringify` writes it.
 *
 * @throws {InvalidRequestError} The method is GET or HEAD, which carries no body, or the value
 *   is not JSON: a BigInt, a cycle, NaN or an infinity (`invalid_argument`).
 */
function jsonText(json: unknown, method: string): string {
  if (method === "GET" || method === "HEAD") {
    throw clientError("invalid_argument", {
      detail: `A ${method} request carries no body; drop json.`,
    });
  }
  try {
    return JSON.stringify(json, (_name, value: unknown) => {
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new TypeError(`${String(value)} is not a JSON number`);
      }
      return value;
    });
  } catch (error) {
    throw clientError("invalid_argument", {
      detail: `The request's json is not JSON (${error instanceof Error ? error.message : "unreadable"}).`,
      cause: error,
    });
  }
}

/** Whether a custom `fetch` returned something `Transport` can read as a `Response`: a numeric
 *  status, headers with `get`, and a body stream or `arrayBuffer`. It checks the shape, since a
 *  `fetch` from another package or realm, such as npm undici's, brings its own `Response` and
 *  `Headers` classes. */
function isResponse(value: unknown): value is Response {
  if (!isRecord(value) || typeof value["status"] !== "number") return false;
  const { headers, body } = value;
  return (
    isRecord(headers) &&
    typeof headers["get"] === "function" &&
    ((isRecord(body) && typeof body["getReader"] === "function") ||
      typeof value["arrayBuffer"] === "function")
  );
}

/** Whether a response is a redirect, a browser's opaque one included. */
const isRedirect = (response: Response): boolean =>
  response.type === "opaqueredirect" || REDIRECT_STATUSES.has(response.status);

/**
 * A response's body, its decoded bytes counted as they stream. Once they pass `limit` the reader
 * is cancelled and nothing more is pulled.
 *
 * @returns The body, or null once it passed `limit`.
 */
async function readWithin(response: Response, limit: number): Promise<Uint8Array | null> {
  const stream = response.body;
  if (!isRecord(stream)) {
    // A Response with no body, or a stand-in that reads its body whole.
    const whole = new Uint8Array(await response.arrayBuffer());
    return whole.byteLength > limit ? null : whole;
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  if (chunks.length === 1) return chunks[0]!;
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** The timeouts raised because a call's deadline passed, which another attempt cannot clear.
 *  Their code, `deadline_exceeded`, is retryable for the caller, who may call again with a later
 *  deadline. */
const DEADLINE_PASSED = new WeakSet<DfoError>();

/** Whether an error is a timeout raised because the call's deadline passed, as opposed to one
 *  attempt running past its own timeout. */
export const passedDeadline = (error: DfoError): boolean => DEADLINE_PASSED.has(error);

/** Whether a refusal is retried: as a problem document's `retryable` says, or the website
 *  proxy's `retry` when its body carries one, and otherwise by its status. */
export function isRetryable(status: number, body: unknown): boolean {
  if (isRecord(body)) {
    if (!("code" in body) && "error" in body && typeof body["retry"] === "string") {
      return body["retry"] === PROXY_RETRY;
    }
    if (typeof body["retryable"] === "boolean") return body["retryable"];
  }
  return isRetryableStatus(status);
}

/** A refusal body as a problem document: parsed when its media type is JSON, else undefined. */
function problemBody(headers: Headers, body: Uint8Array): unknown {
  const type = headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type === undefined || !PROBLEM_TYPES.has(type)) return undefined;
  try {
    return parseJson(UTF8.decode(body));
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
  readonly #key: { promise: Promise<ResolvedKey> };

  /** The key `withOptions` hands the copy it builds, which resolves none of its own. */
  static #sharing: { promise: Promise<ResolvedKey> } | undefined;

  /**
   * @throws {AuthenticationError} The key resolves to an empty argument or holds a character
   *   outside visible ASCII, or the credentials file cannot be read, is invalid or lacks the
   *   profile or the key the lookup chose.
   * @throws {InvalidRequestError} The base URL is not an absolute http or https URL or carries
   *   userinfo (`base_url_invalid`); a key would go over plain http to a host that is not
   *   loopback (`insecure_transport`); a default header holds a control character
   *   (`header_invalid`); the timeout is not a finite number above 0, or the retry count not an
   *   integer from 0 to 10 (`invalid_argument`).
   * @throws {TypeError} A secret key is given in a browser page or worker without
   *   `dangerouslyAllowBrowser`.
   */
  constructor(options: TransportOptions = {}) {
    this.#options = options;
    this.baseUrl = resolveBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    setHeaders(new Headers(), Object.entries(options.defaultHeaders ?? {}), "the headers option");
    this.timeout =
      options.timeout === undefined
        ? DEFAULT_TIMEOUT_MS
        : checkedTimeout(options.timeout, "timeout", false);
    this.maxRetries =
      options.maxRetries === undefined ? DEFAULT_MAX_RETRIES : checkedRetries(options.maxRetries);
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#now = options.now ?? (() => performance.now());
    this.#sleep = options.sleep ?? defaultSleep;
    this.#onWarning = options.onWarning ?? emitWarning;
    this.#key = Transport.#sharing ?? { promise: this.#resolveKey() };
  }

  /** The transport's clock, in milliseconds. */
  now(): number {
    return this.#now();
  }

  /**
   * The clock reading `ms` from now; `Infinity` for no deadline.
   *
   * @throws {InvalidRequestError} `ms` is not a number above 0 (`invalid_argument`).
   */
  deadlineAfter(ms: number): number {
    return this.#now() + checkedTimeout(ms, "timeout", true);
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

  /**
   * A copy with other limits that shares this transport's fetch, headers, warning handler and
   * resolved key.
   *
   * @throws {InvalidRequestError} The timeout is not a finite number above 0, or the retry count
   *   not an integer from 0 to 10 (`invalid_argument`).
   */
  withOptions(options: Pick<TransportOptions, "timeout" | "maxRetries">): Transport {
    Transport.#sharing = this.#key;
    try {
      return new Transport({
        ...this.#options,
        timeout: options.timeout === undefined ? this.timeout : options.timeout,
        maxRetries: options.maxRetries === undefined ? this.maxRetries : options.maxRetries,
      });
    } finally {
      Transport.#sharing = undefined;
    }
  }

  /** The key this transport sends, resolved when the transport was built and again after a
   *  401. */
  apiKey(): Promise<ResolvedKey> {
    return this.#key.promise;
  }

  /**
   * Resolves the key by the key-lookup rule, at once. A fault in the argument or the credentials
   * file raises here. Only a key function that returns a promise settles later, and its failure
   * rejects the first request.
   */
  #resolveKey(): Promise<ResolvedKey> {
    const found = lookUpApiKey({
      apiKey: this.#options.apiKey,
      env: this.#options.env,
      readCredentialsFile: this.#options.readCredentialsFile,
    });
    if (!(found instanceof Promise)) return Promise.resolve(this.#checkedKey(found));
    const pending = found.then((resolved) => this.#checkedKey(resolved));
    // A client never used must not end the process with an unhandled rejection. A request
    // awaits `pending` itself and sees the failure.
    pending.catch(() => undefined);
    return pending;
  }

  /** Refuses a secret key in a browser page or worker and a key over plain http to a host that
   *  is not loopback, and warns once for a key that fails the format check. */
  #checkedKey(resolved: ResolvedKey): ResolvedKey {
    refuseSecretKeyInBrowser(resolved.key, this.#options.dangerouslyAllowBrowser ?? false);
    if (resolved.key === null) return resolved;
    if (this.baseUrl.protocol === "http:" && !isLoopback(this.baseUrl.hostname)) {
      throw clientError("insecure_transport", {
        detail:
          `The API key would travel over plain http to ${this.baseUrl.host}, which is not a ` +
          "loopback host. Use an https base URL, or apiKey: false for anonymous use.",
      });
    }
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
    return resolved;
  }

  /**
   * The URL a manifest's artifact `url` names, which must sit on the API's origin, root-relative
   * or absolute.
   *
   * @throws {ContractError} The URL is on another origin, the storage host's included
   *   (`contract_violation`).
   */
  originUrl(url: string): URL {
    const resolved = this.url({ url });
    if (resolved.origin !== this.baseUrl.origin) {
      throw clientError("contract_violation", {
        detail: `The file URL ${url} is on ${resolved.origin}, which is not the API's origin.`,
      });
    }
    return resolved;
  }

  /**
   * The absolute URL of a target. A `path` resolves under the base URL's path, whose trailing
   * slashes are dropped, and must stay under it.
   *
   * @throws {InvalidRequestError} A `path` holds a control character or a `.` or `..` segment,
   *   or resolves outside the base URL's path (`invalid_argument`).
   */
  url(target: Target, query?: RequestOptions["query"]): URL {
    let url: URL;
    if (target.path === undefined) {
      url = new URL(target.url, this.baseUrl.origin);
    } else {
      const base = this.baseUrl.pathname.replace(/\/+$/, "");
      const fault = controlFault(target.path);
      if (fault !== null) {
        throw clientError("invalid_argument", { detail: `The path holds ${fault}.` });
      }
      if (hasDotSegment(target.path.split(/[?#]/)[0] ?? "")) {
        throw clientError("invalid_argument", {
          detail: "The path holds a . or .. segment, which would leave the API's base path.",
        });
      }
      url = new URL(`${base}/${target.path.replace(/^\//, "")}`, this.baseUrl.origin);
      // A backstop for what the checks above miss, which keeps the URL under the base path.
      if (url.origin !== this.baseUrl.origin || !url.pathname.startsWith(`${base}/`)) {
        throw clientError("invalid_argument", {
          detail: `The path ${JSON.stringify(target.path)} leaves the API's base path ${base || "/"}.`,
        });
      }
    }
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    return url;
  }

  /** Sends a request and parses its JSON body, raising a `DfoError` for a refusal and
   *  `ContractError` `unexpected_response` for a response with no JSON body. A redirect is never
   *  followed, so no client header reaches another host. The key sent reads as `[redacted]` in
   *  the parsed body, as in a refusal's, so no error built from the body quotes it. */
  async request(options: RequestOptions): Promise<JsonResponse> {
    const { response, body, key, url: sent } = await this.#send(options);
    if (isRedirect(response)) {
      throw clientError("unexpected_response", {
        status: response.status,
        detail: `${sent.pathname} answered with a redirect, which this call does not follow.`,
        traceId: traceIdOf(response.headers),
      });
    }
    const url = response.url ? new URL(response.url) : sent;
    let parsed: unknown;
    try {
      parsed = redacted(parseJson(UTF8.decode(body)), key);
    } catch (error) {
      throw clientError("unexpected_response", {
        status: response.status,
        detail: `The response from ${url.pathname} has no JSON body.`,
        traceId: traceIdOf(response.headers),
        cause: error,
      });
    }
    const { status, headers } = response;
    return { status, headers, url, body: parsed, traceId: traceIdOf(headers, parsed) };
  }

  /** Sends a request and reads its body as bytes, raising a `DfoError` for a refusal. A
   *  redirect is returned to the caller. */
  async requestRaw(options: RequestOptions): Promise<RawResponse> {
    const { response, body } = await this.#send(options);
    return new RawResponse(response.status, response.headers, body);
  }

  /**
   * Asks a files route for a file, retrying as every API request does. The route is on the API's
   * origin. It answers the bytes with a 200, or a 302 to a signed storage URL, which resolves
   * against the response's URL; `fetchSigned` fetches it. A browser hides a redirect's
   * `Location`, so there `locate` returns the route with `follow`, and `fetchSigned` asks it
   * again and lets the browser follow the redirect, as the round's one signed fetch.
   *
   * @throws {ContractError} The route is off the API's origin, or its redirect names a host
   *   other than the API's or the storage host (`contract_violation`); a redirect has no
   *   `Location` or an empty one (`contract_violation`); the route answered a 2xx other than 200
   *   or a 3xx other than 302, or a `Location` that is not a URL, such as one with a malformed
   *   IPv6 host or port (`unexpected_response`).
   * @throws {DfoError} The route refused the request.
   */
  async locate(options: Target & CallOptions): Promise<Located> {
    const target = options.url === undefined ? this.url(options) : this.originUrl(options.url);
    const { response, body } = await this.#send({ ...options, method: "GET" });
    if (response.type === "opaqueredirect") return { signed: target, follow: true };
    if (response.status === 200) return { data: body };
    const traceId = traceIdOf(response.headers, problemBody(response.headers, body));
    if (response.status !== 302) {
      throw clientError("unexpected_response", {
        status: response.status,
        detail: `The files route ${target.pathname} answered HTTP ${response.status}, not a 200 or a 302.`,
        traceId,
      });
    }
    const location = response.headers.get("location");
    if (location === null || location === "") {
      throw clientError("contract_violation", {
        status: response.status,
        detail: `The redirect from ${target.pathname} has no Location header.`,
        traceId,
      });
    }
    let signed: URL;
    try {
      signed = new URL(location, response.url || target);
    } catch (error) {
      throw clientError("unexpected_response", {
        status: response.status,
        detail: `The redirect from ${target.pathname} has a Location that is not a URL.`,
        traceId,
        cause: error,
      });
    }
    if (signed.origin !== this.baseUrl.origin && signed.origin !== STORAGE_ORIGIN) {
      throw clientError("contract_violation", {
        traceId,
        detail:
          `The redirect from ${target.pathname} is on ${signed.origin}, which is neither the ` +
          `API's origin nor ${STORAGE_ORIGIN}.`,
      });
    }
    return { signed, follow: false };
  }

  /**
   * Fetches the URL a files route redirected to, once. On the API's origin the request carries
   * the client's headers and key and its warning headers are read, as any API request's are. A
   * signed URL on the storage host gets a bare request, with no client header and no key. A
   * failed fetch is not retried. A signed URL can expire, so the caller asks the files route for
   * a fresh one.
   *
   * With `follow`, the URL is a files route whose redirect a browser hid. The request carries the
   * key alone, which the browser drops on the way to another origin, so none of the client's
   * headers reach the storage host. The browser follows the redirect, and the response's headers
   * issue no warning, since they come from wherever the redirect led. The followed response must
   * end on the API's origin or the storage host.
   *
   * @throws {ContractError} A followed redirect ended on another host (`contract_violation`).
   * @throws {ServerError} The host answered other than 200 (`download_failed`), or a 2xx body
   *   past `maxBytes`, `DEFAULT_MAX_BYTES` by default, or any other past `JSON_BODY_MAX_BYTES`
   *   (`response_too_large`).
   * @throws {NetworkError} The connection failed.
   * @throws {DfoTimeoutError} The attempt or the call's deadline ran out.
   */
  async fetchSigned(url: URL, options: SignedFetchOptions = {}): Promise<Uint8Array> {
    options.signal?.throwIfAborted();
    const follow = options.follow ?? false;
    // `#headers` gives no header for a URL off the API's origin.
    const { headers, key } = follow
      ? await this.#keyHeader(url, options)
      : await this.#headers("GET", url, options);
    const outcome = await this.#attempt(
      url,
      { ...options, maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES },
      { method: "GET", headers, redirect: follow ? "follow" : "manual" },
    );
    if (outcome instanceof DfoError) throw outcome;
    const { response, body } = outcome;
    const ended = response.url ? new URL(response.url) : url;
    if (follow && ended.origin !== this.baseUrl.origin && ended.origin !== STORAGE_ORIGIN) {
      throw clientError("contract_violation", {
        status: response.status,
        detail:
          `The redirect from ${url.pathname} ended on ${ended.origin}, which is neither the ` +
          `API's origin nor ${STORAGE_ORIGIN}.`,
      });
    }
    if (!follow && url.origin === this.baseUrl.origin) {
      this.#warnFromHeaders(response.headers, url, key);
    }
    if (response.status !== 200) {
      throw clientError("download_failed", {
        status: response.status,
        detail: `The download from ${ended.host} answered HTTP ${response.status}.`,
      });
    }
    return body;
  }

  /**
   * Sends one request with retries, returning a 2xx response or a redirect with its body, the
   * key it carried and the URL it went to. A redirect is never followed. A 2xx body is read no
   * further than `maxBytes`, any other no further than `JSON_BODY_MAX_BYTES`.
   *
   * @throws {InvalidRequestError} The method is not one the API serves, `json` is not JSON or
   *   goes with a GET or HEAD, or the timeout or retry count is out of range
   *   (`invalid_argument`).
   * @throws {ServerError} A decoded body passed its limit (`response_too_large`).
   */
  async #send(options: RequestOptions): Promise<Received & { key: string | undefined; url: URL }> {
    options.signal?.throwIfAborted();
    const method = options.method ?? (options.json === undefined ? "GET" : "POST");
    if (!METHODS.has(method)) {
      throw clientError("invalid_argument", {
        detail: `The method is not one the API serves; use one of ${[...METHODS].join(", ")}.`,
      });
    }
    const url = this.url(options, options.query);
    const body = options.json === undefined ? undefined : jsonText(options.json, method);
    const retries =
      options.maxRetries === undefined ? this.maxRetries : checkedRetries(options.maxRetries);
    const deadline = options.deadline ?? Infinity;
    let reauthenticated = false;
    // A key lookup that failed after a 401, the cause of the refusal that raises.
    let failure: unknown;

    for (let attempt = 0; ; attempt += 1) {
      const { headers, key } = await this.#headers(method, url, options);
      const outcome = await this.#attempt(url, options, {
        method,
        headers,
        redirect: "manual",
        ...(body === undefined ? {} : { body }),
      });

      let error: DfoError;
      if (outcome instanceof DfoError) {
        error = outcome;
      } else {
        const { response, body } = outcome;
        this.#warnFromHeaders(response.headers, url, key);
        if ((response.status >= 200 && response.status < 300) || isRedirect(response)) {
          return { ...outcome, key, url };
        }
        if (response.status === 401 && !reauthenticated) {
          // The key is resolved again after a 401, and a different key gets one more try.
          reauthenticated = true;
          const rekeyed = await this.#rekey(url, options);
          if (rekeyed.key !== undefined && rekeyed.key !== key) {
            attempt -= 1;
            continue;
          }
          failure = rekeyed.failure;
        }
        error = this.#refusal(response, body, { method, url, key }, failure);
      }

      const wait = attempt < retries ? this.refusalWait(error, attempt, deadline) : undefined;
      if (wait === undefined) throw error;
      await this.#sleep(wait, options.signal);
    }
  }

  /**
   * Resolves the key again after a 401: the key, undefined for anonymous use, or the lookup's
   * failure. Later requests share the new resolution while it runs. A key source that fails, or
   * outlives the attempt's timeout, leaves the server's refusal to raise with the failure as its
   * cause, and one that fails puts the earlier key back. A caller's abort or the call's deadline
   * still ends the call.
   */
  async #rekey(
    url: URL,
    options: CallOptions,
  ): Promise<{ key: string | undefined; failure?: unknown }> {
    const previous = this.#key.promise;
    try {
      const fresh = this.#resolveKey();
      this.#key.promise = fresh;
      fresh.catch(() => {
        if (this.#key.promise === fresh) this.#key.promise = previous;
      });
      const resolved = await this.#waitForProvider(
        () => fresh,
        url,
        options,
        "The apiKey function",
      );
      return { key: resolved.key?.reveal() };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (error instanceof DfoError && passedDeadline(error)) throw error;
      return { key: undefined, failure: error };
    }
  }

  /** The wait before retrying failed attempt `attempt` (from 0) after `error`, or undefined when
   *  the error raises now: it is not retryable, the deadline passed, its `Retry-After` is past
   *  `RETRY_AFTER_MAX_S`, or the wait would end at or past `deadline`. The wait is the
   *  refusal's `Retry-After`, else a backoff of 0.5 s that doubles with each attempt to at most
   *  8 s. */
  refusalWait(error: DfoError, attempt: number, deadline: number): number | undefined {
    if (!error.retryable || passedDeadline(error)) return undefined;
    const asked = error.retryAfterMs;
    if (asked !== null && asked > RETRY_AFTER_MAX_S * 1000) return undefined;
    const wait = asked ?? Math.min(BACKOFF_START_MS * 2 ** attempt, BACKOFF_CAP_MS);
    return this.#now() + wait < deadline ? wait : undefined;
  }

  async #headers(
    method: string,
    url: URL,
    options: CallOptions & Pick<RequestOptions, "json" | "headers">,
  ): Promise<{ headers: Headers; key: string | undefined }> {
    const headers = new Headers();
    if (url.origin !== this.baseUrl.origin) return { headers, key: undefined };
    // The caller's headers replace the client's User-Agent, as in the Python client.
    if (!inBrowser()) headers.set("user-agent", `dfo-ts/${VERSION}`);
    setHeaders(headers, Object.entries(this.#options.defaultHeaders ?? {}), "the headers option");
    const { headerProvider } = this.#options;
    if (headerProvider !== undefined) {
      // Plain JavaScript can return nothing, which adds no header.
      const provided = await this.#waitForProvider<HeadersInit | undefined>(
        () =>
          Promise.resolve()
            .then(() => headerProvider({ method, url }))
            .catch((error: unknown) => {
              throw clientError("header_invalid", {
                detail:
                  "The headerProvider raised an error " +
                  `(${error instanceof Error ? error.message : String(error)}).`,
                cause: error,
              });
            }),
        url,
        options,
        "The headerProvider",
      );
      if (provided !== undefined) setHeaders(headers, headerPairs(provided), "the headerProvider");
    }
    headers.set("accept", "application/json");
    if (options.json !== undefined) headers.set("content-type", "application/json");
    setHeaders(headers, Object.entries(options.headers ?? {}), "the call's headers");
    return this.#keyHeader(url, options, headers);
  }

  /** Sets the key, if any, as the `authorization` header of `headers`: by default a fresh set
   *  holding it alone, for a request whose redirect the browser follows. */
  async #keyHeader(
    url: URL,
    options: CallOptions,
    headers = new Headers(),
  ): Promise<{ headers: Headers; key: string | undefined }> {
    const key = (
      await this.#waitForProvider(() => this.#key.promise, url, options, "The apiKey function")
    ).key?.reveal();
    if (key !== undefined) headers.set("authorization", `Bearer ${key}`);
    return { headers, key };
  }

  /**
   * Waits for a header or key provider no longer than one attempt may run: the call's timeout,
   * or the time left before its deadline when that is shorter. A caller's abort ends the wait
   * too. The provider itself is never cancelled: a shared key resolution may serve a later
   * request after this caller has stopped waiting.
   *
   * @throws {DfoTimeoutError} The provider outlived the attempt's timeout or the call's deadline
   *   (`deadline_exceeded`).
   */
  async #waitForProvider<T>(
    provider: () => T | Promise<T>,
    url: URL,
    options: CallOptions,
    name: string,
  ): Promise<T> {
    const { signal } = options;
    signal?.throwIfAborted();
    const limit = this.#limit(url, options);
    if (limit.ms === Infinity && signal === undefined) return provider();
    const end = this.#now() + limit.ms;
    const expired = (): DfoTimeoutError =>
      limit.byDeadline
        ? this.#deadlinePassed(url)
        : clientError("deadline_exceeded", {
            detail: `${name} gave nothing within ${limit.ms} ms, the attempt's timeout.`,
          });

    let stop: (error: unknown) => void = () => undefined;
    const stopped = new Promise<never>((_resolve, reject) => {
      stop = reject;
    });
    const onAbort = (): void => {
      stop(signal?.reason);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      const remaining = end - this.#now();
      if (remaining <= 0) {
        stop(expired());
        return;
      }
      // A timer holds at most MAX_TIMER_MS, so a longer wait arms another when it fires.
      const wait = timerMs(remaining);
      timer = setTimeout(() => {
        if (wait === Math.ceil(remaining)) stop(expired());
        else arm();
      }, wait);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    if (end !== Infinity) arm();
    try {
      return await Promise.race([Promise.resolve().then(provider), stopped]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** How long the next attempt may run: its own timeout, or the time left before the deadline
   *  when that is shorter. */
  #limit(url: URL, { timeout, deadline }: CallOptions): Limit {
    const own = timeout === undefined ? this.timeout : checkedTimeout(timeout, "timeout", true);
    const remaining = (deadline ?? Infinity) - this.#now();
    if (remaining <= 0) throw this.#deadlinePassed(url);
    return remaining <= own ? { ms: remaining, byDeadline: true } : { ms: own, byDeadline: false };
  }

  /**
   * One fetch and the read of its whole body, under the attempt's limit. An infinite limit arms
   * no timer. A caller's abort rejects with the caller's reason. A failure the next attempt may
   * clear returns as a retryable error: a network failure, or the attempt's own timeout. The
   * deadline passing returns a `DfoTimeoutError` that `passedDeadline` marks, which no retry
   * follows. A 2xx body past `maxBytes`, or any other body past `JSON_BODY_MAX_BYTES`, returns
   * `response_too_large`, which no retry follows either.
   *
   * @throws {InvalidRequestError} The `fetch` option returned something that is not a Response
   *   (`invalid_argument`).
   */
  async #attempt(url: URL, options: CallOptions, init: RequestInit): Promise<Received | DfoError> {
    const limit = this.#limit(url, options);
    const timer = Number.isFinite(limit.ms) ? AbortSignal.timeout(timerMs(limit.ms)) : undefined;
    const signals = [options.signal, timer].filter((signal) => signal !== undefined);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    try {
      const response: unknown = await this.#fetch(url, { ...init, ...(signal ? { signal } : {}) });
      if (!isResponse(response)) {
        throw clientError("invalid_argument", {
          detail: "The fetch option returned something that is not a Response.",
        });
      }
      const ok = response.status >= 200 && response.status < 300;
      const maxBytes = ok ? (options.maxBytes ?? JSON_BODY_MAX_BYTES) : JSON_BODY_MAX_BYTES;
      const body = await readWithin(response, maxBytes);
      if (body !== null) return { response, body };
      return clientError("response_too_large", {
        status: response.status,
        detail: `The response from ${url.host} passed its limit of ${maxBytes} decoded bytes.`,
      });
    } catch (error) {
      if (error instanceof InvalidRequestError) throw error;
      if (options.signal?.aborted) throw options.signal.reason;
      if (timer?.aborted) {
        if (limit.byDeadline) return this.#deadlinePassed(url, error);
        return clientError("deadline_exceeded", {
          detail: `One attempt at ${url.pathname} waited ${limit.ms} ms with no whole response.`,
          cause: error,
        });
      }
      return clientError("network_error", {
        detail:
          `The request to ${url.host} failed before its whole response arrived ` +
          `(${failureReason(error)}).`,
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

  /**
   * The error a refusal stands for: a problem document, the proxy's own body, or neither. The
   * key sent reads as `[redacted]` in the body. A code that is not snake case is no code, and
   * its text stays in the detail. A 404 that matched no route, `not_found` or no code, names the
   * request in the message, since the base URL is the likely fault. The detail stays the
   * server's.
   */
  #refusal(
    response: Response,
    received: Uint8Array,
    sent: { method: string; url: URL; key: string | undefined },
    cause?: unknown,
  ): DfoError {
    const body = redacted(problemBody(response.headers, received), sent.key);
    const { status } = response;
    const traceId = traceIdOf(response.headers, body);
    const retryable = isRetryable(status, body);
    const retryAfter = retryAfterMs(response.headers) ?? null;
    const unmatched = (code: string): string | undefined =>
      status === 404 && (code === "not_found" || code === "refusal_without_code")
        ? `${sent.method} ${sent.url.href}`
        : undefined;
    // What a message opens with: the detail, or the status when the server gave none.
    const opening = (detail: unknown): string =>
      typeof detail === "string" ? detail : `HTTP ${status}`;

    // The website proxy's own refusal, {error, retry, detail}, carries its code as `error`.
    const proxy = isRecord(body) && !("code" in body) && "error" in body;
    const code = isRecord(body) ? body[proxy ? "error" : "code"] : undefined;
    if (isRecord(body) && typeof code === "string" && REFUSAL_CODE.test(code)) {
      const ErrorClass = errorClassFor(code, status);
      return new ErrorClass({
        code: serverCode(code),
        status,
        detail: typeof body["detail"] === "string" ? body["detail"] : code,
        message: refusalMessage(
          opening(body["detail"]),
          proxy ? undefined : body["pointer"],
          code,
          unmatched(code),
        ),
        traceId,
        retryable,
        retryAfterMs: retryAfter,
        problem: body,
        docsUrl: proxy ? null : this.#docsUrl(body["type"]),
        cause,
      });
    }
    // A body with no code keeps what a problem document says: whether to retry, its trace id. A
    // code that is not snake case, or a proxy body whose `error` is free text, keeps that text.
    const problem = isRecord(body) && !proxy ? body : null;
    const text = isRecord(body)
      ? [body["code"], body["error"]].find((value) => typeof value === "string")
      : undefined;
    const detail = `HTTP ${status} with no refusal code${text === undefined ? "" : `: ${text}`}.`;
    return clientError("refusal_without_code", {
      status,
      detail,
      message: refusalMessage(detail, undefined, null, unmatched("refusal_without_code")),
      traceId,
      retryable,
      retryAfterMs: retryAfter,
      problem: isRecord(body) ? body : null,
      docsUrl: this.#docsUrl(problem?.["type"]),
      cause,
    });
  }

  /** The page a problem document's `type` names, resolved against the API's origin, when it is
   *  an https URL on that origin; else null. */
  #docsUrl(type: unknown): string | null {
    if (typeof type !== "string" || type === "" || type === "about:blank") return null;
    try {
      const url = new URL(type, this.baseUrl.origin);
      return url.protocol === "https:" && url.origin === this.baseUrl.origin ? url.href : null;
    } catch {
      return null;
    }
  }

  /** Warns once per process for each distinct pair of `Deprecation` and `Sunset` values, on
   *  either header alone, and once per `x-dfo-warning` message, with the key sent, if any, read
   *  as `[redacted]`. */
  #warnFromHeaders(headers: Headers, url: URL, key: string | undefined): void {
    const deprecation = headers.get("deprecation");
    const sunset = headers.get("sunset");
    if (deprecation !== null || sunset !== null) {
      const marks = redactedText(
        [
          ...(deprecation === null ? [] : [`Deprecation: ${deprecation}`]),
          ...(sunset === null ? [] : [`Sunset: ${sunset}`]),
        ].join(", "),
        key,
      );
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
        clientWarning("server_warning", redactedText(warning, key)),
        this.#onWarning,
      );
    }
  }
}
