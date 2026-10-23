import { parseCredentialsFile, platformCredentialsFile } from "./credentials.ts";
import type { CredentialsFileReader } from "./credentials.ts";
import { readProcessEnv } from "./env.ts";
import type { EnvReader } from "./env.ts";
import { clientError } from "../core/errors.ts";

const SECRET_PREFIX = "dfo_k_";
const PUBLISHABLE_PREFIX = "dfo_p_";
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const CHECKSUM_LENGTH = 6;

/**
 * An API key. Printing, logging or serialising it shows a masked form. `reveal()` returns the
 * key itself.
 */
export class ApiKey {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The key itself. */
  reveal(): string {
    return this.#value;
  }

  /** The key's prefix and last four characters, for display. */
  get masked(): string {
    const prefix = [SECRET_PREFIX, PUBLISHABLE_PREFIX].find((p) => this.#value.startsWith(p)) ?? "";
    const rest = this.#value.slice(prefix.length);
    return rest.length > 8 ? `${prefix}…${rest.slice(-4)}` : `${prefix}…`;
  }

  toString(): string {
    return `ApiKey(${this.masked})`;
  }

  toJSON(): string {
    return this.toString();
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}

/** Why a key fails the format check. */
export type KeyFormatReason = "unknown_prefix" | "not_base62" | "checksum_mismatch";

export type KeyFormatVerdict = { verdict: "pass" } | { verdict: "warn"; reason: KeyFormatReason };

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

/** CRC32 (ISO-HDLC, as zlib computes it) of an ASCII string. */
function crc32(text: string): number {
  let crc = 0xffffffff;
  for (let index = 0; index < text.length; index += 1) {
    crc = CRC32_TABLE[(crc ^ text.charCodeAt(index)) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function base62(value: number): string {
  let digits = "";
  let rest = value;
  do {
    digits = BASE62[rest % 62]! + digits;
    rest = Math.floor(rest / 62);
  } while (rest > 0);
  return digits;
}

/**
 * Checks a key's prefix, characters and checksum, per `contract/rules/README.md`. A failure is
 * a warning. The client sends the key anyway, so a new key format forces no upgrade.
 */
export function checkKeyFormat(key: string): KeyFormatVerdict {
  const prefix = [SECRET_PREFIX, PUBLISHABLE_PREFIX].find((p) => key.startsWith(p));
  if (prefix === undefined) return { verdict: "warn", reason: "unknown_prefix" };
  const rest = key.slice(prefix.length);
  if (!/^[0-9A-Za-z]*$/.test(rest)) {
    return { verdict: "warn", reason: "not_base62" };
  }
  const body = rest.slice(0, -CHECKSUM_LENGTH);
  const checksum = rest.slice(-CHECKSUM_LENGTH);
  if (body === "" || base62(crc32(body)).padStart(CHECKSUM_LENGTH, "0") !== checksum) {
    return { verdict: "warn", reason: "checksum_mismatch" };
  }
  return { verdict: "pass" };
}

/** A key, a function returning one, or `false` to force anonymous use. */
export type ApiKeyOption =
  string | ApiKey | (() => string | ApiKey | Promise<string | ApiKey>) | false;

/** Where a resolved key came from. */
export type KeySource = "argument" | "environment" | "credentials_file" | "anonymous";

export type ResolvedKey = { source: KeySource; key: ApiKey | null };

const toKey = (value: string | ApiKey): ApiKey =>
  value instanceof ApiKey ? value : new ApiKey(value);

type KeyLookup = {
  apiKey?: ApiKeyOption | undefined;
  env?: EnvReader | undefined;
  readCredentialsFile?: CredentialsFileReader | undefined;
};

/** The key the `apiKey` argument gives. */
function argumentKey(value: string | ApiKey): ResolvedKey {
  const key = toKey(value);
  if (key.reveal() === "") {
    throw clientError("key_empty", {
      detail: "The apiKey argument is empty; pass a key, or false for anonymous use.",
    });
  }
  return { source: "argument", key };
}

/**
 * @internal Resolves the key by the lookup order in `contract/rules/README.md`, at once: the
 * `apiKey` argument, `DFO_API_KEY`, the credentials file's profile `$DFO_PROFILE` (else
 * `default`), then anonymous. A key function is called here, and only one that returns a promise
 * makes the result a promise. The file is read only when no earlier source wins. An empty
 * `DFO_API_KEY` reads as unset.
 *
 * @throws {AuthenticationError} As `resolveApiKey` raises it, synchronously.
 */
export function lookUpApiKey({
  apiKey,
  env = readProcessEnv,
  readCredentialsFile = platformCredentialsFile,
}: KeyLookup): ResolvedKey | Promise<ResolvedKey> {
  if (apiKey === false) return { source: "anonymous", key: null };
  if (typeof apiKey === "function") {
    const value = apiKey();
    return typeof value === "string" || value instanceof ApiKey
      ? argumentKey(value)
      : Promise.resolve(value).then(argumentKey);
  }
  if (apiKey !== undefined) return argumentKey(apiKey);

  const fromEnv = env("DFO_API_KEY");
  if (fromEnv !== undefined) return { source: "environment", key: new ApiKey(fromEnv) };

  const text = readCredentialsFile(env);
  if (text === null) return { source: "anonymous", key: null };
  const parsed = parseCredentialsFile(text);
  if (!parsed.ok) {
    throw clientError("credentials_file_invalid", {
      detail: `The credentials file is invalid at line ${parsed.line}: ${parsed.reason}.`,
    });
  }
  const named = env("DFO_PROFILE");
  const profileName = named ?? "default";
  const profile = parsed.profiles[profileName];
  if (profile === undefined) {
    if (named === undefined) return { source: "anonymous", key: null };
    throw clientError("profile_not_found", {
      detail: `The credentials file has no profile [${named}], which DFO_PROFILE names.`,
    });
  }
  const key = profile["key"];
  if (key === undefined || key === "") {
    throw clientError("profile_without_key", {
      detail: `The credentials file's profile [${profileName}] has no key.`,
    });
  }
  return { source: "credentials_file", key: new ApiKey(key) };
}

/**
 * Resolves the key by the lookup order in `contract/rules/README.md`: the `apiKey` argument,
 * `DFO_API_KEY`, the credentials file's profile `$DFO_PROFILE` (else `default`), then anonymous.
 * The file is read only when no earlier source wins. An empty `DFO_API_KEY` reads as unset.
 *
 * @throws {AuthenticationError} The argument is an empty key, the credentials file is invalid,
 *   `DFO_PROFILE` names a profile it lacks, or the chosen profile's key is missing or empty.
 */
export async function resolveApiKey(lookup: KeyLookup): Promise<ResolvedKey> {
  return lookUpApiKey(lookup);
}

/**
 * True when the code runs in a browser page or worker: a window with a document, or a dedicated,
 * shared or service worker, which all define `importScripts`. Server runtimes that borrow the
 * worker globals, such as Cloudflare's workerd, define no `importScripts`.
 */
export const inBrowser = (): boolean => {
  const scope = globalThis as { window?: { document?: unknown }; importScripts?: unknown };
  return typeof scope.window?.document !== "undefined" || typeof scope.importScripts === "function";
};

/**
 * Refuses a secret key in a browser page or worker unless the caller allows it, since the
 * script that holds it is delivered to every visitor.
 */
export function refuseSecretKeyInBrowser(
  key: string | ApiKey | null,
  dangerouslyAllowBrowser: boolean,
): void {
  if (key === null || dangerouslyAllowBrowser || !inBrowser()) return;
  if ((typeof key === "string" ? key : key.reveal()).startsWith(SECRET_PREFIX)) {
    throw new TypeError(
      "A secret dfo_k_ key in a browser page or worker is readable by every visitor. Call the " +
        "API from a server, or pass dangerouslyAllowBrowser: true to send it anyway.",
    );
  }
}
