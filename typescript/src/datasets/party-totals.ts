/**
 * Group totals a fetch left out of a dataset's rows, as a manifest's trace and a derived
 * manifest's roots name them and a saved file keeps them, and the text form's line counting them.
 */
import type { FetchedDerivedMember } from "./dataset.ts";
import { canonicalJson, compareCodePoints, isRecord, objects } from "../core/json.ts";
import { COLUMN_ROLE_KEYS } from "../generated/role-keys.ts";

/** One series whose rows kept an entry's totals, and the periods in which they stayed. */
export type KeptSeries = {
  /** Each column of the frame's grain other than the entry's role, `time_period` and
   *  `provenance`, such as `stat_var`, the other role columns, `unit` and `measurementMethod`,
   *  mapped to the cell the series holds there: a string, null, or a unit as a JSON object. */
  readonly series: Readonly<Record<string, unknown>>;
  /** The `time_period` values, sorted by code point, in which the series kept the totals. */
  readonly timePeriods: readonly string[];
};

/**
 * Group totals on one party role that a fetch left out of one member's rows. A fetch leaves
 * party totals out by default, so a sum over `value` counts each flow once. `partyTotals: true`
 * keeps them. DFO names what the cut dropped in the version's manifest, one entry per party role,
 * provenance and set of kept series and periods, and the dataset gathers those entries in member
 * order, then in the manifest's order. Two entries can share a role and a provenance. A derived
 * dataset's entries describe each reading its recipe ran on, in the order of its ref's roots.
 */
export type PartyTotalsLeftOut = {
  /** The spec of the member whose rows lost the totals, or for a derived dataset the reading's. */
  readonly specId: string;
  /** The party role, by DFO's column name, such as `financingProvider`. */
  readonly role: string;
  /** The key a caller names the role by in `entities`, `origin` or `destination`, or null for a
   *  column the client does not know. */
  readonly roleKey: string | null;
  /** The dcids of the totals left out, such as `DACCountriesTotal`. */
  readonly entities: readonly string[];
  /** The dataset whose rows lost the totals, or null for rows with no provenance, or when
   *  `everyProvenance` is true. */
  readonly provenance: string | null;
  /** Whether the totals left the rows of every dataset, as on a version DFO recorded before it
   *  named the provenance. */
  readonly everyProvenance: boolean;
  /** The series whose rows kept these totals, each with the periods where they stayed, in the
   *  manifest's order; empty when the totals left every series in every period. */
  readonly keptIn: readonly KeptSeries[];
};

/** A non-empty string. */
const isFilled = (value: unknown): value is string => typeof value === "string" && value !== "";

/** Compares two lists element by element with `compare`, a shorter prefix first. */
function compareLists<T>(
  a: readonly T[],
  b: readonly T[],
  compare: (x: T, y: T) => number,
): number {
  for (let index = 0; index < a.length && index < b.length; index += 1) {
    const order = compare(a[index]!, b[index]!);
    if (order !== 0) return order;
  }
  return Math.sign(a.length - b.length);
}

/** One series cell's sort key: its column, then null before a string before an object, then the
 *  string or the object's JCS text. */
type CellKey = readonly [column: string, kind: number, text: string];

const compareCellKeys = (a: CellKey, b: CellKey): number =>
  compareCodePoints(a[0], b[0]) || a[1] - b[1] || compareCodePoints(a[2], b[2]);

/** A `kept_in` item as `{series, timePeriods}` with its sort key, or null when it is no object of
 *  exactly a `series` object whose cells are strings, nulls or objects and `time_periods`, a
 *  non-empty list of non-empty strings sorted by code point, each once. */
function keptSeries(item: unknown): { kept: KeptSeries; key: CellKey[] } | null {
  if (!isRecord(item)) return null;
  const names = Object.keys(item);
  if (names.length !== 2 || !Object.hasOwn(item, "series")) return null;
  const { series, time_periods: periods } = item;
  if (!isRecord(series) || !Array.isArray(periods) || periods.length === 0) return null;
  if (
    !periods.every(
      (period: unknown, index) =>
        isFilled(period) &&
        (index === 0 || compareCodePoints(periods[index - 1] as string, period) < 0),
    )
  ) {
    return null;
  }
  const key: CellKey[] = [];
  for (const column of Object.keys(series).toSorted(compareCodePoints)) {
    const cell = series[column];
    if (cell === null) key.push([column, 0, ""]);
    else if (typeof cell === "string") key.push([column, 1, cell]);
    else if (isRecord(cell)) key.push([column, 2, canonicalJson(cell)]);
    else return null;
  }
  const kept = Object.freeze({
    series: Object.freeze(structuredClone(series)),
    timePeriods: Object.freeze([...(periods as string[])]),
  });
  return { kept, key };
}

/** The series a trace entry's `kept_in` lists: empty when it is absent, and null when it is no
 *  non-empty list of well-formed items in the contract's order, no two with the same series. */
