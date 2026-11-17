/**
 * A candidates part's readings as `Candidate`s, which an answer's gap and a saved dataset's
 * `missing` both offer.
 */
import { isRecord, objects, text } from "./json.ts";
import { partFacts } from "./parse.ts";
import type { CandidatesPart, DefinitePart } from "./parts.ts";
import type { Candidate } from "../search/answer.ts";
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
