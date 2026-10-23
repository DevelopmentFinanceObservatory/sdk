/** Search: a question in, an answer of what DFO understood out. */
import { resolveAnswer } from "./answer.ts";
import type { Answer, AnswerContext, SearchOptions } from "./answer.ts";

/**
 * Asks Search a question and returns what it understood, part by part.
 *
 * @throws {ContractError} The answer lacks a member the client acts on.
 */
export function search(
  context: AnswerContext,
  question: string,
  options: SearchOptions = {},
): Promise<Answer> {
  return resolveAnswer(context, { kind: "raw_text", query: question }, { ...options, question });
}
