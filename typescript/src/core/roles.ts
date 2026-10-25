/**
 * The entity roles a spec takes: the keys `entities` narrows by.
 *
 * A spec's identity binds roles in `entities` and lists the flow roles it reads member by member
 * in `open_roles`. The API's roles are `observationAbout`, the place a measure is about, and the
 * two flow directions `origin` and `destination`. A flow spec takes both directions whether it
 * binds, opens or totals each, since a direction absent from both lists reads as the total over
 * it and binding it narrows the total to its members.
 */
import { clientError } from "./errors.ts";
import { isRecord } from "./json.ts";
import type { Spec } from "./ref.ts";

/** The flow directions, the API's `RoleAxis`. A spec that names one takes both. */
const FLOW_ROLES = ["origin", "destination"] as const;

/**
 * The roles a spec takes, each to the dcids it binds, or null when it binds none: a flow
 * direction the spec reads member by member, or as a total. The keys are the ones `entities`
 * takes, in the spec's order, a flow spec's other direction last. A spec that names no role
 * gives `{}`.
 *
 * ```ts
 * specRoles(answer.specs[0]); // { destination: ["country/ETH"], origin: null }
 * ```
 *
 * @throws {InvalidRequestError} `spec` is not an object with a `definition` object
 *   (`invalid_argument`).
 */
export function specRoles(spec: Spec): Readonly<Record<string, readonly string[] | null>> {
  const definition: unknown = isRecord(spec) ? spec.definition : undefined;
  if (!isRecord(definition)) {
    throw clientError("invalid_argument", {
      detail: "specRoles takes a spec with its definition, such as answer.specs[0].",
    });
  }
  const identity = isRecord(definition["identity"]) ? definition["identity"] : {};
  const roles = new Map<string, readonly string[] | null>();
  const entities = identity["entities"];
  for (const [role, dcids] of Object.entries(isRecord(entities) ? entities : {})) {
    if (Array.isArray(dcids)) roles.set(role, Object.freeze(dcids.map(String)));
  }
  const open = identity["open_roles"];
  for (const role of Array.isArray(open) ? open : []) {
    if (typeof role === "string" && !roles.has(role)) roles.set(role, null);
  }
  if (FLOW_ROLES.some((role) => roles.has(role))) {
    for (const role of FLOW_ROLES) if (!roles.has(role)) roles.set(role, null);
  }
  return Object.freeze(Object.fromEntries(roles));
}
