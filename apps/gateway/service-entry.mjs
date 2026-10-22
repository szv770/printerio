// Where the Windows Service launcher finds the TypeScript entry. Node's ESM import() needs a file:// URL: a plain
// Windows path ("C:\...") is rejected with ERR_UNSUPPORTED_ESM_URL_SCHEME ("Received protocol 'c:'").
import path from "node:path";
import { pathToFileURL } from "node:url";

export function entryUrl(here) {
  return pathToFileURL(path.join(here, "src", "index.ts")).href;
}
