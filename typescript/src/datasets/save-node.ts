import { readFile, writeFile } from "node:fs/promises";

import type { FileReader } from "./load.ts";
import type { FileWriter } from "./save.ts";

/** Writes the bytes to the path through the file system. */
export const writeDatasetFile: FileWriter = (path, data) => writeFile(path, data);

/** Reads the file at the path through the file system. */
export const readDatasetFile: FileReader = (path) => readFile(path);
