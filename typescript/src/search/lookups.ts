/**
 * Lookups for names and codes: the graph's resolver and nodes, the code registry and Search's
 * catalogue.
 *
 * Each lookup returns the decoded response body, typed by the served OpenAPI document's schema.
 * The body must be an object holding the members that schema requires and that tell it from a
 * problem document, else `ContractError` (`contract_violation`) raises. The client reads no more
 * of it, so an unknown member or enum value passes through untouched.
 */

import { clientError } from "../core/errors.ts";
import { checkRequired } from "../core/strict.ts";
import type { JsonType } from "../core/strict.ts";
import { describing } from "../core/trace.ts";
import { controlFault, hasDotSegment } from "../core/text.ts";
import type { JsonResponse } from "../http/transport.ts";
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

/** The body of a lookup's response, once it holds what `schema` requires. */
const lookupBody = (
  response: JsonResponse,
  schema: string,
  required: Readonly<Record<string, JsonType>>,
): Readonly<Record<string, unknown>> =>
  describing(response.traceId, () => checkRequired(schema, required, response.body));

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
    return lookupBody(response, "ResolveResponse", { results: "array" }) as ResolveResponse;
  }

  /**
   * One graph node by its dcid, such as `country/NGA`.
   *
   * @throws {InvalidRequestError} The dcid is empty, has a `.` or `..` segment, or holds `?`,
   *   `#` or a control character (`invalid_argument`); no request is sent.
   * @throws {NotFoundError} The graph holds no node with that dcid.
   */
  async node(dcid: string, options: NodeOptions = {}): Promise<GraphNode> {
    checkDcid(dcid);
    const path = `/graph/node/${dcid.split("/").map(encodeURIComponent).join("/")}`;
    const response = await this.#transport.request({
      path,
      query: { as_of: options.asOf },
      ...callOptions(options),
    });
    return lookupBody(response, "GraphNode", { kind: "string", ref: "string" }) as GraphNode;
  }
}

/** A registry code, such as `spec_not_found`. */
const CODE = /^[a-z][a-z0-9_]*$/;

/**
 * Refuses a dcid that would leave the node route or carry a query: an empty one, one holding a
 * control character, `?` or `#`, or one with a `.` or `..` segment, percent-encoded or not.
 *
 * @throws {InvalidRequestError} (`invalid_argument`).
 */
function checkDcid(dcid: string): void {
  const fault = controlFault(dcid);
  const problem =
    dcid === ""
      ? "is empty"
      : fault !== null
        ? `holds ${fault}`
        : /[?#]/.test(dcid)
          ? "holds a ? or a #"
          : hasDotSegment(dcid)
            ? "holds a . or .. segment"
            : null;
  if (problem !== null) {
    throw clientError("invalid_argument", {
      detail: `The dcid ${problem}; pass one such as country/NGA.`,
    });
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
   * @throws {InvalidRequestError} The code is not lower-case snake case (`invalid_argument`).
   * @throws {NotFoundError} The registry holds no such code.
   */
  async get(code: string, options: LookupOptions = {}): Promise<CodeRegistryEntry> {
    if (!CODE.test(code)) {
      throw clientError("invalid_argument", {
        detail: "A code is a lower-case letter followed by lower-case letters, digits or _.",
      });
    }
    const response = await this.#transport.request({
      url: `/codes/${encodeURIComponent(code)}`,
      ...callOptions(options),
    });
    return lookupBody(response, "CodeRegistryEntry", {
      code: "string",
      mappings: "array",
    }) as CodeRegistryEntry;
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
  return lookupBody(response, "CatalogueResponse", {
    catalogue_version: "string",
    counts: "object",
    examples: "array",
  }) as CatalogueResponse;
}
