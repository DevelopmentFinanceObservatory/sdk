/**
 * Lookups for names and codes: the graph's resolver and nodes, the code registry and Search's
 * catalogue.
 *
 * Each lookup returns the decoded response body, typed by the served OpenAPI document's schema.
 * The client reads none of it, so an unknown member or enum value passes through untouched.
 */

import type { Transport } from "../http/transport.ts";
import type {
  CatalogueResponse,
  CodeRegistryEntry,
  GraphApiResolveModelsResolveRequest,
  paths,
  ResolveResponse,
} from "../wire.ts";

/** A kind of graph node a name can resolve to. */
export type ResolveKind = NonNullable<GraphApiResolveModelsResolveRequest["kinds"]>[number];

/** One graph node, told apart by its `kind`. */
export type GraphNode =
  paths["/api/graph/node/{dcid}"]["get"]["responses"][200]["content"]["application/json"];

/** A lookup's cancellation and attempt timeout. */
export type LookupOptions = {
  readonly signal?: AbortSignal;
  /** The longest one request attempt waits, in milliseconds. Defaults to the client's
   *  `timeout`. */
  readonly timeout?: number;
};

export type ResolveOptions = LookupOptions & {
  /** The node kinds a name may resolve to. The server's default is every kind of place and
   *  group. */
  readonly kinds?: readonly ResolveKind[];
  /** Narrows `code` matches to one code system's graph id, such as `CRSPurposeCodeEnum`. Needs
   *  `code` in `kinds`. */
  readonly codeSystem?: string;
  /** Inlines each group's or region's members. */
  readonly expandMembers?: boolean;
};

export type NodeOptions = LookupOptions & {
  /** Reads the node as the graph held it on this date, `YYYY-MM-DD`. */
  readonly asOf?: string;
};

export type CatalogueOptions = LookupOptions & {
  /** A country dcid, such as `country/NGA`, to scope the counts and examples to that country. */
  readonly place?: string;
};

const callOptions = ({ signal, timeout }: LookupOptions) => ({
  ...(signal === undefined ? {} : { signal }),
  ...(timeout === undefined ? {} : { timeout }),
});

/** The graph's lookups: names to dcids, and a node by its dcid. */
export class Graph {
  readonly #transport: Transport;

  /** Graphs come from `client.graph`. The client calls this constructor. */
  constructor(transport: Transport) {
    this.#transport = transport;
  }

  /**
   * Resolves names, such as "Nigeria" or "Sahel", to graph nodes. One to 25 names resolve as one
   * batch, and `results` follows their order.
   *
   * @throws {InvalidRequestError} The server refused the names or kinds.
   */
  async resolve(
    texts: string | readonly string[],
    options: ResolveOptions = {},
  ): Promise<ResolveResponse> {
    const { kinds, codeSystem, expandMembers = false } = options;
    const body: GraphApiResolveModelsResolveRequest = {
      texts: typeof texts === "string" ? [texts] : [...texts],
      ...(kinds === undefined ? {} : { kinds: [...kinds] }),
      ...(codeSystem === undefined ? {} : { code_system: codeSystem }),
      ...(expandMembers ? { expand: ["members"] } : {}),
    };
    const response = await this.#transport.request({
      path: "/graph/resolve",
      json: body,
      ...callOptions(options),
    });
    return response.body as ResolveResponse;
  }

  /**
   * One graph node by its dcid, such as `country/NGA`.
   *
   * @throws {NotFoundError} The graph holds no node with that dcid.
   */
  async node(dcid: string, options: NodeOptions = {}): Promise<GraphNode> {
    const path = `/graph/node/${dcid.split("/").map(encodeURIComponent).join("/")}`;
    const response = await this.#transport.request({
      path,
      query: { as_of: options.asOf },
      ...callOptions(options),
    });
    return response.body as GraphNode;
  }
}

/** The code registry: what each refusal and warning code means. */
export class Codes {
  readonly #transport: Transport;

  /** Code lookups come from `client.codes`. The client calls this constructor. */
  constructor(transport: Transport) {
    this.#transport = transport;
  }

  /**
   * The registry entry for one code, such as `spec_not_found`. The registry sits at the API
   * host's root, the page an error's `docsUrl` names.
   *
   * @throws {NotFoundError} The registry holds no such code.
   */
  async get(code: string, options: LookupOptions = {}): Promise<CodeRegistryEntry> {
    const response = await this.#transport.request({
      url: `/codes/${encodeURIComponent(code)}`,
      ...callOptions(options),
    });
    return response.body as CodeRegistryEntry;
  }
}

/** What Search holds data on: counts and example questions. */
export async function catalogue(
  transport: Transport,
  options: CatalogueOptions = {},
): Promise<CatalogueResponse> {
  const response = await transport.request({
    path: "/search/catalogue",
    query: { place: options.place },
    ...callOptions(options),
  });
  return response.body as CatalogueResponse;
}
