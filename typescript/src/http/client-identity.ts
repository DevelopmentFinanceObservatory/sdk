/**
 * The `X-DFO-Client` header every API request carries, by the contract's client-identity rule
 * (`contract/rules/client-identity.json`): `dfo-ts/<version> (<runtime>)`, the runtime `Node`,
 * `Deno` or `Bun` with the major and minor of its version, and `browser` in any other runtime.
 */

import { VERSION } from "../version.ts";

export const CLIENT_HEADER = "X-DFO-Client";

/** A runtime, with its full version unless it is a browser's. */
export type Runtime =
  | { readonly name: "Node" | "Deno" | "Bun"; readonly version: string }
  | {
      readonly name: "browser";
    };

/** The runtime this code runs in. Deno and Bun both report a Node version too, so they are
 *  asked first. */
export function currentRuntime(): Runtime {
  const scope = globalThis as {
    Deno?: { version?: { deno?: unknown } };
    process?: { versions?: { bun?: unknown; node?: unknown } };
  };
  const deno = scope.Deno?.version?.deno;
  if (typeof deno === "string") return { name: "Deno", version: deno };
  const versions = scope.process?.versions;
  if (typeof versions?.bun === "string") return { name: "Bun", version: versions.bun };
  if (typeof versions?.node === "string") return { name: "Node", version: versions.node };
  return { name: "browser" };
}

/** The header's value for a version of the client in a runtime. */
export function clientIdentity(version: string, runtime: Runtime): string {
  if (runtime.name === "browser") return `dfo-ts/${version} (browser)`;
  const [major, minor = "0"] = runtime.version.split(".");
  return `dfo-ts/${version} (${runtime.name} ${major}.${minor})`;
}

/** The header's value this client sends where it runs. */
export const ownIdentity = (): string => clientIdentity(VERSION, currentRuntime());
