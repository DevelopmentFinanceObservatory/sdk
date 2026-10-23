/** The client: one connection to the DFO API, with its key, and every call made through it. */

import type { Answer, AnswerContext, SearchOptions } from "./answer.ts";
import type { Dataset } from "./dataset.ts";
import { clientError } from "./errors.ts";
import { fetchDataset, mint, resume } from "./fetch.ts";
import type { FetchOptions, MintOptions, ResumeOptions, SpecInput } from "./fetch.ts";
import type { ApiKeyOption } from "./keys.ts";
import { catalogue, Codes, Graph } from "./lookups.ts";
import type { CatalogueOptions, LookupOptions } from "./lookups.ts";
import type { Operation } from "./operation.ts";
import type { DatasetRef } from "./ref.ts";
import { search } from "./search.ts";
import { Transport } from "./transport.ts";
import type { HeaderProvider, RawResponse } from "./transport.ts";
import type { WarningHandler } from "./warnings.ts";
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
  /** The longest one request attempt waits, in milliseconds; `Infinity` for no limit. 30
   *  seconds by default. A failed attempt is retried as `maxRetries` allows. `search` (60 s)
   *  and `fetch` (30 min) also bound the whole call, and a build's POST reads for up to 150 s. */
  timeout?: number;
  /** Further attempts after a failure the server says can clear; 2 by default. */
  maxRetries?: number;
  /** Headers sent with every request to the API, never to a signed storage URL. */
  headers?: Record<string, string>;
  /** Called before every request to the API for more headers, such as an identity token. */
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
   * @throws {AuthenticationError} The `apiKey` argument is empty, or the credentials file is
   *   invalid or lacks the profile or the key the lookup chose.
   * @throws {TypeError} The base URL is relative and no page URL resolves it, or a secret key is
   *   given in a browser page or worker without `dangerouslyAllowBrowser`.
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
   * @throws {ContractError} The answer lacks a member the client acts on.
   */
  search(question: string, options: SearchOptions = {}): Promise<Answer> {
    return search(this.#answers, question, options);
  }

  /**
   * Fetches a spec's latest version, narrowed by `window`, `entities` and `facets`, or the exact
   * versions a ref names.
   *
   * @throws {InvalidRequestError} A ref is narrowed or given another layout.
   * @throws {VersionUnavailableError} A ref's version can no longer be fetched.
   * @throws {DataWarning} `strict` is true and a manifest carries a warning above `info`.
   * @throws {DfoTimeoutError} The deadline passed; a long build's message names the call that
   *   resumes it.
   * @throws {DfoError} The server refused a request.
   */
  fetch(target: SpecInput | DatasetRef, options: FetchOptions = {}): Promise<Dataset> {
    return fetchDataset(this.#transport, target, options);
  }

  /**
   * Starts a spec's build and returns it as an operation, done or running. The POST reads for up
   * to 150 seconds; `operation.result()` waits for the rest.
   *
   * @throws {DfoError} The server refused the build.
   */
  mint(spec: SpecInput, options: MintOptions = {}): Promise<Operation> {
    return mint(this.#transport, spec, options);
  }

  /**
   * Resumes a build started elsewhere, by its id (`op_...`). `layout` must be the one the build
   * was started with.
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
   * @throws {InvalidRequestError} `path` does not start with one `/` or names another
   *   host (`invalid_argument`).
   * @throws {DfoError} The class the refusal maps to.
   */
  async request(
    method: string,
    path: string,
    options: RawRequestOptions = {},
  ): Promise<RawResponse> {
    const transport = this.#transport;
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      transport.url({ path }).origin !== transport.baseUrl.origin
    ) {
      throw clientError("invalid_argument", {
        detail: `${JSON.stringify(path)} is not a path on the API at ${transport.baseUrl.href}.`,
      });
    }
    const { params, json, signal, timeout } = options;
    return transport.requestRaw({
      method: method.toUpperCase(),
      path,
      ...(params === undefined ? {} : { query: params }),
      ...(json === undefined ? {} : { json }),
      ...(signal === undefined ? {} : { signal }),
      ...(timeout === undefined ? {} : { timeout }),
    });
  }
}

/** A client over an existing transport, for tests and replays. */
export function clientOver(transport: Transport): Client {
  return adopt!(transport);
}
