/**
 * How an answer reads: its text, the hints under its sentence, and its incomplete-answer
 * message, which lists every gap and the call that settles it.
 */
import { definiteParts, partSentence } from "./answer.ts";
import type { Answer, Candidate, Gap } from "./answer.ts";
import { objects, text } from "./json.ts";
import { partText } from "./parts.ts";

const SHOWN_SEVERITIES = new Set(["warn", "degraded"]);

const DECLINED_REASONS: Readonly<Record<string, string>> = {
  out_of_scope:
    "Search declined the question: it asks for no published statistic about a place, a " +
    "population or a financial flow.",
  requires_analysis:
    "Search declined the question: it asks for an argument and names no data to show.",
};
const CATALOGUE =
  "Search answered with the catalogue: the question asks what DFO holds and names no indicator.";

export type Hint = { readonly code: string; readonly line: string };

/**
 * How the answered parts differ from the question: each computation Search did not run, each
 * `warn` and `degraded` warning of the answer and its answered parts and, with `departures`, each
 * departure. Search's sentence already closes with the departures, so the display leaves them
 * out. `info` warnings stay hidden.
 */
export function readingHints(answer: Answer, { departures }: { departures: boolean }): Hint[] {
  const found = new Map<string, string>();
  const add = (line: string, code: string): void => {
    if (!found.has(line)) found.set(line, code);
  };
  const field = (item: Record<string, unknown>, name: string): string => text(item[name]) ?? "";
  const addNotices = (warnings: unknown): void => {
    for (const warning of objects(warnings)) {
      const message = field(warning, "message");
      if (SHOWN_SEVERITIES.has(field(warning, "severity")) && message) {
        add(`Note: ${message}`, field(warning, "code"));
      }
    }
  };
  for (const part of definiteParts(answer.parts)) {
    for (const operation of objects(part.operations)) {
      const verb = field(operation, "verb");
      add(`Not done: ${verb} (${JSON.stringify(field(operation, "phrase"))})`, verb);
    }
    if (departures) {
      for (const departure of objects(part.departures)) {
        add(field(departure, "text"), field(departure, "code"));
      }
    }
    addNotices(part.warnings);
  }
  addNotices(answer.warnings);
  return [...found].map(([line, code]) => ({ code, line }));
}

/** The answer as a reader sees it: the sentence and its hints, or what is missing. */
export function answerText(answer: Answer): string {
  if (answer.kind !== "resolution") return declinedText(answer.kind, answer.reason);
  if (answer.complete) {
    const hints = readingHints(answer, { departures: false });
    return [answer.sentence ?? "", ...hints.map((hint) => `  ${hint.line}`)].join("\n");
  }
  return [answered(answer, "Answered"), ...gapLines(answer)].join("\n");
}

/** Why Search gave a declined or catalogue answer, which holds no readings. */
export function declinedText(kind: string, reason: string | null): string {
  if (kind === "catalogue") return CATALOGUE;
  if (kind === "declined") {
    return (
      DECLINED_REASONS[reason ?? ""] ??
      `Search declined the question (${reason ?? "no reason given"}).`
    );
  }
  return `Search answered with kind ${JSON.stringify(kind)}, which holds no readings.`;
}

/** The `IncompleteAnswerError` message: every gap and the call that settles it. */
export function incompleteMessage(answer: Answer): string {
  return [answered(answer, "Search answered"), ...gapLines(answer)].join("\n");
}

const quote = (value: string | null | undefined): string => JSON.stringify(value ?? "");

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

function answered(answer: Answer, lead: string): string {
  const count = definiteParts(answer.parts).length;
  return `${lead} ${count} of ${plural(answer.parts.length, "part")} of your question.`;
}

function gapLines(answer: Answer): string[] {
  const gaps = new Map(answer.gaps.map((gap) => [gap.partIndex, gap]));
  const lines: string[] = [];
  for (const [index, part] of answer.parts.entries()) {
    const name = quote(partText(part));
    const gap = gaps.get(index);
    if (gap === undefined) {
      lines.push(`  answered ${name}: ${partSentence(part) ?? ""}`.trimEnd());
      continue;
    }
    lines.push(`  missing  ${name}: ${gap.message}`);
    for (const [number, option] of gap.options.entries()) {
      lines.push(
        `    [${number}] ${option.kind === "candidate" ? candidateLine(option) : option.label}`,
      );
    }
  }
  for (const gap of answer.gaps) {
    const call = chooseCall(answer, gap);
    if (call !== null) lines.push(`  Choose: (await ${call}).fetch()`);
  }
  const count = definiteParts(answer.parts).length;
  if (count > 0) {
    lines.push(
      `  Or take the answered ${count === 1 ? "part" : "parts"}: answer.fetch({ partial: true })`,
    );
  }
  return lines;
}

function candidateLine(candidate: Candidate): string {
  const label = (candidate.label || candidate.sentence || "").replace(/\.+$/, "");
  return [label, candidate.source, candidate.unit].filter(Boolean).join(" · ");
}

/** The call that settles a gap with its first choice, or null when none can. */
function chooseCall(answer: Answer, gap: Gap): string | null {
  const first = gap.options[0];
  if (first === undefined) return null;
  if (first.kind === "candidate") {
    return answer.parts.length === 1
      ? "answer.choose(0)"
      : `answer.choose(${partKey(answer, gap)}, 0)`;
  }
  return `answer.choose(${optionKey(answer, gap, first.mentions)}, ${quote(first.label)})`;
}

/** The part's words when they name it alone, else its index. */
function partKey(answer: Answer, gap: Gap): string {
  const words = partText(gap.part);
  const named = answer.parts.filter((part) => partText(part) === words);
  return words !== null && words !== "" && named.length === 1
    ? quote(words)
    : String(gap.partIndex);
}

/** The word the first option settles when it names the part alone, else the part's key. */
function optionKey(answer: Answer, gap: Gap, mentions: readonly string[]): string {
  const mention = mentions[0];
  if (mention !== undefined) {
    const elsewhere =
      answer.parts.some((part) => partText(part) === mention) ||
      answer.gaps.some(
        (other) =>
          other.partIndex !== gap.partIndex &&
          other.options.some(
            (option) => option.kind === "query" && option.mentions.includes(mention),
          ),
      );
    if (!elsewhere) return quote(mention);
  }
  return partKey(answer, gap);
}
