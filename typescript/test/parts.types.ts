// Checked by `pnpm typecheck` and never run. An answer's part types the members the client checks
// and leaves every other wire member `unknown`, so each `@ts-expect-error` line reads an unchecked
// member as its wire type and the check fails if the part types ever claim it again.
import type {
  CandidatesPart,
  DefinitePart,
  NoDataPart,
  Part,
  UnsupportedPart,
} from "../src/types.ts";
import type { Client, Spec } from "../src/index.ts";
import type { STRICT_SCHEMAS } from "../src/generated/strict.ts";
import type * as Wire from "../src/wire.ts";

/** True when the two types are the same. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Compiles only for `true`. */
type Holds<T extends true> = T;

/** The members a part names, its index signature left out. */
type Typed<T> = keyof {
  [Member in keyof T as string extends Member ? never : Member]: T[Member];
};
type Strict<Schema extends keyof typeof STRICT_SCHEMAS> =
  keyof (typeof STRICT_SCHEMAS)[Schema]["required"];

// The typed members are exactly the ones `contract/strict-fields.json` lists.
export type StrictMembersTyped = [
  Holds<Same<Typed<DefinitePart>, Strict<"DefinitePart">>>,
  Holds<Same<Typed<CandidatesPart>, Strict<"CandidatesPart">>>,
  Holds<Same<Typed<CandidatesPart["candidates"]>, Strict<"CandidateSet">>>,
  Holds<Same<Typed<NoDataPart>, Strict<"NoDataPart">>>,
  Holds<Same<Typed<NoDataPart["no_data"]>, Strict<"NoData">>>,
  Holds<Same<Typed<UnsupportedPart>, Strict<"UnsupportedPart">>>,
  Holds<Same<Typed<UnsupportedPart["unsupported"]>, Strict<"Unsupported">>>,
  Holds<Same<Typed<DefinitePart["spec"]>, Strict<"Spec">>>,
  Holds<Same<Typed<DefinitePart["spec"]["definition"]>, Strict<"SpecDefinition">>>,
  Holds<Same<CandidatesPart["candidates"]["specs"][number], DefinitePart["spec"]>>,
];

export function specMembers(part: DefinitePart): unknown[] {
  const { spec } = part;
  const checked: [string, string, Readonly<Record<string, unknown>>] = [
    spec.spec_id,
    spec.definition.spec_id,
    spec.definition.identity,
  ];
  // @ts-expect-error A spec's identity is checked only as an object.
  const identity: Wire.Spec["definition"]["identity"] = spec.definition.identity;
  // @ts-expect-error The members of a spec's resolved reading are unchecked.
  const resolved: Wire.ResolvedSpec = spec.resolved;
  // @ts-expect-error A spec's StatVars are unchecked.
  const statVars: Wire.ResolvedSpec["stat_vars"] = spec.resolved.stat_vars;
  // @ts-expect-error A spec's coverage is unchecked.
  const coverage: Wire.ResolvedSpec["coverage"] = spec.resolved.coverage;
  // @ts-expect-error A spec's facets are unchecked.
  const facets: Wire.ResolvedSpec["facets"] = spec.resolved.facets;
  // @ts-expect-error A spec's entity groups are unchecked.
  const groups: Wire.ResolvedSpec["entity_groups"] = spec.resolved.entity_groups;
  // @ts-expect-error A spec's sentence is unchecked.
  const sentence: Wire.ResolvedSpec["rendered_sentence"] = spec.resolved.rendered_sentence;
  return [checked, identity, resolved, statVars, coverage, facets, groups, sentence];
}

// What an answer holds fetches as it is, and its specs leave `resolved` unchecked too.
export async function fetched(client: Client, part: DefinitePart): Promise<unknown[]> {
  const answer = await client.search("aid to Kenya");
  const spec: Spec = answer.specs[0]!;
  // @ts-expect-error The members of an answer spec's resolved reading are unchecked.
  const coverage: Wire.ResolvedSpec["coverage"] = spec.resolved?.coverage;
  return [await client.fetch(part.spec), await client.fetch(spec), coverage];
}

export function unchecked(part: Part): unknown[] {
  if (part.status !== "definite" && part.status !== "candidates") return [];
  // @ts-expect-error A part's assumptions are unchecked; answer.facts holds the read ones.
  const assumptions: readonly Wire.Assumption[] | undefined = part.assumptions;
  // @ts-expect-error A part's departures are unchecked.
  const departures: readonly Wire.Departure[] | undefined = part.departures;
  // @ts-expect-error A part's operations are unchecked.
  const operations: readonly Wire.RequestedOperation[] | undefined = part.operations;
  // @ts-expect-error A part's warnings are unchecked.
  const warnings: readonly Wire.Warning[] | undefined = part.warnings;
  // @ts-expect-error A part's variable text is unchecked.
  const variableText: string | null | undefined = part.variable_text;
  return [assumptions, departures, operations, warnings, variableText];
}

export function nested(part: CandidatesPart | NoDataPart | UnsupportedPart): unknown[] {
  if (part.status === "candidates") {
    const specs: readonly Spec[] = part.candidates.specs;
    // @ts-expect-error A candidate set's specs are not the wire type.
    const wireSpecs: readonly Wire.Spec[] = part.candidates.specs;
    // @ts-expect-error A candidate set's truncated flag is unchecked.
    const truncated: boolean = part.candidates.truncated;
    return [specs, wireSpecs, truncated];
  } else if (part.status === "no_data") {
    const reason: string = part.no_data.reason;
    // @ts-expect-error A refusal's message is unchecked.
    const message: string | null | undefined = part.no_data.message;
    return [reason, message];
  } else {
    const code: string = part.unsupported.code;
    // @ts-expect-error An unsupported part's detail is unchecked.
    const detail: string = part.unsupported.detail;
    return [code, detail];
  }
}

// The wire types keep their schema types for those who read the raw response.
export const wireAssumptions = (part: Wire.DefinitePart): Wire.Assumption[] | undefined =>
  part.assumptions;
