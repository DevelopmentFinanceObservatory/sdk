/** The client: one connection to the DFO API, with its key, and every call made through it. */

import { registerClient } from "./search/answer.ts";
import type { Answer, AnswerContext, SearchOptions } from "./search/answer.ts";
import type { Dataset } from "./datasets/dataset.ts";
import { clientError, DfoError, InvalidRequestError, messageOf, optionsOf } from "./core/errors.ts";
import { present } from "./core/json.ts";
import { checkOptions, declareOptions } from "./core/options.ts";
import { fetchDataset } from "./datasets/resolve.ts";
import type { FetchOptions } from "./datasets/fetch.ts";
import type { ApiKeyOption } from "./config/keys.ts";
import { Lookup } from "./search/lookups.ts";
import type { LookupOptions } from "./search/lookups.ts";
import type { DatasetRef, Spec } from "./core/ref.ts";
import { search } from "./search/search.ts";
import { Transport } from "./http/transport.ts";
import type { HeaderProvider, RawResponse } from "./http/transport.ts";
import type { WarningHandler } from "./core/warnings.ts";

export type ClientOptions = {
  /** The API's base URL; a relative one, such as `/api/v1`, resolves against the page. Without
   *  one the client reads `DFO_BASE_URL` where the platform has a process environment, then uses
   *  the public API, `https://developmentfinance.org/api/v1`. `String(client)` shows a base URL
   *  other than the public API's, and names `DFO_BASE_URL` when it came from there. */
  baseUrl?: string;
  /** The key: a string, an `ApiKey`, or a function returning one; `false` for anonymous use.
   *  Without one the client reads `DFO_API_KEY`, then the credentials file. */
  apiKey?: ApiKeyOption;
  /** The platform's `fetch`, or one that stands in for it. */
  fetch?: typeof globalThis.fetch;
  /** The longest one request attempt waits, in milliseconds, a finite number above 0. 30
   *  seconds by default. A failed attempt is retried as `maxRetries` allows. `search` also
   *  bounds the whole call (60 s), a build's POST reads for up to 150 s, and a download fails
   *  after 30 s with no byte. `fetch` waits as long as its build takes unless given a
   *  `timeout`. */
  timeout?: number;
  /** Further attempts after a failure the server says can clear, an integer from 0 to 10; 2 by
   *  default. */
  maxRetries?: number;
  /** Headers sent with every request to the API, never to a signed storage URL. A `User-Agent` here
   *  replaces the client's own. While the client has a key, `Authorization` carries it and
   *  replaces one from here or from `headerProvider`. With `apiKey: false` the `Authorization`
   *  given here is sent. `X-DFO-Client`, which the client sets to name itself and its runtime,
   *  raises `InvalidRequestError` (`header_invalid`) here or from `headerProvider`. */
  headers?: Record<string, string>;
  /** Called before every request to the API for more headers, such as an identity token. Its
   *  headers replace those of `headers`, and the key's `Authorization` replaces any it returns. An
   *  error it raises reaches the caller as `InvalidRequestError` (`header_invalid`), with that
   *  error as the `cause`. */
  headerProvider?: HeaderProvider;
  /** Receives each warning; `process.emitWarning`, else `console.warn`, by default. */
  onWarning?: WarningHandler;
  /** Sends a secret key from a browser page or worker, where every visitor can read it. */
  dangerouslyAllowBrowser?: boolean;
};

export type RawRequestOptions = LookupOptions & {
  /** Query parameters; an undefined value is left out. */
  readonly params?: Readonly<Record<string, string | number | boolean | undefined>>;
  /** The JSON body. */
  readonly json?: unknown;
};

const CLIENT_OPTIONS = declareOptions<ClientOptions>("new Client", {
  baseUrl: true,
  apiKey: true,
  fetch: true,
  timeout: true,
  maxRetries: true,
  headers: true,
  headerProvider: true,
  onWarning: true,
  dangerouslyAllowBrowser: true,
});

const LIMITS = declareOptions<Pick<ClientOptions, "timeout" | "maxRetries">>("client.withOptions", {
  timeout: true,
  maxRetries: true,
});

const REQUEST_OPTIONS = declareOptions<RawRequestOptions>("client.request", {
  signal: true,
  timeout: true,
  params: true,
  json: true,
});

/** The transport `clientOver` hands the next constructor call. */
let adopting: Transport | undefined;

/**
 * A connection to the DFO API with its key. Every call goes through one transport, which
 * `withOptions` copies share.
 */
export class Client {
  /** Names to graph nodes, a node by its dcid, a code's registry entry, and what Search holds
   *  data on. */
  readonly lookup: Lookup;
  readonly #transport: Transport;
  readonly #answers: AnswerContext;

