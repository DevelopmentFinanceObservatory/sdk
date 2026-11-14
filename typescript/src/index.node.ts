// The entry point under the `node` export condition. It has the same surface as index.ts, with
// the credentials file read from the file system and `data.save(path)` writing to it. Other
// platforms have no file to read or write.
import { readCredentialsFile } from "./config/credentials-node.ts";
import { installCredentialsFileReader } from "./config/credentials.ts";
import { writeDatasetFile } from "./datasets/save-node.ts";
import { installFileWriter } from "./datasets/save.ts";

installCredentialsFileReader(readCredentialsFile);
installFileWriter(writeDatasetFile);

export * from "./index.ts";
