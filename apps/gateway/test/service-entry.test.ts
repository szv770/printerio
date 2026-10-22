// The Windows Service launcher imported its TypeScript entry with a plain path ("C:\..."), which Node's ESM loader
// rejects (ERR_UNSUPPORTED_ESM_URL_SCHEME, "Received protocol 'c:'"), so the service never started on a real
// Windows machine. The entry must be imported as a file:// URL.
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs next to the launcher, no types
import { entryUrl } from "../service-entry.mjs";

describe("service entry URL", () => {
  it("is a file:// URL ending in src/index.ts", () => {
    const here = path.resolve("some", "install dir", "apps", "gateway");
    const url: string = entryUrl(here);
    expect(url.startsWith("file:///")).toBe(true);
    expect(url.endsWith("/src/index.ts")).toBe(true);
    // The space in the folder name ("MLM Office" on the real server) is encoded, never left raw.
    expect(url).toContain("install%20dir");
  });
});
