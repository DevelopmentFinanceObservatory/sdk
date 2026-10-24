import { readFileSync } from "node:fs";
import { homedir } from "node:os";

import { credentialsPath } from "./credentials.ts";
import type { CredentialsFileReader, Platform } from "./credentials.ts";
import { clientError } from "../core/errors.ts";

const platform = (): Platform =>
  process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";

/** The names of the errors Deno raises when it refuses a read, as it does without
 *  `--allow-read`. */
const REFUSED = new Set(["PermissionDenied", "NotCapable"]);

/**
 * Reads the credentials file from the file system at the credentials path.
 *
 * @throws {AuthenticationError} A file is there but cannot be read, such as one without read
 *   permission, a directory, a symlink loop or a path through a regular file
 *   (`credentials_file_unreadable`).
 */
export const readCredentialsFile: CredentialsFileReader = (env) => {
  const path = credentialsPath({ platform: platform(), home: homedir(), env });
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
    // No file is there, or the runtime refuses the read. A path through a regular file
    // (`ENOTDIR`) is unreadable.
    if (code === "ENOENT" || (error instanceof Error && REFUSED.has(error.name))) return null;
    throw clientError("credentials_file_unreadable", {
      detail:
        `The credentials file at ${JSON.stringify(path)} cannot be read ` +
        `(${typeof code === "string" ? code : "unknown error"}).`,
      cause: error,
    });
  }
};
