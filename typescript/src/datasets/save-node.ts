import { writeFile } from "node:fs/promises";

import type { FileWriter } from "./save.ts";

/** Writes the bytes to the path through the file system. */
export const writeDatasetFile: FileWriter = (path, data) => writeFile(path, data);
