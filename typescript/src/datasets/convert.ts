/**
 * Fetching a reading in another currency or price basis.
 *
 * A converted unit is another reading of the same question: the spec's identity with
 * `facets.unit` set to the request, which has its own `spec_id` and sentence. The client posts
 * one identity entry with the request per answer part to Search as one `dataset_resubmit`, each
 * echoing its part's `separate` flag, operations and assumptions, so Search states for the
 * converted part the assumptions that still hold. It groups the definite parts of the reply by
 * spec, takes each spec, sentence and entity groups in place of the held ones, and builds those
 * as any fetch does. Each entry posts the identity as `window`, `entities` and `facets` narrow
 * it (`scopedIdentity`), so Search judges the years and places the build reads, and the
 * converted readings build with no further scope.
 *
 * A part Search answers with `no_data` or `unsupported` refuses the fetch, with the class
 * `contract/actions.json` gives its reason or code, or the base `DfoError` for one it lacks,
 * even under `partial`, since the refusal is of this call's arguments. Its `cause`, such as the
 * rates the tables lack, stays on the error's `problem`. A converted member carries the converted
 * part's assumptions, departures and operations, and its `warn` and `degraded` warnings reach
 * the warning handler as `SearchWarning`s once the member is built (`fetchMembers`), or the first
 * raises under `strict`. A build whose sentence comes from resubmitting the built reading, as one
 * the server puts in another canonical form does, takes that reply's warnings instead.
 */
import {
  actionFor,
  capped,
  clientError,
  DfoError,
  errorClassFor,
  isRetryable,
  problemAt200,
  serverCode,
} from "../core/errors.ts";
import { isRecord, list, text } from "../core/json.ts";
import { warningsOf } from "../core/parse.ts";
import type { Notice } from "../wire.ts";
import { partText } from "../core/parts.ts";
import type { Part } from "../core/parts.ts";
import { checkStrict } from "../core/strict.ts";
import { describing } from "../core/trace.ts";
import type { Spec } from "../core/ref.ts";
import { SEARCH_TIMEOUT_MS } from "../http/transport.ts";
import type { Transport } from "../http/transport.ts";
import type { Dataset } from "./dataset.ts";
import {
  checkMembers,
  echoedReading,
  fetchMembers,
  identityEntry,
  invalid,
  keptEntityGroups,
  narrowingRefusal,
  RESOLVE_PATH,
  resolvedOf,
  resubmitBody,
  scopedIdentity,
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
  /** `"current"` (each year's own prices, the default) or `"constant"` (one base year's).
   *  Needs `currency`. */
  priceBasis?: "current" | "constant";
  /** The year whose prices constant-price values are in, such as 2022. Needed with
   *  `priceBasis: "constant"` and refused with `"current"`. `unitConversion(spec).defaultBaseYear`
   *  names the tables' default. */
  baseYear?: number;
};

/** A call's conversion options as read. A JavaScript caller's need not hold the declared
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

/** A reading as a message names it, by its first part's words or else its spec id. */
const readingName = ({ parts, spec }: MemberRequest): string =>
  parts[0] === undefined ? spec.spec_id : JSON.stringify(parts[0]);

/** A part's variable text as a member's `parts` name it: none when it has none. */
function textsOf(part: Part): string[] {
  const variableText = partText(part);
  return variableText === null || variableText === "" ? [] : [variableText];
}

/** A member a conversion posts one entry for, with its build `scope`, which the entry's
 *  identity applies. */
type Converting = {
  readonly member: MemberRequest;
  readonly scope: Readonly<Record<string, unknown>> | undefined;
};

/** What a conversion posts one entry each for, in member order: a member for each of its answer
 *  parts, naming that part and answering it alone, or the member itself when it has none, each
 *  with its member's scope from `scopes`. */
const convertedParts = (
  members: readonly MemberRequest[],
  scopes: readonly (Readonly<Record<string, unknown>> | undefined)[],
): Converting[] =>
  members.flatMap((member, at) =>
    (member.answerParts === undefined || member.answerParts.length === 0
      ? [member]
      : member.answerParts.map((part): MemberRequest => ({
          ...member,
          parts: textsOf(part),
          answerParts: [part],
        }))
    ).map((each) => ({ member: each, scope: scopes[at] })),
  );

/** The identity entry that asks Search for one of `convertedParts`' members in `request`'s
 *  unit: its identity as its scope narrows it (`scopedIdentity`), with the entity groups that
 *  hold for it. It names the member's answer part's variable text, else its first part, else
 *  `UNNAMED_PART`, and echoes the answer part's members `echoedReading` gives. */
function entryOf({ member, scope }: Converting, request: UnitRequest): Record<string, unknown> {
  const held = member.spec.definition["identity"];
  if (!isRecord(held)) {
    throw invalid(
      `The definition of ${member.spec.spec_id} holds no identity to convert; use a spec from ` +
        "a search.",
    );
  }
  const identity = scopedIdentity(held, scope);
  const facets = isRecord(identity["facets"]) ? identity["facets"] : {};
  identity["facets"] = { ...facets, unit: { state: "value", request } };
  const part = member.answerParts?.[0];
  const groups = keptEntityGroups(
    {
      spec: member.spec,
      entityGroups: member.entityGroups ?? resolvedOf(member.spec).entityGroups,
    },
    { identity },
  );
  return {
    ...identityEntry(member.parts[0] ?? UNNAMED_PART, identity, groups),
    ...(part === undefined ? {} : echoedReading(part)),
  };
}

/** The body that resubmits each of `convertedParts`' members with the unit request, so each
 *  answer part keeps its own operations, assumptions and `separate` flag. */
