/** Writes a file's bytes to a path, replacing any file there. */
export type FileWriter = (path: string | URL, data: Uint8Array) => Promise<void>;

/** The installed writer, or none on a platform with no file system. */
let platformWriter: FileWriter | undefined;

/** The writer the platform entry point installs: the file system writer under the `node` export
 *  condition, else none. */
export const platformFileWriter = (): FileWriter | undefined => platformWriter;

/** Installs `writer`, or with undefined removes the installed one. */
export function installFileWriter(writer: FileWriter | undefined): void {
  platformWriter = writer;
}
