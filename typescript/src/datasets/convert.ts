/**
 * Fetching a reading in another currency or price basis.
 *
 * A converted unit is another reading of the same question: the spec's identity with
 * `facets.unit` set to the request, which has its own `spec_id` and sentence. The client posts
 * every reading's identity with the request to Search as one `dataset_resubmit`, takes each
 * definite part's spec, sentence and entity groups in place of the held ones, and builds those
 * as any fetch does. The conversion runs on the reading as held, before `window`, `entities` and
 * `facets` narrow it, so Search judges the held years and places.
 *
 * A part Search answers with `no_data` or `unsupported` refuses the fetch, with the class
 * `contract/actions.json` gives its reason or code, or the base `DfoError` for one it lacks yet,
 * even under `partial`, since the refusal is of this call's arguments. Its `cause`, such as the
 * rates the tables lack, stays on the error's `problem`. A converted member carries the converted
 * part's assumptions, departures and operations, and its `warn` and `degraded` warnings reach
 * the warning handler as `SearchWarning`s once the member is built (`fetchMembers`), or the first
 * raises under `strict`. A narrowed build whose sentence comes from resubmitting the built
 * reading takes that reply's warnings instead, since the held reading's speak of years and
 * places the narrowing may cut.
 */
import {
  actionFor,
  capped,
  clientError,
  DfoError,
  problemAt200,
  refusalMessage,
  serverCode,
} from "../core/errors.ts";
import { isRecord, list, text } from "../core/json.ts";
import { warningsOf } from "../core/parse.ts";
import { checkStrict } from "../core/strict.ts";
import { describing } from "../core/trace.ts";
import type { Spec } from "../core/ref.ts";
import type { Transport } from "../http/transport.ts";
import type { Dataset } from "./dataset.ts";
import {
  checkMembers,
  fetchMembers,
  identityEntry,
  invalid,
  narrows,
  RESOLVE_PATH,
  resolvedOf,
  resubmitBody,
  UNNAMED_PART,
} from "./fetch.ts";
import type { FetchMembersOptions, MemberRequest } from "./fetch.ts";
import { waitFor } from "./operation.ts";
import type { Wait } from "./operation.ts";

/** The unit a fetch asks for, named after the row columns it sets: `currency`, `price_basis`
 *  and `base_year`. */
export type Conversion = {
  /** The ISO 4217 code of the currency to convert to, in capitals, such as `"EUR"`.
   *  `unitConversion(spec)` lists the codes a reading converts to. */
  currency?: string;
  /** `"current"`, each year's own prices, or `"constant"`, one base year's; `"current"` when
   *  left out. Needs `currency`. */
  priceBasis?: "current" | "constant";
  /** The year whose prices constant-price values are in, such as 2022. Needed with
   *  `priceBasis: "constant"`, refused otherwise; `unitConversion(spec).defaultBaseYear` names
   *  the tables' default. */
  baseYear?: number;
};

/** A call's conversion options as read: a JavaScript caller's need not hold the declared
 *  types. */
export type ConversionArgs = { readonly [K in keyof Conversion]?: unknown };

/** The names `Conversion` holds, in the order a refusal lists them. */
export const CONVERSION_KEYS = ["currency", "priceBasis", "baseYear"] as const;

/** The unit request as Search's identity holds it under `facets.unit.request`. */
export type UnitRequest = {
  readonly currency: string;
  readonly prices: "current" | "constant";
  readonly base_year?: number;
};

const CURRENCY_CODE = /^[A-Z]{3}$/;

/** The conversion names a call gives, null read as unset as for a narrowing. */
export const givenConversion = (conversion: ConversionArgs): string[] =>
  CONVERSION_KEYS.filter((key) => conversion[key] !== undefined && conversion[key] !== null);

/**
 * The unit request a call's options ask for, or undefined when they name no currency.
 *
 * @throws {InvalidRequestError} `priceBasis` or `baseYear` is given without `currency`;
 *   `currency` is not three capital letters; `priceBasis` is neither `"current"` nor
 *   `"constant"`; `baseYear` is not an integer, or is missing for constant prices or given for
 *   current ones; or `facets` binds `unit` beside `currency` (`invalid_argument`).
 */
