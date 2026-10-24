/** Search: a question in, an answer of what DFO understood out. */
import { resolveAnswer } from "./answer.ts";
import type { Answer, AnswerContext, SearchOptions } from "./answer.ts";
import { clientError } from "../core/errors.ts";

/**
 * Asks Search a question and returns what it understood, part by part.
 *
 * @throws {InvalidRequestError} The question is not a string, is empty or only whitespace, or
 *   holds a lone surrogate, which UTF-8 cannot encode (`invalid_argument`), before any request.
 * @throws {ContractError} The answer lacks a member the client acts on.
 */
export async function search(
  context: AnswerContext,
  question: string,
  options: SearchOptions = {},
): Promise<Answer> {
  if (typeof question !== "string" || question.trim() === "") {
    throw clientError("invalid_argument", {
      detail: `The question is ${JSON.stringify(question)}; ask Search a question in words.`,
    });
  }
  const surrogate = question.search(/\p{Cs}/u);
  if (surrogate !== -1) {
    throw clientError("invalid_argument", {
      detail: `The question holds a lone surrogate at position ${surrogate}, which UTF-8 cannot encode.`,
    });
  }
  return resolveAnswer(context, { kind: "raw_text", query: question }, { ...options, question });
}