  /**
   * Builds the client and resolves its key, which it resolves again after a 401.
   *
   * @throws {AuthenticationError} The key is empty or holds a character outside visible ASCII
   *   (`key_empty`, `key_invalid`), or the credentials file cannot be read, is invalid, or lacks
   *   the profile or the key the lookup chose.
   * @throws {InvalidRequestError} The base URL, from `baseUrl` or else `DFO_BASE_URL`, is empty,
   *   not an absolute http or https URL, or carries userinfo, a query or a fragment
   *   (`base_url_invalid`); a key would go over plain
   *   http to a host that is not loopback (`insecure_transport`); a header value holds a control
   *   character, or a header is named `X-DFO-Client` (`header_invalid`); `timeout` is not a finite number above 0, or `maxRetries` not
   *   an integer from 0 to 10, or `options` holds a key outside `ClientOptions`
   *   (`invalid_argument`).
   * @throws {TypeError} A secret key is given in a browser page or worker without
   *   `dangerouslyAllowBrowser`.
   */
  constructor(options: ClientOptions = {}) {
    const { headers, ...rest } = checkOptions(CLIENT_OPTIONS, options);
    this.#transport =
      adopting ??
      new Transport({ ...rest, ...(headers === undefined ? {} : { defaultHeaders: headers }) });
    this.#answers = {
      transport: this.#transport,
      onWarning: (warning) => {
        this.#transport.warn(warning);
      },
    };
    registerClient(this, this.#answers);
    this.lookup = new Lookup(this.#transport);
  }

  /** The API's base URL. */
  get baseUrl(): string {
    return this.#transport.baseUrl.href;
  }

  /** The client as `<Client https://…>`, naming its base URL, with `(from DFO_BASE_URL)` when
   *  that variable set it. */
  toString(): string {
    const { baseUrl, baseUrlSource } = this.#transport;
    const from = baseUrlSource === "DFO_BASE_URL" ? " (from DFO_BASE_URL)" : "";
    return `<Client ${baseUrl.href}${from}>`;
  }

  /** Node's `console.log` and `util.inspect` show the client as `String(client)` does. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }

  /** A copy with other limits that shares this client's transport: its fetch, headers, warning
   *  handler and key. */
  withOptions(options: Pick<ClientOptions, "timeout" | "maxRetries">): Client {
    return clientOver(this.#transport.withOptions(checkOptions(LIMITS, options)));
  }

  /**
   * Asks Search what a question means, part by part.
   *
   * @throws {InvalidRequestError} The question is empty or only whitespace, or holds a lone
   *   surrogate, or `options` holds a key outside `SearchOptions` (`invalid_argument`).
   * @throws {ContractError} The answer lacks a member the client acts on.
   */
  search(question: string, options: SearchOptions = {}): Promise<Answer> {
    return search(this.#answers, question, options);
  }

  /**
   * Fetches a spec's latest version, narrowed by `window`, `entities` and `facets`, or the exact
   * versions a ref names, or with `latest: true` the newest versions of a ref's specs in the
   * ref's rendering. It waits as long as a build takes, reporting a long build's progress
   * to `onProgress`. A `timeout` or an aborted `signal` stops the wait and leaves the build
   * running on the server, and the same fetch joins it.
   *
   * @throws {InvalidRequestError} `options` holds a key outside `FetchOptions`, a window year
   *   falls outside 1000 to 2200, `entities` names a role outside `specRoles(spec)`, the target is neither a ref nor a spec with its `spec_id` and
   *   `definition`, a ref is narrowed or given another layout or `partyTotals`, or
   *   `latest` is given a spec or a ref whose members differ in rendering.
   * @throws {VersionUnavailableError} A ref's version can no longer be fetched.
   * @throws {DataWarning} `strict` is true and a manifest carries a warning above `info`.
   * @throws {DfoTimeoutError} The `timeout` passed (`deadline_exceeded`); the build carries on.
   * @throws {DfoError} The server refused a request.
   */
  fetch(target: Spec | DatasetRef, options: FetchOptions = {}): Promise<Dataset> {
    return fetchDataset(this.#transport, target, options);
  }

  /**
   * Sends a request to a route the client does not wrap, such as `/datasets/capabilities`. It
   * carries the client's key and headers and retries as every call does. A redirect comes back
   * as the response.
   *
   * @throws {InvalidRequestError} `path` does not start with one `/`, holds a control
   *   character, or leaves the base URL's path once dot segments resolve; `method` is not one the
   *   API serves; `json` is not JSON or goes with a GET or HEAD; `options` holds a key outside
   *   `RawRequestOptions` (`invalid_argument`); or the
   *   server refused the method (`method_not_allowed`), which on a route the client wraps is a
   *   `ContractError`.
   * @throws {ServerError} The decoded body passed `JSON_BODY_MAX_BYTES` (`response_too_large`).
   * @throws {DfoError} The class the refusal maps to.
   */
  async request(
    method: string,
    path: string,
    options: RawRequestOptions = {},
  ): Promise<RawResponse> {
    const transport = this.#transport;
    const { params, json, signal, timeout } = checkOptions(REQUEST_OPTIONS, options);
    if (!path.startsWith("/") || path.startsWith("//")) {
      throw clientError("invalid_argument", {
        detail: `${JSON.stringify(path)} is not a path on the API at ${transport.baseUrl.href}.`,
      });
    }
    // Refuses a path that leaves the base URL's path before any request.
    transport.url({ path });
    try {
      return await transport.requestRaw({
        method: method.toUpperCase(),
        path,
        ...present({ query: params, json, signal, timeout }),
      });
    } catch (error) {
      throw callerRefusal(error);
    }
  }
}

/** The code of a refusal of the request's method. The contract maps it to `upgrade`, which
 *  holds for a route the client wraps; on a raw request the caller chose the method. */
const METHOD_NOT_ALLOWED = "method_not_allowed";

/** The error a raw request raises for `error`: a refused method is the caller's to fix, an
 *  `InvalidRequestError` keeping the refusal's code and members, and any other error stays as
 *  it is. */
function callerRefusal(error: unknown): unknown {
  if (
    !(error instanceof DfoError) ||
    error.code !== METHOD_NOT_ALLOWED ||
    error instanceof InvalidRequestError
  ) {
    return error;
  }
  return new InvalidRequestError({ ...optionsOf(error), message: messageOf(error) });
}

/** A client over an existing transport, for tests and replays. */
export function clientOver(transport: Transport): Client {
  adopting = transport;
  try {
    return new Client();
  } finally {
    adopting = undefined;
  }
}
