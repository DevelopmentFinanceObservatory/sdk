import { readFileSync } from "node:fs";
import { homedir } from "node:os";

import { credentialsPath } from "./credentials.ts";
import type { CredentialsFileReader, Platform } from "./credentials.ts";

const platform = (): Platform =>
  process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";

/** Errors that mean no readable file is there: none exists, a parent is not a directory, or the
 *  runtime refuses the read, as Deno does without `--allow-read`. */
const ABSENT = new Set(["ENOENT", "ENOTDIR"]);
const REFUSED = new Set(["PermissionDenied", "NotCapable"]);

/** Reads the credentials file from the file system at the credentials path. */
export const readCredentialsFile: CredentialsFileReader = (env) => {
  try {
    return readFileSync(credentialsPath({ platform: platform(), home: homedir(), env }), "utf8");
  } catch (error) {
    if (error instanceof Error) {
      const { code } = error as { code?: unknown };
      if (typeof code === "string" && ABSENT.has(code)) return null;
      if (REFUSED.has(error.name)) return null;
    }
    throw error;
  }
};
