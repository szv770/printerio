/**
 * Small local-disk housekeeping for the Agent: stale downloaded PDFs (crash
 * leftovers - the orchestrator deletes each job's file itself after the job)
 * and old daily log files. Best effort: never throws.
 */
import { readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { Logger } from "./logger.js";

export const STALE_DOWNLOAD_MS = 24 * 60 * 60 * 1000;
export const LOG_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/** Deletes plain files in `dir` (non-recursive) whose mtime is older than `maxAgeMs`. Returns how many were removed. */
export function pruneOldFiles(dir: string, maxAgeMs: number, options: { match?: (fileName: string) => boolean; now?: number } = {}): number {
  const now = options.now ?? Date.now();
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (options.match && !options.match(name)) continue;
    const full = path.join(dir, name);
    try {
      const st = statSync(full);
      if (st.isFile() && now - st.mtimeMs > maxAgeMs) {
        unlinkSync(full);
        removed += 1;
      }
    } catch {
      // in use or already gone - skip
    }
  }
  return removed;
}

/** Startup sweep: leftover downloads older than 24h and agent-*.log files older than 14 days. */
export function runStartupHousekeeping(localStoragePath: string, logger: Logger): void {
  const downloads = pruneOldFiles(path.join(localStoragePath, "downloads"), STALE_DOWNLOAD_MS);
  const logs = pruneOldFiles(path.join(localStoragePath, "logs"), LOG_RETENTION_MS, {
    match: (f) => /^agent-\d{4}-\d{2}-\d{2}\.log$/.test(f),
  });
  if (downloads > 0 || logs > 0) logger.info("startup housekeeping removed stale files", { downloads, logs });
}
