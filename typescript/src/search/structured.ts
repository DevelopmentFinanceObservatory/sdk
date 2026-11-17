/**
 * A search by publisher series codes: the parsed input it posts and the checks on Search's
 * answer. `parsedInput` builds one part per code, so each code answers on its own, and `codeGap`
 * tells whether a definite part read from a code is that code's series alone.
 */
import type { Gap, SearchOptions } from "./answer.ts";
import { Entity, Match, entityDcid } from "./lookup-results.ts";
import { clientError } from "../core/errors.ts";
import { isRecord, objects, text } from "../core/json.ts";
import { partFacts } from "../core/parse.ts";
import { isKnownPart } from "../core/parts.ts";
import type { Part } from "../core/parts.ts";
import { dcidsOf, invalid, windowScope } from "../datasets/fetch.ts";
import type { EntityChoice, Window } from "../datasets/fetch.ts";
import { FLOW_KEYS, ROLE_KEYS } from "../generated/role-keys.ts";
import type { Notice, ParsedInput } from "../wire.ts";

/** A search by publisher series codes, and the Search request's signal and timeout. Each code
 *  answers as its own part, and every other key applies to each code. */
export type CodeSearchOptions = SearchOptions & {
  /** Publisher series codes, such as `["DT.TDS.MLAT.CD", "DT.TDS.BLAT.CD"]`. */
  readonly codes: readonly string[];
  /** Words that choose among a code's variables, such as "debt service". Left out, each code's
   *  part reads the code. */
  readonly variable?: string | undefined;
  /** Role keys bound to dcids, such as `{ destination: ["country/KEN"] }`, or to what
   *  `client.lookup.resolve` returns, as `client.fetch` takes them. `origin` reads as the giving
   *  side and `destination` as the receiving side; `place` names no side. */
  readonly entities?: Readonly<Record<string, readonly EntityChoice[]>> | undefined;
  /** `"all"`, `"latest"` or `[startYear, endYear]`, as `client.fetch` takes it. */
  readonly window?: Window | undefined;
  /** Flow role keys, `origin` or `destination`, to answer member by member, such as
   *  `["origin"]` for one row per creditor. */
  readonly openRoles?: readonly string[] | undefined;
  /** The source to read the codes from, in words, such as "IDS", for a code two sources hold. */
  readonly source?: string | undefined;
};

/** The keys of a search by codes, which a question in words does not take. */
export const CODE_SEARCH_KEYS = [
  "codes",
  "variable",
  "entities",
  "window",
  "openRoles",
  "source",
] as const satisfies readonly (keyof CodeSearchOptions)[];

/** The `role_text` word each caller key posts; `place` posts none and is undirected. */
const ROLE_TEXT: Readonly<Record<string, string>> = { origin: "from", destination: "to" };

/** The warning Search gives a `time_text` it cannot read, which then reads every year. */
const TIME_TEXT_NOT_PARSED = "time_text_not_parsed";

type ParsedPart = ParsedInput["parts"][number];

/**
 * The parsed Search input for a search by codes: one separate part per code, each with the same
 * variable words, entities, years and source.
 *
 * @throws {InvalidRequestError} A key breaks its rule (`invalid_argument`), or `entities` holds
 *   a `Match` that did not resolve (`match_unresolved`).
 */
export function parsedInput(search: CodeSearchOptions): ParsedInput & { parts: ParsedPart[] } {
  // Read as unknown: a JavaScript caller's arguments need not hold the declared types.
  const given: { readonly [K in keyof CodeSearchOptions]?: unknown } = search;
  const codes = checkedCodes(given.codes);
  const words = textOf("variable", given.variable);
  const shared: Partial<ParsedPart> = {};
  if (given.entities !== undefined) shared.entities = parsedEntities(given.entities);
  if (given.window !== undefined) {
    const timeText = timeTextOf(given.window);
    if (timeText !== null) shared.time_text = timeText;
  }
  if (given.openRoles !== undefined) shared.open_roles = openRolesOf(given.openRoles);
  const source = textOf("source", given.source);
  if (source !== undefined) shared.sources = [{ text: source }];
  return {
    kind: "parsed",
    parts: codes.map((code) => ({
      variable_text: words ?? code,
      source_code: code,
      separate: true,
      ...shared,
    })),
  };
}

/**
 * The codes a search asks for, each without surrounding white space.
 *
 * @throws {InvalidRequestError} They are a string, not a non-empty array of non-empty strings,
 *   or name one code twice, compared upper-cased as Search compares them (`invalid_argument`).
 */
function checkedCodes(codes: unknown): string[] {
  if (typeof codes === "string") {
    throw invalid(
      `codes is an array of series codes; for one code pass [${JSON.stringify(codes)}].`,
    );
  }
  if (!Array.isArray(codes) || codes.length === 0) {
    throw invalid(
      `codes is an array of series codes, such as ["DT.TDS.DEGG.CD"], not ${shown(codes)}.`,
    );
  }
  const seen = new Set<string>();
  return codes.map((given: unknown) => {
    const code = typeof given === "string" ? given.trim() : "";
    if (code === "") {
      throw invalid(`codes holds ${shown(given)}; each code is a non-empty string.`);
    }
    if (seen.has(code.toUpperCase())) {
      throw invalid(
        `codes names ${JSON.stringify(code)} twice; Search reads codes upper-cased, so name ` +
          "each code once.",
      );
    }
    seen.add(code.toUpperCase());
    return code;
  });
}

/**
 * Refuses an answer to a search by codes that the client cannot read part by part: one whose
 * parts do not match the codes one to one, or that could not read the years the client sent.
 *
 * @throws {ContractError} Search answered with another number of parts than codes, or warned
 *   `time_text_not_parsed` (`contract_violation`).
 */
