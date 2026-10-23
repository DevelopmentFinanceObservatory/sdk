import { readFileSync } from "node:fs";
import { homedir } from "node:os";

import { credentialsPath } from "./credentials.ts";
import type { CredentialsFileReader, Platform } from "./credentials.ts";
import { clientError } from "../core/errors.ts";

const platform = (): Platform =>
  process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";

/** Errors that mean no readable file is there: none exists, a parent is not a directory, or the
 *  runtime refuses the read, as Deno does without `--allow-read`. */
const ABSENT = new Set(["ENOENT", "ENOTDIR"]);
const REFUSED = new Set(["PermissionDenied", "NotCapable"]);

/**
 * Reads the credentials file from the file system at the credentials path.
 *
 * @throws {AuthenticationError} A file is there but cannot be read, such as one without read
 *   permission, a directory or a symlink loop (`credentials_file_unreadable`).
 */
export const readCredentialsFile: CredentialsFileReader = (env) => {
  const path = credentialsPath({ platform: platform(), home: homedir(), env });
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
    if (typeof code === "string" && ABSENT.has(code)) return null;
    if (error instanceof Error && REFUSED.has(error.name)) return null;
    throw clientError("credentials_file_unreadable", {
      detail:
        `The credentials file at ${JSON.stringify(path)} cannot be read ` +
        `(${typeof code === "string" ? code : "unknown error"}).`,
      cause: error,
    });
  }
};
