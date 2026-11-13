/**
 * Lookups for names and codes: the graph's resolver and nodes, the code registry and Search's
 * catalogue.
 *
 * Each lookup returns a frozen object from `lookup-results.ts` whose `raw` holds the decoded
 * response body, typed by the served OpenAPI document's schema. The body must be an object holding the members that schema requires and that tell it from a
 * problem document. A body that does not, and is a problem document (a `code` and no `kind`),
 * raises the class `errorClassFor` gives its code, or `ContractError` (`contract_violation`) for a
 * code the contract does not map; any other body raises `contract_violation`. The client reads no
 * more of it, so an unknown member or enum value passes through untouched. An options key a
 * lookup does not take raises `InvalidRequestError` (`invalid_argument`) before any request.
 */

import { clientError, problemAt200, REFUSAL_CODE } from "../core/errors.ts";
import { checkOptions, declareOptions } from "../core/options.ts";
import { isRecord } from "../core/json.ts";
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
  ResolveKind,
  ResolveResponse,
} from "../wire.ts";
import { Catalogue, Code, Match, Node } from "./lookup-results.ts";
import type { GraphNode } from "./lookup-results.ts";

/** A lookup's cancellation and timeout. */
export type LookupOptions = {
  readonly signal?: AbortSignal;
  /** The longest the whole call takes, retries included, in milliseconds; `Infinity` for no
   *  bound. The client's `timeout` by default, else none; each attempt also stops at the
   *  client's `attemptTimeout`. */
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

const RESOLVE_OPTIONS = declareOptions<ResolveOptions>("client.lookup.resolve", {
  signal: true,
  timeout: true,
  kinds: true,
  codeSystem: true,
  expandMembers: true,
});
const NODE_OPTIONS = declareOptions<NodeOptions>("client.lookup.node", {
  signal: true,
  timeout: true,
  asOf: true,
});
const CODE_OPTIONS = declareOptions<LookupOptions>("client.lookup.code", {
  signal: true,
  timeout: true,
});
const CATALOGUE_OPTIONS = declareOptions<CatalogueOptions>("client.lookup.catalogue", {
  signal: true,
  timeout: true,
  place: true,
});

/** The body of a lookup's response, once it holds what `schema` requires and passes `nested`,
 *  which checks the members below it the result reads. A body that does not hold what `schema`
 *  requires, and is a problem document, raises the error the document stands for. */
const lookupBody = (
  response: JsonResponse,
  schema: string,
  required: Readonly<Record<string, JsonType>>,
  nested: (body: Readonly<Record<string, unknown>>) => void = () => {},
): Readonly<Record<string, unknown>> =>
  describing(response.traceId, () => {
    let body: Readonly<Record<string, unknown>>;
    try {
      body = checkRequired(schema, required, response.body);
    } catch (error) {
      throw problemAt200(response.body, response.traceId) ?? error;
    }
    nested(body);
    return body;
  });

/** Checks each item of `items` against what `schema` requires. */
function checkEach(
  schema: string,
  required: Readonly<Record<string, JsonType>>,
  items: readonly unknown[],
  pointer: string,
): void {
  for (const [index, item] of items.entries()) {
    checkRequired(schema, required, item, `${pointer}/${index}`);
  }
}

/** What a `Match` reads of a resolver result, and of each node it names: the members the wire
 *  schema requires and admits no null for. */
const RESOLVE_RESULT = { input: "string", status: "string" } as const;
const ENTITY_REF = { ref: "string", label: "string" } as const;

/** Checks each resolver result and the nodes it names; `results` is an array by then. The
 *  nullable `entity`, `candidates` and `near_matches` are checked only when held as an object or
 *  an array, and read as absent when held as another JSON type. */
function checkResults({ results }: Readonly<Record<string, unknown>>): void {
  for (const [index, item] of (results as readonly unknown[]).entries()) {
    const at = `/results/${index}`;
    const result = checkRequired("ResolveResult", RESOLVE_RESULT, item, at);
    if (isRecord(result.entity)) {
      checkRequired("EntityRef", ENTITY_REF, result.entity, `${at}/entity`);
    }
    for (const member of ["candidates", "near_matches"] as const) {
      const refs = result[member];
      if (Array.isArray(refs)) checkEach("EntityRef", ENTITY_REF, refs, `${at}/${member}`);
    }
  }
}

/** A lookup's signal, and its deadline from its `timeout`, else the client's. */
const callOptions = (transport: Transport, { signal, timeout }: LookupOptions) => ({
  signal,
  deadline: transport.callDeadline(timeout),
});

/** The lookups: names to graph nodes, a node by its dcid, a code's registry entry, and what
 *  Search holds data on. */
export class Lookup {
  readonly #transport: Transport;

  /** @internal Lookups come from `client.lookup`. The client calls this constructor. */
  constructor(transport: Transport) {
    this.#transport = transport;
  }

  /** The lookups' calls, as `<Lookup: resolve(names), node(dcid), code(code), catalogue()>`. */
  toString(): string {
    return "<Lookup: resolve(names), node(dcid), code(code), catalogue()>";
  }

  /** Node's `console.log` and `util.inspect` show the lookups as `String(client.lookup)` does. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }

  /**
   * Resolves names, such as "Nigeria" or "Sahel", to graph nodes. One to 25 names resolve as one
   * batch, with one `Match` per name in their order.
   *
   * @throws {InvalidRequestError} The server refused the names or kinds.
   */
  async resolve(
    texts: string | readonly string[],
    options: ResolveOptions = {},
  ): Promise<readonly Match[]> {
    const call = checkOptions(RESOLVE_OPTIONS, options);
    const { kinds, codeSystem, expandMembers = false } = call;
    const body: GraphApiResolveModelsResolveRequest = {
      texts: typeof texts === "string" ? [texts] : [...texts],
      ...(kinds === undefined ? {} : { kinds: [...kinds] }),
      ...(codeSystem === undefined ? {} : { code_system: codeSystem }),
      ...(expandMembers ? { expand: ["members"] } : {}),
    };
    const response = await this.#transport.request({
      path: "/graph/resolve",
      json: body,
      ...callOptions(this.#transport, call),
    });
    const { results } = lookupBody(
      response,
      "ResolveResponse",
      { results: "array" },
      checkResults,
    ) as ResolveResponse;
    return Object.freeze(results.map((result) => new Match(result)));
  }

  /**
   * One graph node by its dcid, such as `country/NGA`.
   *
   * @throws {InvalidRequestError} The dcid is empty, has a `.` or `..` segment, or holds `?`,
   *   `#` or a control character (`invalid_argument`); no request is sent.
   * @throws {NotFoundError} The graph holds no node with that dcid.
   */
  async node(dcid: string, options: NodeOptions = {}): Promise<Node> {
    const call = checkOptions(NODE_OPTIONS, options);
    checkDcid(dcid);
    const path = `/graph/node/${dcid.split("/").map(encodeURIComponent).join("/")}`;
    const response = await this.#transport.request({
      path,
      query: { as_of: call.asOf },
      ...callOptions(this.#transport, call),
    });
    return new Node(
      lookupBody(response, "GraphNode", {
        kind: "string",
        ref: "string",
        types: "array",
      }) as GraphNode,
    );
  }

  /**
   * The registry entry for one code, such as `spec_not_found`: what a refusal or warning code
   * means. The registry sits at the API host's root, the page an error's `docsUrl` names.
   *
   * @throws {InvalidRequestError} The code is not lower-case snake case (`invalid_argument`).
   * @throws {NotFoundError} The registry holds no such code.
   */
  async code(code: string, options: LookupOptions = {}): Promise<Code> {
    const call = checkOptions(CODE_OPTIONS, options);
    if (!REFUSAL_CODE.test(code)) {
      throw clientError("invalid_argument", {
        detail: "A code is a lower-case letter followed by lower-case letters, digits or _.",
      });
    }
    const response = await this.#transport.request({
      url: `/codes/${encodeURIComponent(code)}`,
      ...callOptions(this.#transport, call),
    });
    return new Code(
      lookupBody(response, "CodeRegistryEntry", {
        code: "string",
        mappings: "array",
      }) as CodeRegistryEntry,
    );
  }

  /** What Search holds data on: counts and example questions, for one country with `place`. */
  async catalogue(options: CatalogueOptions = {}): Promise<Catalogue> {
    const call = checkOptions(CATALOGUE_OPTIONS, options);
    const response = await this.#transport.request({
      path: "/search/catalogue",
      query: { place: call.place },
      ...callOptions(this.#transport, call),
    });
    return new Catalogue(
      lookupBody(
        response,
        "CatalogueResponse",
        {
          catalogue_version: "string",
          counts: "object",
          examples: "array",
        },
        ({ examples }) => {
          checkEach(
            "CatalogueExampleSentence",
            { text: "string" },
            examples as readonly unknown[],
            "/examples",
          );
        },
      ) as CatalogueResponse,
    );
  }
}

/**
 * Refuses a dcid that would leave the node route or carry a query: an empty one, one holding a
 * control character, `?` or `#`, or one with a `.` or `..` segment, percent-encoded or not.
 *
 * @throws {InvalidRequestError} (`invalid_argument`).
 */
function checkDcid(dcid: string): void {
  const fault = controlFault(dcid);
  let problem: string;
  if (dcid === "") problem = "is empty";
  else if (fault !== null) problem = `holds ${fault}`;
  else if (/[?#]/.test(dcid)) problem = "holds a ? or a #";
  else if (hasDotSegment(dcid)) problem = "holds a . or .. segment";
  else return;
  throw clientError("invalid_argument", {
    detail: `The dcid ${problem}; pass one such as country/NGA.`,
  });
}