export function checkReply(
  parts: readonly Part[],
  warnings: readonly Notice[],
  codes: readonly string[],
): void {
  if (parts.length !== codes.length) {
    throw clientError("contract_violation", {
      detail:
        `Search answered ${codes.length} series codes with ${parts.length} parts; a search by ` +
        "codes reads one part per code.",
    });
  }
  const notices = [...warnings, ...parts.flatMap((part) => partFacts(part).warnings)];
  if (notices.some((notice) => notice.code === TIME_TEXT_NOT_PARSED)) {
    throw clientError("contract_violation", {
      detail:
        `Search could not read the years the client sent (${TIME_TEXT_NOT_PARSED}), so its ` +
        "answer would read every year.",
    });
  }
}

/** The series code a part was asked by, as Search restates the part; null when it names none. */
export function askedCode(part: Part): string | null {
  const { restatement } = part;
  const code = isRecord(restatement) ? text(restatement["source_code"]) : null;
  return code === "" ? null : code;
}

/**
 * The gap a definite part asked by `code` leaves when its reading is not that code's series
 * alone; null when it is, or when no code was asked. Every entry of the spec's
 * `resolved.stat_vars.source_codes` must be `code`, compared upper-cased as Search compares
 * codes, with `exact` true. A spec that lists no code is not known to be the code's series, so
 * it leaves a gap.
 */
export function codeGap(partIndex: number, part: Part, code: string | null): Gap | null {
  if (code === null || !isKnownPart(part) || part.status !== "definite") return null;
  const resolved: unknown = part.spec.resolved;
  const statVars = isRecord(resolved) ? resolved["stat_vars"] : undefined;
  const held = objects(isRecord(statVars) ? statVars["source_codes"] : undefined);
  const asked = code.toUpperCase();
  const exact = held.every(
    (entry) => text(entry["code"])?.toUpperCase() === asked && entry["exact"] === true,
  );
  if (held.length > 0 && exact) return null;
  const message =
    held.length === 0
      ? `Search's reading for series code ${JSON.stringify(code)} names no series code, so it ` +
        "may hold another series"
      : `Search's reading for series code ${JSON.stringify(code)} is not that series alone; it ` +
        `holds ${held.map(heldLine).join(", ")}`;
  return { partIndex, part, kind: "no_data", message, options: [] };
}

/** One held code as a gap names it, marked when it is not exact. */
function heldLine(entry: Readonly<Record<string, unknown>>): string {
  const shown = JSON.stringify(entry["code"] ?? null);
  return entry["exact"] === true ? shown : `${shown} (not exact)`;
}

function textOf(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  throw invalid(`${name} is non-empty text, not ${shown(value)}.`);
}

function roleKey(argument: string, key: string, keys: readonly string[]): string {
  if (keys.includes(key)) return key;
  throw invalid(`${argument} names ${JSON.stringify(key)}; its role keys are ${keys.join(", ")}.`);
}

/**
 * The parsed entities `entities` names, each pinned by its dcid, named by the entity's name where
 * it has one, and directed by its role.
 *
 * @throws {InvalidRequestError} `entities` is not an object of role keys to non-empty arrays of
 *   dcids or what `client.lookup.resolve` returns, as `client.fetch` reads it
 *   (`invalid_argument`); or it holds a `Match` that did not resolve (`match_unresolved`).
 */
function parsedEntities(entities: unknown): NonNullable<ParsedPart["entities"]> {
  if (!isRecord(entities)) {
    throw invalid(
      `entities is an object of role keys, such as { destination: ["country/KEN"] }, not ` +
        `${shown(entities)}.`,
    );
  }
  return Object.entries(entities).flatMap(([role, given]) => {
    roleKey("entities", role, Object.keys(ROLE_KEYS));
    if (given === null) {
      throw invalid(
        `entities.${role} is null; a search binds the roles it names, so leave the role out ` +
          "to leave it open.",
      );
    }
    const items: unknown[] = Array.isArray(given) ? given : [];
    // The same rule `client.fetch` reads a role by, so one form of `entities` serves both.
    const dcids = dcidsOf(items.map((item) => entityDcid(role, item)));
    if (dcids === undefined) {
      throw invalid(
        `entities.${role} is not a list of dcids; bind the role to a list such as ` +
          '["country/KEN"], or what client.lookup.resolve returns.',
      );
    }
    return dcids.map((dcid, at) => {
      const name = nameOf(items[at]);
      const roleText = ROLE_TEXT[role];
      return {
        text: name ?? dcid,
        dcid,
        ...(roleText === undefined ? {} : { role_text: roleText }),
      };
    });
  });
}

/** The name of an entity or a resolved match; null for a dcid. */
function nameOf(item: unknown): string | null {
  const entity = item instanceof Match ? item.entity : item;
  return entity instanceof Entity && entity.name ? entity.name : null;
}

/** The `time_text` a window posts, read by `client.fetch`'s window rule; null for `"all"`,
 *  which posts none. */
function timeTextOf(window: unknown): string | null {
  const scope = windowScope(window);
  if (scope["kind"] === "range")
    return `${String(scope["start_year"])} to ${String(scope["end_year"])}`;
  return scope["kind"] === "latest" ? "latest" : null;
}

function openRolesOf(openRoles: unknown): string[] {
  if (!Array.isArray(openRoles)) {
    throw invalid(
      `openRoles is an array of role keys, such as ["origin"], not ${shown(openRoles)}.`,
    );
  }
  return openRoles.map((key: unknown) =>
    roleKey("openRoles", typeof key === "string" ? key : String(key), FLOW_KEYS),
  );
}

function shown(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "an array";
  if (value === null || typeof value !== "object") return String(value);
  return "an object";
}
