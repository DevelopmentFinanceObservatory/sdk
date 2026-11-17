/**
 * A candidates part's readings as `Candidate`s, and a no_data part's choices as `Option`s, which
 * an answer's gap and a stored dataset's `missing` both offer, so a stored gap reads as the live
 * one.
 */
import { isRecord, objects, strings, text } from "./json.ts";
import { parsedInputOf, partFacts } from "./parse.ts";
import type { CandidatesPart, DefinitePart, NoDataPart } from "./parts.ts";
import type { Candidate, Option } from "../search/answer.ts";
import type { Assumption } from "../wire.ts";

const NO_ASSUMPTIONS: readonly Assumption[] = Object.freeze([]);

/** Each reading of a candidates part, with what Search assumed for it. */
export function candidatesOf(part: CandidatesPart): Candidate[] {
  const { readingAssumptions } = partFacts(part);
  return part.candidates.specs.map((spec) =>
    candidateFrom(spec, readingAssumptions.get(spec.spec_id) ?? NO_ASSUMPTIONS),
  );
}

/** A candidate from its full spec and what Search assumed for it. The label is the sentence's
 *  heading and the unit the byline's unit slot, so label, unit and source together say what the
 *  sentence says. */
function candidateFrom(spec: DefinitePart["spec"], assumptions: readonly Assumption[]): Candidate {
  const { resolved } = spec;
  const tokens = objects(resolved.sentence_plan);
  const heading = tokens
    .filter((token) => (text(token["segment"]) ?? "heading") === "heading")
    .map((token) => text(token["text"]) ?? "")
    .join("")
    .trim();
  const unit = tokens
    .filter(
      (token) =>
        token["segment"] === "byline" && token["kind"] === "slot" && token["axis"] === "unit",
    )
    .map((token) => text(token["text"]))
    .find(Boolean);
  const sentence = text(resolved.rendered_sentence);
  const facets: unknown = resolved.facets;
  const provenance = isRecord(facets) ? facets["provenance"] : undefined;
  return Object.freeze({
    kind: "candidate",
    spec,
    sentence,
    label: heading || sentence || null,
    source: isRecord(provenance) ? text(provenance["label"]) : null,
    unit: unit ?? null,
    assumptions,
  });
}

/** A refusal's choices, from `no_data.options`, read tolerantly. Each option's `data_query` is
 *  the input that settles it. */
export function queryOptions(noData: NoDataPart["no_data"]): Option[] {
  return objects(noData.options).map((option) => ({
    kind: "query",
    label: text(option["label"]) ?? "",
    mentions: strings(option["mentions"]),
    dataQuery: parsedInputOf(option["data_query"]),
    entityChoice: indexOf(option["entity_choice"]),
  }));
}

/** A non-negative JSON integer, or null for any other value. */
function indexOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
