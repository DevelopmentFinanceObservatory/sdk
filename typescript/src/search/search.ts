/** Search: a question, or publisher series codes, in; an answer of what DFO understood out. */
import { resolveAnswer, SEARCH_OPTIONS } from "./answer.ts";
import type { Answer, AnswerContext, SearchOptions } from "./answer.ts";
import { CODE_SEARCH_KEYS, parsedInput } from "./structured.ts";
import type { CodeSearchOptions } from "./structured.ts";
import { clientError } from "../core/errors.ts";
import { isRecord, present } from "../core/json.ts";
import { checkOptions, declareOptions } from "../core/options.ts";

/** The keys a search by codes takes. */
const CODE_SEARCH_OPTIONS = declareOptions<CodeSearchOptions>("client.search", {
  codes: true,
  variable: true,
  entities: true,
  window: true,
  openRoles: true,
  source: true,
  signal: true,
  timeout: true,
});

/**
 * Asks Search a question, or for publisher series codes, and returns what it understood, part
 * by part.
 *
 * @throws {InvalidRequestError} The question is not a string, is empty or only whitespace, or
 *   holds a lone surrogate, which UTF-8 cannot encode; a question comes with a key of a search
 *   by codes; a search by codes breaks a key's rule; or the options hold a key the call does not
 *   take (`invalid_argument`), before any request.
 * @throws {ContractError} The answer lacks a member the client acts on; or a search by codes is
 *   answered with another number of parts than codes, or Search could not read the years sent
 *   (`contract_violation`).
 */
export async function search(
  context: AnswerContext,
  question: string | CodeSearchOptions,
  options?: SearchOptions,
): Promise<Answer> {
  if (isRecord(question)) {
    if (options !== undefined) {
      throw clientError("invalid_argument", {
        detail:
          "A search by codes takes one object; put signal and timeout beside codes: " +
          "client.search({ codes: [...], timeout: ... }).",
      });
    }
    return searchCodes(context, question);
  }
  if (typeof question !== "string" || question.trim() === "") {
    throw clientError("invalid_argument", {
      detail:
        `The question is ${JSON.stringify(question)}; ask Search a question in words, or ` +
        "for series codes with client.search({ codes: [...] }).",
    });
  }
  const surrogate = question.search(/\p{Cs}/u);
  if (surrogate !== -1) {
    throw clientError("invalid_argument", {
      detail: `The question holds a lone surrogate at position ${surrogate}, which UTF-8 cannot encode.`,
    });
  }
  // A key of a search by codes set to undefined is absent, as None is to the Python client.
  const keys: Readonly<Record<string, unknown>> = isRecord(options) ? options : {};
  const given = CODE_SEARCH_KEYS.filter((key) => keys[key] !== undefined);
  const unset = new Set<string>(
    CODE_SEARCH_KEYS.filter((key) => key in keys && !given.includes(key)),
  );
  if (given.length > 0) {
    throw clientError("invalid_argument", {
      detail:
        "client.search takes a question in words or series codes, not both; Search does not " +
        `read a question beside ${listed(given)}. Name the places and years in the keys: ` +
        "client.search({ codes: [...], entities: ..., window: ... }).",
    });
  }
  const call = checkOptions(
    SEARCH_OPTIONS,
    isRecord(options) && unset.size > 0
      ? Object.fromEntries(Object.entries(options).filter(([key]) => !unset.has(key)))
      : options,
  );
  return resolveAnswer(context, { kind: "raw_text", query: question }, { ...call, question });
}

/**
 * @throws {InvalidRequestError} A key of the search breaks its rule, `codes` is missing, or the
 *   object holds a key a search by codes does not take (`invalid_argument`).
 */
async function searchCodes(context: AnswerContext, search: CodeSearchOptions): Promise<Answer> {
  const checked = checkOptions(CODE_SEARCH_OPTIONS, search);
  const { signal, timeout, ...keys } = checked;
  // Read as unknown: a JavaScript caller can leave `codes` out.
  const asked: { readonly codes?: unknown } = keys;
  if (asked.codes === undefined) {
    const given = Object.entries(keys).flatMap(([key, value]) =>
      value === undefined ? [] : [key],
    );
    throw clientError("invalid_argument", {
      detail:
        given.length === 0
          ? "client.search takes a question in words, or series codes: " +
            "client.search({ codes: [...] })."
          : `${listed(given)} ${given.length === 1 ? "qualifies" : "qualify"} the series ` +
            "codes a search asks for; pass codes: [...], or ask a question in words.",
    });
  }
  const input = parsedInput(checked);
  const codes = input.parts.map((part) => part.source_code ?? "");
  return resolveAnswer(context, input, { ...present({ signal, timeout }), question: null, codes });
}

/** Names as a sentence lists them: `a`, `a and b`, `a, b and c`. */
function listed(names: readonly string[]): string {
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`;
}