function keptInOf(value: unknown): KeptSeries[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0) return null;
  const kept: KeptSeries[] = [];
  let previous: CellKey[] | null = null;
  for (const item of value) {
    const read = keptSeries(item);
    if (read === null) return null;
    if (previous !== null && compareLists(previous, read.key, compareCellKeys) >= 0) return null;
    kept.push(read.kept);
    previous = read.key;
  }
  return kept;
}

/**
 * One entry of a manifest's `trace.party_totals_left_out` as `{role, entities, provenance,
 * kept_in}`, where an absent `provenance` means every dataset's rows. It is null when the entry is
 * no object, its `role` is no non-empty string, its `entities` is no list of non-empty strings,
 * its `provenance` is neither absent, a string nor null, or its `kept_in` is neither absent nor a
 * well-formed list in the contract's order. Other keys are ignored.
 */
export function partyTotalsEntry(entry: unknown, specId: string): PartyTotalsLeftOut | null {
  if (!isRecord(entry)) return null;
  const { role, entities, provenance } = entry;
  if (!isFilled(role)) return null;
  if (!Array.isArray(entities) || !entities.every(isFilled)) return null;
  if (provenance !== undefined && provenance !== null && typeof provenance !== "string") {
    return null;
  }
  const keptIn = keptInOf(entry["kept_in"]);
  if (keptIn === null) return null;
  return Object.freeze({
    specId,
    role,
    roleKey: Object.hasOwn(COLUMN_ROLE_KEYS, role) ? (COLUMN_ROLE_KEYS[role] ?? null) : null,
    entities: Object.freeze([...entities]),
    provenance: provenance ?? null,
    everyProvenance: !Object.hasOwn(entry, "provenance"),
    keptIn: Object.freeze(keptIn),
  });
}

/** The entries a list of trace entries names for `specId`: none when `served` is no list, and a
 *  malformed entry is dropped while the entries beside it still read. */
function partyTotalsFrom(served: unknown, specId: string): PartyTotalsLeftOut[] {
  if (!Array.isArray(served)) return [];
  return served.flatMap((entry: unknown) => partyTotalsEntry(entry, specId) ?? []);
}

/**
 * The totals a manifest's `trace.party_totals_left_out` names for the member of `specId`. The
 * list is empty when the trace names none, as a trace that is no object or a member that is no
 * list does. A malformed entry is dropped while the entries beside it still read.
 */
export function partyTotalsOf(
  manifest: Readonly<Record<string, unknown>>,
  specId: string,
): PartyTotalsLeftOut[] {
  const trace = manifest["trace"];
  return partyTotalsFrom(isRecord(trace) ? trace["party_totals_left_out"] : undefined, specId);
}

/**
 * The totals each root's read left out, as a derived manifest's `roots[].party_totals_left_out`
 * names them, each entry under its root's spec id, in the order of the ref member's roots. Each
 * ref root pairs with the first manifest root of the same `spec_id` and `content_version` that no
 * earlier ref root took, and a manifest root that pairs with none names none. Empty against a
 * server older than the per-root report, and when the server could not read a root, so an empty
 * list leaves open whether the reads kept every total.
 */
export function rootPartyTotalsOf(
  member: Omit<FetchedDerivedMember, "data">,
): PartyTotalsLeftOut[] {
  const served = objects(member.manifest["roots"]);
  const taken = new Set<number>();
  return member.roots.flatMap(({ specId, contentVersion }) => {
    const index = served.findIndex(
      (root, at) =>
        !taken.has(at) && root["spec_id"] === specId && root["content_version"] === contentVersion,
    );
    if (index === -1) return [];
    taken.add(index);
    return partyTotalsFrom(served[index]!["party_totals_left_out"], specId);
  });
}

/** The text form's line counting the totals left out on each role, with the key a caller names
 *  it by where the client knows it, as
 *  `Party totals left out: 15 on financingProvider (origin) · data.partyTotalsLeftOut`. A derived
 *  dataset's line counts the totals its readings left out. */
export function partyTotalsLine(
  entries: readonly PartyTotalsLeftOut[],
  derived: boolean,
): string | undefined {
  const byRole = new Map<string, { roleKey: string | null; dcids: Set<string> }>();
  for (const { role, roleKey, entities } of entries) {
    const counted = byRole.get(role) ?? { roleKey, dcids: new Set<string>() };
    for (const entity of entities) counted.dcids.add(entity);
    byRole.set(role, counted);
  }
  if (byRole.size === 0) return undefined;
  const counts = [...byRole]
    .map(
      ([role, { roleKey, dcids }]) =>
        `${dcids.size.toLocaleString("en-GB")} on ${role}` +
        (roleKey === null ? "" : ` (${roleKey})`),
    )
    .join(", ");
  const label = derived ? "Party totals left out of the readings" : "Party totals left out";
  return `${label}: ${counts} · data.partyTotalsLeftOut`;
}
