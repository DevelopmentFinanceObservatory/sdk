/**
 * `load(path)`: reading a saved dataset from a file, on a platform whose entry point installs a
 * file reader. Under the `node` export condition that is the file system; elsewhere there is no
 * file to read, and `Dataset.fromBytes` reads the file's bytes.
 */
import { datasetAt } from "./dataset.ts";
import type { Dataset } from "./dataset.ts";
import { clientError } from "../core/errors.ts";

/** Reads a file's bytes from a path. */
export type FileReader = (path: string | URL) => Promise<Uint8Array>;

/** The installed reader, or none on a platform with no file system. */
let platformReader: FileReader | undefined;

/** Installs `reader`, or with undefined removes the installed one. */
export function installFileReader(reader: FileReader | undefined): void {
  platformReader = reader;
}

/**
 * Reads the dataset in the file at `path`, as `data.save(path)` or Python's `data.save` wrote
 * it, with its rows, provenance and ref, on Node. It reads the file whole and returns what
 * `Dataset.fromBytes` returns for its bytes.
 *
 * @throws {InvalidRequestError} The runtime has no file system, as in a browser, where
 *   `Dataset.fromBytes(bytes)` reads the file's bytes, or `path` is neither a string nor a URL
 *   (`invalid_argument`).
 * @throws {BundleError} The file is no Parquet file, such as a bundle downloaded from the
 *   website, which the Python client's `dfo.load` opens; a damaged one; or one without a saved
 *   dataset's `dfo.*` keys (`not_a_bundle`).
 * @throws {FormatError} The file's `dfo.*` keys break the saved format, as `Dataset.fromBytes`
 *   throws.
 */
export async function load(path: string | URL): Promise<Dataset> {
  const read = platformReader;
  if (read === undefined) {
    throw clientError("invalid_argument", {
      detail:
        "load(path) reads files on Node alone; here, Dataset.fromBytes(bytes) reads the file's bytes.",
    });
  }
  if (typeof path !== "string" && !(path instanceof URL)) {
    throw clientError("invalid_argument", {
      detail: `load takes a path as a string or a URL, not ${(path as unknown) === null ? "null" : typeof path}.`,
    });
  }
  return datasetAt(await read(path), String(path));
}