export function conversionBody(
  posted: readonly Converting[],
  request: UnitRequest,
): Record<string, unknown> {
  return resubmitBody(
    posted.map((each) => entryOf(each, request)),
    { include_observations: false },
  );
}

/** Whether a converted spec's identity holds the posted request, meaning the same `currency`,
 *  `prices` and `base_year`, an absent base year and a null one alike. */
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
 * Asks Search for each reading in `request`'s unit, in one request with one entry per answer
 * part. The reply's parts are grouped by their converted spec, as an answer groups its parts: a
 * converted member answers the original parts whose replies name its spec, and takes the spec,
 * its sentence and entity groups, and those reply parts, which state the reading's assumptions,
 * departures and operations. Members come back in first-seen order.
 *
 * @throws {InvalidRequestError} A part refused the conversion with a code the contract maps to
 *   it, such as `rate_coverage_gap` (its `problem.cause` names the missing rates), or the server
 *   refused the request, such as `recipe_not_declared` for a series no recipe converts.
 * @throws {ContractError} The reply does not hold one part per entry, a definite part's spec
 *   does not hold the request, or a part has another status (`contract_violation`).
 * @throws {DfoError} A part refused with a reason or code the contract does not list, as its
 *   code.
 */
async function convert(
  transport: Transport,
  members: readonly MemberRequest[],
  scopes: readonly (Readonly<Record<string, unknown>> | undefined)[],
  request: UnitRequest,
  wait: Wait,
): Promise<MemberRequest[]> {
  const posted = convertedParts(members, scopes);
  // Search answers within its own time limit, so the conversion waits for it as a search does:
  // each attempt runs to the fetch's deadline, else to `SEARCH_TIMEOUT_MS` from now.
  const response = await transport.request({
    path: RESOLVE_PATH,
    json: conversionBody(posted, request),
    attemptTimeout: Infinity,
    deadline: Number.isFinite(wait.deadline)
      ? wait.deadline
      : transport.callDeadline(SEARCH_TIMEOUT_MS),
    signal: wait.signal,
  });
  const { body, traceId } = response;
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
    if (parts.length !== posted.length) {
      throw clientError("contract_violation", {
        detail:
          `Search answered ${parts.length} parts to a conversion of ${posted.length} ` +
          `part${posted.length === 1 ? "" : "s"}.`,
        pointer: "/parts",
      });
    }
    const unit = requestText(request);
    /** Each converted spec's member and its parts' warnings, by `spec_id`. */
    const grouped = new Map<string, { member: MemberRequest; warnings: Notice[] }>();
    for (const [index, { member }] of posted.entries()) {
      const part = parts[index];
      const status = isRecord(part) ? part["status"] : undefined;
      if (!isRecord(part) || status !== "definite") {
        throw partRefusal(member, part, request, traceId, index);
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
      const answered: Part = { ...part, status };
      const warnings = warningsOf(part["warnings"]);
      const seen = grouped.get(reading.spec_id);
      if (seen === undefined) {
        grouped.set(reading.spec_id, {
          member: { ...member, spec: reading, ...resolvedOf(reading), answerParts: [answered] },
          warnings: [...warnings],
        });
        continue;
      }
      const { member: first } = seen;
      seen.member = {
        ...first,
        parts: [...first.parts, ...member.parts.filter((name) => !first.parts.includes(name))],
        answerParts: [...(first.answerParts ?? []), answered],
      };
      seen.warnings.push(...warnings);
    }
    return [...grouped.values()].map(({ member, warnings }): MemberRequest => ({
      ...member,
      converted: { label: `Converting ${readingName(member)} to ${unit}`, warnings, traceId },
    }));
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
    [part["rendered_sentence"], refusal["message"], refusal["detail"]]
      .map(text)
      .find((found) => found !== null && found !== "") ?? code;
  const cause = refusal["cause"];
  const missing = isRecord(cause)
    ? list(cause["entities"]).filter((entity) => typeof entity === "string")
    : [];
  const more = isRecord(cause) && cause["truncated"] === true ? ", and more" : "";
  const detail = [
    `Search cannot convert ${readingName(member)} to ${requestText(request)}: ` +
      capped(said.trim()),
    ...(missing.length === 0 ? [] : [`Missing: ${missing.join(", ")}${more}.`]),
  ].join(" ");
  // A problem document as the server would send it, so the class is the one its code maps to
  // and `problem.cause` keeps what the tables lack. A code the contract does not list is a
  // reason the server added, so it raises the base class with that code.
  // The message is the detail whole: its sentence is capped, and the missing rates and the
  // hint after it stay.
  const problem = { code, detail, ...(cause === undefined ? {} : { cause }) };
  const ErrorClass = actionFor(code) === undefined ? DfoError : errorClassFor(code, 200);
  return new ErrorClass({
    code: serverCode(code),
    status: 200,
    detail,
    message: detail,
    traceId,
    retryable: isRetryable(200, problem),
    problem,
  });
}

/**
 * Builds the members in `request`'s unit, or as they are when `request` is undefined. The
 * conversion's arguments and the narrowing are checked once, before any request, the conversion
 * posts each identity as the narrowing leaves it and shares the fetch's deadline, and `build`
 * builds the converted members, which carry their narrowing in their identities. A refusal of a
 * narrowed entity carries the hints a build's would.
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
  const { wants, scopes } = checkMembers(members, options);
  const wait = options.wait ?? waitFor(transport, options);
  let converted: MemberRequest[];
  try {
    converted = await convert(transport, wants, scopes, request, wait);
  } catch (error) {
    throw narrowingRefusal(error, options.narrowing ?? {});
  }
  return build(transport, converted, { ...options, wait });
}