export function checkedConversion(
  conversion: ConversionArgs,
  facets: unknown,
): UnitRequest | undefined {
  const { currency, priceBasis, baseYear } = conversion;
  const given = (value: unknown): boolean => value !== undefined && value !== null;
  if (!given(currency)) {
    if (given(priceBasis) || given(baseYear)) {
      throw invalid(
        "priceBasis and baseYear go with currency, such as " +
          '{ currency: "EUR", priceBasis: "constant", baseYear: 2022 }.',
      );
    }
    return undefined;
  }
  if (typeof currency !== "string" || !CURRENCY_CODE.test(currency)) {
    throw invalid(
      `currency is an ISO 4217 code in capitals, such as "EUR", not ${shown(currency)}; ` +
        "unitConversion(spec) lists the codes a reading converts to.",
    );
  }
  const prices = given(priceBasis) ? priceBasis : "current";
  if (prices !== "current" && prices !== "constant") {
    throw invalid(`priceBasis is "current" or "constant", not ${shown(priceBasis)}.`);
  }
  if (given(baseYear) && (typeof baseYear !== "number" || !Number.isSafeInteger(baseYear))) {
    throw invalid(`baseYear is a year such as 2022, not ${shown(baseYear)}.`);
  }
  if (prices === "current" && given(baseYear)) {
    throw invalid(
      'baseYear goes with priceBasis: "constant"; current prices are each year\'s own and take ' +
        "no base year.",
    );
  }
  if (prices === "constant" && !given(baseYear)) {
    throw invalid(
      'priceBasis: "constant" needs baseYear, the year whose prices the values are in, such as ' +
        "baseYear: 2022; unitConversion(spec).defaultBaseYear names the tables' default.",
    );
  }
  if (isRecord(facets) && Object.hasOwn(facets, "unit")) {
    throw invalid(
      "facets.unit and currency both set the unit; drop facets.unit to convert, or currency " +
        "to bind a unit the series holds.",
    );
  }
  return prices === "constant"
    ? { currency, prices, base_year: baseYear as number }
    : { currency, prices };
}

function shown(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(capped(value)) : capped(String(value));
}

/** A unit request in words, as `EUR at constant 2022 prices`. */
const requestText = ({ currency, prices, base_year }: UnitRequest): string =>
  prices === "constant"
    ? `${currency} at constant ${base_year} prices`
    : `${currency} at current prices`;

/** A reading as a message names it: its first part's words, else the spec id. */
const readingName = ({ parts, spec }: MemberRequest): string =>
  parts[0] === undefined ? spec.spec_id : JSON.stringify(parts[0]);

/** The identity entry that asks Search for a reading in `request`'s unit. */
function entryOf(member: MemberRequest, request: UnitRequest): Record<string, unknown> {
  const identity = member.spec.definition["identity"];
  if (!isRecord(identity)) {
    throw invalid(
      `The definition of ${member.spec.spec_id} holds no identity to convert; use a spec from ` +
        "a search.",
    );
  }
  const facets = isRecord(identity["facets"]) ? identity["facets"] : {};
  return identityEntry(
    member.parts[0] ?? UNNAMED_PART,
    { ...identity, facets: { ...facets, unit: { state: "value", request } } },
    member.entityGroups ?? resolvedOf(member.spec).entityGroups,
  );
}

/** The body that resubmits every reading with the unit request. */
export function conversionBody(
  members: readonly MemberRequest[],
  request: UnitRequest,
): Record<string, unknown> {
  return resubmitBody(
    members.map((member) => entryOf(member, request)),
    { include_observations: false },
  );
}

/** Whether a converted spec's identity holds the posted request: the same `currency` and
 *  `prices`, and the same `base_year`, an absent one and a null one alike. */
function holdsRequest(spec: Record<string, unknown>, request: UnitRequest): boolean {
  const definition = spec["definition"];
  const identity = isRecord(definition) ? definition["identity"] : undefined;
  const facets = isRecord(identity) ? identity["facets"] : undefined;
  const unit = isRecord(facets) ? facets["unit"] : undefined;
  const echoed = isRecord(unit) ? unit["request"] : undefined;
  return (
    isRecord(echoed) &&
    echoed["currency"] === request.currency &&
    echoed["prices"] === request.prices &&
    (echoed["base_year"] ?? null) === (request.base_year ?? null)
  );
}

/**
 * Asks Search for each reading in `request`'s unit, in one request.
 *
 * @throws {InvalidRequestError} A part refused the conversion with a code the contract maps to
 *   it, such as `rate_coverage_gap` (its `problem.cause` names the missing rates), or the server
 *   refused the request, such as `recipe_not_declared` for a series no recipe converts.
 * @throws {ContractError} The reply does not hold one part per reading, a definite part's spec
 *   does not hold the request, or a part has another status (`contract_violation`).
 * @throws {DfoError} A part refused with a reason or code the contract does not list yet, as its
 *   code.
 */
