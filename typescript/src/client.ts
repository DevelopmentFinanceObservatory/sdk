/** The client: one connection to the DFO API, with its key, and every call made through it. */

import type { Answer, AnswerContext, SearchOptions } from "./search/answer.ts";
import type { Dataset } from "./datasets/dataset.ts";
import { clientError, DfoError, InvalidRequestError } from "./core/errors.ts";
import { mint, resume } from "./datasets/fetch.ts";
import { fetchDataset } from "./datasets/resolve.ts";
import type { FetchOptions, MintOptions, ResumeOptions, SpecInput } from "./datasets/fetch.ts";
import type { ApiKeyOption } from "./config/keys.ts";
import { catalogue, Codes, Graph } from "./search/lookups.ts";
import type { CatalogueOptions, LookupOptions } from "./search/lookups.ts";
import type { Operation } from "./datasets/operation.ts";
import type { DatasetRef } from "./core/ref.ts";
import { search } from "./search/search.ts";
import { Transport } from "./http/transport.ts";
import type { HeaderProvider, RawResponse } from "./http/transport.ts";
import type { WarningHandler } from "./core/warnings.ts";
import type { CatalogueResponse } from "./wire.ts";

export type ClientOptions = {
  /** The API's base URL, `https://developmentfinance.org/api/v1` by default; a relative one,
   *  such as `/api/v1`, resolves against the page. */
  baseUrl?: string;
  /** The key: a string, an `ApiKey`, or a function returning one; `false` for anonymous use.
   *  Without one the client reads `DFO_API_KEY`, then the credentials file. */
  apiKey?: ApiKeyOption;
  /** The platform's `fetch`, or one that stands in for it. */
  fetch?: typeof globalThis.fetch;
  /** The longest one request attempt waits, in milliseconds, a finite number above 0. 30
   *  seconds by default. A failed attempt is retried as `maxRetries` allows. `search` (60 s)
   *  and `fetch` (30 min) also bound the whole call, and a build's POST reads for up to 150 s. */
  timeout?: number;
  /** Further attempts after a failure the server says can clear, an integer from 0 to 10; 2 by
   *  default. */
  maxRetries?: number;
  /** Headers sent with every request to the API, never to a signed storage URL. A `User-Agent` here
   *  replaces the client's own. While the client has a key, `Authorization`
   *  carries it and replaces one from here or from `headerProvider`; with `apiKey: false` the
   *  `Authorization` given here is sent. */
  headers?: Record<string, string>;
  /** Called before every request to the API for more headers, such as an identity token. Its
   *  headers replace those of `headers`, and the key's `Authorization` replaces its own. */
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

let adopt: ((transport: Transport) => Client) | undefined;

/**
 * A connection to the DFO API with its key. Every call goes through one transport, which
 * `withOptions` copies share.
 */
export class Client {
  /** Names to graph nodes, and a node by its dcid. */
  readonly graph: Graph;
  /** The code registry, which says what each error code means. */
  readonly codes: Codes;
  readonly #transport: Transport;
  readonly #answers: AnswerContext;

  /** The transport `clientOver` hands the next constructor call. */
  static #adopting: Transport | undefined;

  static {
    adopt = (transport) => {
      Client.#adopting = transport;
      try {
        return new Client();
      } finally {
        Client.#adopting = undefined;
      }
    };
  }

  /**
   * Builds the client and resolves its key, which it resolves again after a 401.
   *
   * @throws {AuthenticationError} The key is empty or holds a character outside visible ASCII
   *   (`key_empty`, `key_invalid`), or the credentials file cannot be read, is invalid, or lacks
   *   the profile or the key the lookup chose.
   * @throws {InvalidRequestError} The base URL is empty, not an absolute http or https URL, or
   *   carries userinfo, a query or a fragment (`base_url_invalid`); a key would go over plain
   *   http to a host that is not loopback (`insecure_transport`); a header value holds a control
   *   character (`header_invalid`); `timeout` is not a finite number above 0, or `maxRetries` not
   *   an integer from 0 to 10 (`invalid_argument`).
   * @throws {TypeError} A secret key is given in a browser page or worker without
   *   `dangerouslyAllowBrowser`.
   */
  constructor(options: ClientOptions = {}) {
    const { headers, ...rest } = options;
    this.#transport =
      Client.#adopting ??
      new Transport({ ...rest, ...(headers === undefined ? {} : { defaultHeaders: headers }) });
    this.#answers = {
      transport: this.#transport,
      onWarning: (warning) => {
        this.#transport.warn(warning);
      },
    };
    this.graph = new Graph(this.#transport);
    this.codes = new Codes(this.#transport);
  }

  /** The API's base URL. */
  get baseUrl(): string {
    return this.#transport.baseUrl.href;
  }

  /** A copy with other limits that shares this client's transport: its fetch, headers, warning
   *  handler and key. */
  withOptions(options: Pick<ClientOptions, "timeout" | "maxRetries">): Client {
    return clientOver(this.#transport.withOptions(options));
  }

  /**
   * Asks Search what a question means, part by part.
   *
   * @throws {InvalidRequestError} The question is empty or only whitespace (`invalid_argument`).
   * @throws {ContractError} The answer lacks a member the client acts on.
   */
  search(question: string, options: SearchOptions = {}): Promise<Answer> {
    return search(this.#answers, question, options);
  }

  /**
   * Fetches a spec's latest version, narrowed by `window`, `entities` and `facets`, or the exact
   * versions a ref names.
   *
   * @throws {InvalidRequestError} The target is neither a ref nor a spec with its `spec_id` and
   *   `definition`, or a ref is narrowed or given another layout or `withoutPartyTotals`.
   * @throws {VersionUnavailableError} A ref's version can no longer be fetched.
   * @throws {DataWarning} `strict` is true and a manifest carries a warning above `info`.
   * @throws {DfoTimeoutError} The deadline passed; a long build's message names the call that
   *   resumes it.
   * @throws {DfoError} The server refused a request.
   */
  fetch(target: SpecInput | DatasetRef, options: FetchOptions = {}): Promise<Dataset<never>> {
    return fetchDataset(this.#transport, target, options);
  }

  /**
   * Starts a spec's build and returns it as an operation, done or running. The POST reads for up
   * to 150 seconds; `operation.result()` waits for the rest.
   *
   * @throws {InvalidRequestError} The spec lacks its `spec_id` or `definition`.
   * @throws {DfoError} The server refused the build.
   */
  mint(spec: SpecInput, options: MintOptions = {}): Promise<Operation> {
    return mint(this.#transport, spec, options);
  }

  /**
   * Resumes a build started elsewhere, by its id (`op_...`). `layout` and `withoutPartyTotals`
   * must be the ones the build was started with.
   *
   * @throws {NotFoundError} The server holds no operation with that id.
   * @throws {DfoError} The operation failed.
   */
  operation(operationId: string, options: ResumeOptions = {}): Promise<Operation> {
    return resume(this.#transport, operationId, options);
  }

  /** What Search holds data on: counts and example questions, for one country with `place`. */
  catalogue(options: CatalogueOptions = {}): Promise<CatalogueResponse> {
    return catalogue(this.#transport, options);
  }

  /**
   * Sends a request to a route the client does not wrap, such as `/datasets/capabilities`. It
   * carries the client's key and headers and retries as every call does. A redirect comes back
   * as the response.
   *
   * @throws {InvalidRequestError} `path` does not start with one `/`, holds a control
   *   character, or leaves the base URL's path once dot segments resolve; `method` is not one the
   *   API serves; `json` is not JSON or goes with a GET or HEAD (`invalid_argument`); or the
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
    if (!path.startsWith("/") || path.startsWith("//")) {
      throw clientError("invalid_argument", {
        detail: `${JSON.stringify(path)} is not a path on the API at ${transport.baseUrl.href}.`,
      });
    }
    // Refuses a path that leaves the base URL's path before any request.
    transport.url({ path });
    const { params, json, signal, timeout } = options;
    try {
      return await transport.requestRaw({
        method: method.toUpperCase(),
        path,
        ...(params === undefined ? {} : { query: params }),
        ...(json === undefined ? {} : { json }),
        ...(signal === undefined ? {} : { signal }),
        ...(timeout === undefined ? {} : { timeout }),
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
  return new InvalidRequestError({
    code: error.code,
    status: error.status,
    detail: error.detail,
    message: error.message,
    traceId: error.traceId,
    retryable: error.retryable,
    retryAfterMs: error.retryAfterMs,
    problem: error.problem,
    docsUrl: error.docsUrl,
    cause: error,
  });
}

/** A client over an existing transport, for tests and replays. */
export function clientOver(transport: Transport): Client {
  return adopt!(transport);
}
