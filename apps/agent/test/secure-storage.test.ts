import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveCredentials, loadCredentials, clearCredentials } from "../src/secure-storage.js";
import { createLogger } from "../src/logger.js";

const logger = createLogger({ level: "error" });

// This sandbox has no Windows machine, so these tests exercise the
// non-Windows fallback path only (process.platform !== "win32" here) - the
// DPAPI path (secure-storage.ts) is untested by this suite; see README
// "Testing status".
describe("secure-storage (fallback encrypted-file path)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "printos-agent-secure-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips credentials through save/load", async () => {
    await saveCredentials(dir, { agentId: "agent-1", deviceSecret: "super-secret-value", organizationId: "org-1" }, logger);
    const loaded = await loadCredentials(dir, logger);
    expect(loaded).toEqual({ agentId: "agent-1", deviceSecret: "super-secret-value", organizationId: "org-1" });
  });

  it("never writes the plaintext device secret into the on-disk credentials file", async () => {
    await saveCredentials(dir, { agentId: "agent-1", deviceSecret: "super-secret-value", organizationId: "org-1" }, logger);
    const { readFileSync, readdirSync } = await import("node:fs");
    const files = readdirSync(dir);
    for (const f of files) {
      const contents = readFileSync(path.join(dir, f), "utf8");
      expect(contents).not.toContain("super-secret-value");
    }
  });

  it("returns null when nothing has been saved yet", async () => {
    const loaded = await loadCredentials(dir, logger);
    expect(loaded).toBeNull();
  });

  it("clearCredentials removes the stored file so a subsequent load returns null", async () => {
    await saveCredentials(dir, { agentId: "a", deviceSecret: "s" }, logger);
    clearCredentials(dir);
    const loaded = await loadCredentials(dir, logger);
    expect(loaded).toBeNull();
  });
});
