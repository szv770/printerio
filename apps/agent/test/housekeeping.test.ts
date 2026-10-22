import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pruneOldFiles } from "../src/housekeeping.js";
import { createLogger, MAX_LOG_FILE_BYTES } from "../src/logger.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "printio-hk-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function touch(name: string, ageMs: number): string {
  const p = path.join(dir, name);
  writeFileSync(p, "x");
  const t = new Date(Date.now() - ageMs);
  utimesSync(p, t, t);
  return p;
}

describe("pruneOldFiles", () => {
  it("removes only files older than the cutoff that match the filter", () => {
    const oldPdf = touch("old.pdf", 3 * 86_400_000);
    const newPdf = touch("new.pdf", 1000);
    const oldOther = touch("old.txt", 3 * 86_400_000);
    const n = pruneOldFiles(dir, 86_400_000, { match: (f) => f.endsWith(".pdf") });
    expect(n).toBe(1);
    expect(existsSync(oldPdf)).toBe(false);
    expect(existsSync(newPdf)).toBe(true);
    expect(existsSync(oldOther)).toBe(true);
  });

  it("is a no-op for a missing directory", () => {
    expect(pruneOldFiles(path.join(dir, "nope"), 1000)).toBe(0);
  });
});

describe("logger file cap", () => {
  it("stops appending to the log file once it reaches the size cap", () => {
    const logDir = path.join(dir, "logs");
    const logger = createLogger({ level: "info", logDir, maxFileBytes: 400 });
    const orig = console.log;
    console.log = () => {};
    try {
      for (let i = 0; i < 50; i += 1) logger.info("line " + i);
    } finally {
      console.log = orig;
    }
    const file = path.join(logDir, `agent-${new Date().toISOString().slice(0, 10)}.log`);
    expect(readFileSync(file, "utf8").length).toBeLessThan(800);
    expect(MAX_LOG_FILE_BYTES).toBeGreaterThan(1_000_000);
  });
});
