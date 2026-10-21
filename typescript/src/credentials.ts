import type { EnvReader } from "./env.ts";

/** The platforms the credentials path rule distinguishes. */
export type Platform = "linux" | "macos" | "windows";

/** The credentials file's path, per `contract/rules/README.md`. */
export function credentialsPath({
  platform,
  home,
  env,
}: {
  platform: Platform;
  home: string;
  env: EnvReader;
}): string {
  const explicit = env("DFO_CREDENTIALS_FILE");
  if (explicit !== undefined) return explicit;
  if (platform === "windows") {
    const appData = env("APPDATA") ?? `${home}\\AppData\\Roaming`;
    return `${appData}\\dfo\\credentials.toml`;
  }
  const config = env("XDG_CONFIG_HOME") ?? `${home}/.config`;
  return `${config}/dfo/credentials.toml`;
}

/** Why a credentials file is refused. */
export type CredentialsFileErrorReason =
  "outside_table" | "duplicate_table" | "duplicate_key" | "invalid_line";

/** The profiles in a credentials file, each a map of entry names to values. */
export type CredentialsProfiles = Record<string, Record<string, string>>;

export type ParsedCredentialsFile =
  | { ok: true; profiles: CredentialsProfiles }
  | { ok: false; line: number; reason: CredentialsFileErrorReason };

const TABLE = /^\[([A-Za-z0-9_-]+)\]$/;
// eslint-disable-next-line no-control-regex -- the rule refuses control characters in a value
const ENTRY = /^([A-Za-z0-9_-]+)[ \t]*=[ \t]*"([^"\\\u0000-\u001f\u007f]*)"$/;

/** Parses the TOML subset of `[profile]` tables with `name = "value"` lines. */
export function parseCredentialsFile(text: string): ParsedCredentialsFile {
  const profiles: CredentialsProfiles = Object.create(null) as CredentialsProfiles;
  let open: Record<string, string> | undefined;
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.replace(/[ \t]*\r?[ \t]*$/, "").replace(/^[ \t]+/, "");
    const refuse = (reason: CredentialsFileErrorReason): ParsedCredentialsFile => ({
      ok: false,
      line: index + 1,
      reason,
    });
    if (line === "" || line.startsWith("#")) continue;
    const table = TABLE.exec(line);
    if (table !== null) {
      const name = table[1]!;
      if (Object.hasOwn(profiles, name)) return refuse("duplicate_table");
      open = Object.create(null) as Record<string, string>;
      profiles[name] = open;
      continue;
    }
    const entry = ENTRY.exec(line);
    if (entry === null) return refuse("invalid_line");
    if (open === undefined) return refuse("outside_table");
    const name = entry[1]!;
    if (Object.hasOwn(open, name)) return refuse("duplicate_key");
    open[name] = entry[2]!;
  }
  return { ok: true, profiles };
}

/** Reads the credentials file's text, or null when no file exists at the credentials path. It
 *  reads synchronously, since a client resolves its key when it is built. */
export type CredentialsFileReader = (env: EnvReader) => string | null;

/** The reader for platforms with no file system: there is never a file. */
export const noCredentialsFile: CredentialsFileReader = () => null;

let platformReader: CredentialsFileReader = noCredentialsFile;

/** The reader the platform entry point installs: the file system reader under the `node` export
 *  condition, else none. */
export const platformCredentialsFile: CredentialsFileReader = (env) => platformReader(env);

export function installCredentialsFileReader(reader: CredentialsFileReader): void {
  platformReader = reader;
}
