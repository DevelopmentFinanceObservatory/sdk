/**
 * The parts of an answer that have a reading `fetch` builds, by index. The answer computes them
 * once, from its gaps, so `fetch`, `specs`, the printed answer and `choose` agree on which parts
 * are answered.
 */
import type { Answer } from "./answer.ts";

const ANSWERED = new WeakMap<Answer, ReadonlySet<number>>();

/** Records the parts of `answer` that have a reading. The answer's constructor calls it. */
export function recordAnswered(answer: Answer, answered: ReadonlySet<number>): void {
  ANSWERED.set(answer, answered);
}

/** Whether part `index` of `answer` has a reading that `fetch` builds. */
export function isAnswered(answer: Answer, index: number): boolean {
  return ANSWERED.get(answer)?.has(index) ?? false;
}
