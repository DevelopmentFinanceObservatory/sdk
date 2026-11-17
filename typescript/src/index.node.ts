// The entry point under the `node` export condition. It has the same surface as index.ts, with
// the credentials file read from the file system, `data.save(path)` writing to it and
// `load(path)` reading from it. Other platforms have no file to read or write.
import { readCredentialsFile } from "./config/credentials-node.ts";
import { installCredentialsFileReader } from "./config/credentials.ts";
import { installFileReader } from "./datasets/load.ts";
import { readDatasetFile, writeDatasetFile } from "./datasets/save-node.ts";
import { installFileWriter } from "./datasets/save.ts";

installCredentialsFileReader(readCredentialsFile);
installFileWriter(writeDatasetFile);
installFileReader(readDatasetFile);

export * from "./index.ts";