async function convert(
  transport: Transport,
  members: readonly MemberRequest[],
  request: UnitRequest,
  wait: Wait,
  narrowed: boolean,
): Promise<MemberRequest[]> {
  const response = await transport.request({
    path: RESOLVE_PATH,
    json: conversionBody(members, request),
    deadline: wait.deadline,
    signal: wait.signal,
  });
  const { body } = response;
  const diagnostics = isRecord(body) ? body["diagnostics"] : undefined;
  const traceId =
    text(isRecord(diagnostics) ? diagnostics["trace_id"] : undefined) ?? response.traceId;
  return describing(traceId, () => {
    const refused = problemAt200(body, traceId);
    if (refused !== undefined) throw refused;
    if (!isRecord(body) || body["kind"] !== "resolution") {
      throw clientError("contract_violation", {
        detail: `Search answered a conversion to ${requestText(request)} with no resolution.`,
      });
    }
    checkStrict("Resolution", body);
    const parts = list(body["parts"]);
    if (parts.length !== members.length) {
      throw clientError("contract_violation", {
        detail:
          `Search answered ${parts.length} parts to a conversion of ${members.length} ` +
          `reading${members.length === 1 ? "" : "s"}.`,
        pointer: "/parts",
      });
    }
    const unit = requestText(request);
    return members.map((member, index): MemberRequest => {
      const part = parts[index];
      const status = isRecord(part) ? part["status"] : undefined;
      if (!isRecord(part) || status !== "definite") {
        throw partRefusal(member, part, request, traceId, narrowed, index);
      }
      // checkStrict has checked a definite part holds a spec.
      const spec = part["spec"] as Record<string, unknown>;
      const definition = spec["definition"];
      if (
        typeof spec["spec_id"] !== "string" ||
        !isRecord(definition) ||
        definition["spec_id"] !== spec["spec_id"] ||
        !holdsRequest(spec, request)
      ) {
        throw clientError("contract_violation", {
          detail:
            `Search answered the conversion of ${readingName(member)} to ` +
            `${requestText(request)} with a spec that does not hold that request.`,
          pointer: `/parts/${index}/spec/definition/identity/facets/unit/request`,
        });
      }
      const reading = spec as Spec;
      // The converted part states the reading's assumptions, departures and operations.
      return {
        ...member,
        spec: reading,
        ...resolvedOf(reading),
        answerParts: [{ ...part, status }],
        converted: { unit, warnings: warningsOf(part["warnings"]), traceId },
      };
    });
  });
}

/**
 * The error a part that is not definite stands for: for `no_data` its reason and for
 * `unsupported` its code, of the class `contract/actions.json` gives it, or the base `DfoError`
 * for a code it lacks. Any other status raises `ContractError`.
 */
function partRefusal(
  member: MemberRequest,
  given: unknown,
  request: UnitRequest,
  traceId: string | null,
  narrowed: boolean,
  index: number,
): Error {
  const part = isRecord(given) ? given : {};
  const status = part["status"];
  const refusal = part[String(status)];
  const code = isRecord(refusal)
    ? text(status === "no_data" ? refusal["reason"] : refusal["code"])
    : null;
  if ((status !== "no_data" && status !== "unsupported") || !isRecord(refusal) || code === null) {
    return clientError("contract_violation", {
      detail:
        `Search answered the conversion of ${readingName(member)} to ${requestText(request)} ` +
        `with a ${capped(JSON.stringify(status ?? null))} part.`,
      pointer: `/parts/${index}/status`,
      traceId,
    });
  }
  const said =
    text(part["rendered_sentence"]) ?? text(refusal["message"]) ?? text(refusal["detail"]) ?? code;
  const cause = refusal["cause"];
  const missing = isRecord(cause)
    ? list(cause["entities"]).filter((entity) => typeof entity === "string")
    : [];
  const more = isRecord(cause) && cause["truncated"] === true ? ", and more" : "";
  const detail = [
    `Search cannot convert ${readingName(member)} to ${requestText(request)}: ` +
      capped(said.trim()),
    ...(missing.length === 0 ? [] : [`Missing: ${missing.join(", ")}${more}.`]),
    ...(narrowed
      ? [
          "The conversion runs on the reading as held, before window, entities and facets " +
            "narrow it; fetch without them, or narrow first and convert ds.members[0].spec.",
        ]
      : []),
  ].join(" ");
  // A problem document as the server would send it, so the class is the one its code maps to
  // and `problem.cause` keeps what the tables lack. A code the contract does not know yet is a
  // reason the server added, so it raises the base class with that code.
  const problem = { code, detail, ...(cause === undefined ? {} : { cause }) };
  if (actionFor(code) === undefined) {
    return new DfoError({
      code: serverCode(code),
      status: 200,
      detail,
      message: refusalMessage(detail, undefined),
      traceId,
      problem,
    });
  }
  return problemAt200(problem, traceId)!;
}

/**
 * Builds the members in `request`'s unit, or as they are when `request` is undefined. The
 * conversion's arguments and the narrowing are checked before any request, the conversion
 * shares the fetch's deadline, and `build` builds the converted members.
 *
 * @throws {SearchWarning} `strict` is true and Search warned about a converted reading.
 */
export async function fetchConverted(
  transport: Transport,
  members: readonly MemberRequest[],
  options: FetchMembersOptions,
  request: UnitRequest | undefined,
  build: (
    transport: Transport,
    members: readonly MemberRequest[],
    options: FetchMembersOptions,
  ) => Promise<Dataset> = fetchMembers,
): Promise<Dataset> {
  if (request === undefined) return build(transport, members, options);
  const { wants } = checkMembers(members, options);
  const wait = options.wait ?? waitFor(transport, options);
  const narrowed = narrows(options.narrowing ?? {});
  const converted = await convert(transport, wants, request, wait, narrowed);
  return build(transport, converted, { ...options, wait });
}
