/**
 * The nearest of a set of names to a word a caller gave, for a refusal's "did you mean".
 *
 * Both sides are folded first, by default to lower case, so `congo [drc]` meets `Congo [DRC]`
 * at distance 0. The nearest is the name at the smallest edit distance, a swap of two
 * neighbouring characters counting as one edit, the first listed on a tie, and only within a
 * third of the word's folded length, at least 1, so a word that resembles nothing suggests
 * nothing.
 */

/** Text in the form two names are compared in. */
export type Fold = (text: string) => string;

const lowerCase: Fold = (text) => text.toLowerCase();

/** The nearest of `names` to `word`, or undefined when none lies within reach. */
export function nearest(
  word: string,
  names: Iterable<string>,
  fold: Fold = lowerCase,
): string | undefined {
  const folded = fold(word);
  const reach = Math.max(1, Math.floor(folded.length / 3));
  let best: string | undefined;
  let bestDistance = reach + 1;
  for (const name of names) {
    const distance = editDistance(folded, fold(name));
    if (distance < bestDistance) {
      best = name;
      bestDistance = distance;
    }
  }
  return best;
}

/** The edit distance between two strings, by UTF-16 code unit: the fewest insertions,
 *  deletions, substitutions and swaps of two neighbours that turn one into the other. */
function editDistance(a: string, b: string): number {
  let before: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      let distance = Math.min(previous[j]! + 1, current[j - 1]! + 1, substitution);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        distance = Math.min(distance, before[j - 2]! + 1);
      }
      current.push(distance);
    }
    before = previous;
    previous = current;
  }
  return previous[b.length]!;
}
