/**
 * The `X-DFO-Client` header every API request carries, by the contract's client-identity rule
 * (`contract/rules/client-identity.json`): `dfo-ts/<version> (<runtime>)`, the runtime `Node`,
 * `Deno` or `Bun` with the major and minor of its version, `browser` in a browser page or
 * worker, and `other` in a runtime that reports none of those versions, such as Cloudflare
 * Workers without the `nodejs_compat` flag. Workers with it report Node.
 */

import { inBrowser } from "../config/keys.ts";
import { VERSION } from "../version.ts";

export const CLIENT_HEADER = "X-DFO-Client";

/** A runtime, with its full version when it is Node, Deno or Bun. */
export type Runtime =
  | { readonly name: "Node" | "Deno" | "Bun"; readonly version: string }
  | { readonly name: "browser" | "other" };

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
  return { name: inBrowser() ? "browser" : "other" };
}

/** The header's value for a version of the client in a runtime. */
export function clientIdentity(version: string, runtime: Runtime): string {
  if (!("version" in runtime)) return `dfo-ts/${version} (${runtime.name})`;
  const [major, minor = "0"] = runtime.version.split(".");
  return `dfo-ts/${version} (${runtime.name} ${major}.${minor})`;
}

/** The header's value this client sends where it runs. */
export const ownIdentity = (): string => clientIdentity(VERSION, currentRuntime());
