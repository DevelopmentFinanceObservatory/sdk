// The entry point under the `node` export condition: the same surface as index.ts, with the
// credentials file read from the file system. Other platforms have no file to read.
import { readCredentialsFile } from "./credentials-node.ts";
import { installCredentialsFileReader } from "./credentials.ts";

installCredentialsFileReader(readCredentialsFile);

export * from "./index.ts";
