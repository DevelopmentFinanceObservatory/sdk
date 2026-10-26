/**
 * The entity roles a spec takes: the keys `entities` narrows by.
 *
 * A spec's identity binds roles in `entities` and lists the flow roles it reads member by member
 * in `open_roles`, under the API's wire roles. A caller keys each role by its caller key from
 * `contract/rules/role-keys.json`: `place`, the place a measure is about, posted as the wire role
 * `observationAbout`, and the two flow directions `origin` and `destination`, posted as
 * themselves. A flow spec takes both directions whether it binds, opens or totals each, since a
 * direction absent from both lists reads as the total over it and binding it narrows the total
 * to its members.
 */
import { FLOW_KEYS, ROLE_KEYS } from "../generated/role-keys.ts";
import { clientError } from "./errors.ts";
import { isRecord } from "./json.ts";
import type { Spec } from "./ref.ts";

const CALLER_KEYS: ReadonlyMap<string, string> = new Map(
  Object.entries(ROLE_KEYS).map(([key, wire]) => [wire, key]),
);

/** The wire role a caller key posts as; a key the rule does not list posts as typed. */
export const wireRole = (key: string): string =>
  Object.hasOwn(ROLE_KEYS, key) ? ROLE_KEYS[key as keyof typeof ROLE_KEYS] : key;

/** The caller key of a wire role; a role the rule does not list keeps its name. */
export const callerKey = (wire: string): string => CALLER_KEYS.get(wire) ?? wire;

/**
 * The roles a spec takes, each to the dcids it binds, or null when it binds none: a flow
 * direction the spec reads member by member, or as a total. The keys are the caller keys
 * `entities` takes, in the spec's order, a flow spec's other direction last. A spec that names
 * no role gives `{}`.
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
    if (Array.isArray(dcids)) roles.set(callerKey(role), Object.freeze(dcids.map(String)));
  }
  const open = identity["open_roles"];
  for (const role of Array.isArray(open) ? open : []) {
    const key = typeof role === "string" ? callerKey(role) : undefined;
    if (key !== undefined && !roles.has(key)) roles.set(key, null);
  }
  if (FLOW_KEYS.some((key) => roles.has(key))) {
    for (const key of FLOW_KEYS) if (!roles.has(key)) roles.set(key, null);
  }
  return Object.freeze(Object.fromEntries(roles));
}
