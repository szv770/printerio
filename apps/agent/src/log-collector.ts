/**
 * GET_LOGS implementation: returns the tail of a FIXED set of this machine's
 * own log files, with secrets masked.
 *
 * Safety properties (same spirit as self-update.ts):
 *  - No input at all. The command has no payload and this module takes no
 *    value from the cloud: every path below is derived from the Agent's own
 *    configured local storage path or its own repo root.
 *  - Reads only the last ~128 KB of a file, never the whole thing.
 *  - Caps: 300 lines per file, 2000 chars per line, ~60 KB for everything.
 *  - Secrets are masked line by line before anything leaves the process.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export const MAX_LINES_PER_FILE = 300;
export const MAX_RESULT_BYTES = 60 * 1024;
const MAX_LINE_CHARS = 2000;
const TAIL_READ_BYTES = 128 * 1024;
/** Byte budget per file, in output order: the agent's own log matters most. Sums to MAX_RESULT_BYTES. */
const FILE_BUDGETS = [30 * 1024, 15 * 1024, 15 * 1024];

const DEVICE_TOKEN = /u-[a-z2-7]{39}/gi;
const BEARER = /\bBearer\s+\S+/gi;
const SUPABASE_JWT = /\beyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*/g;
const SUPABASE_SECRET = /\bsb_secret_[A-Za-z0-9_-]*/g;
const LONG_HEX = /\b[0-9a-fA-F]{32,}\b/g;
const LONG_B64 = /[A-Za-z0-9+_-]{32,}={0,2}/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Masks anything that looks like a credential. Over-masking (e.g. a file hash) is the accepted trade-off. */
export function maskSecrets(text: string): string {
  return text
    .replace(DEVICE_TOKEN, "u-<token>")
    .replace(BEARER, "Bearer ***")
    .replace(SUPABASE_JWT, "***")
    .replace(SUPABASE_SECRET, "***")
    .replace(LONG_HEX, "***")
    .replace(LONG_B64, (m) => (UUID.test(m) || !/\d/.test(m) || !/[A-Za-z]/.test(m) ? m : "***"));
}

export interface CollectedLogFile {
  /** Short label, e.g. "agent/agent-2026-10-23.log" - never a full local path. */
  name: string;
  lines: string[];
}

export interface CollectedLogs {
  files: CollectedLogFile[];
  /** Plain remarks: which files were missing, which fallback was used. */
  notes: string[];
}

function readTailLines(file: string, budgetBytes: number): string[] {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_READ_BYTES);
    const length = size - start;
    const buf = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    let all = buf.subarray(0, read).toString("utf8").split(/\r?\n/);
    while (all.length > 0 && all[all.length - 1] === "") all.pop();
    if (start > 0 && all.length > 1) all = all.slice(1); // first line is probably cut in half
    const lines = all.slice(-MAX_LINES_PER_FILE).map((l) => {
      const clipped = l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)} ...[line truncated]` : l;
      return maskSecrets(clipped);
    });
    // Keep the NEWEST lines that fit the byte budget.
    const kept: string[] = [];
    let used = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const cost = Buffer.byteLength(lines[i]!) + 1;
      if (used + cost > budgetBytes) break;
      used += cost;
      kept.push(lines[i]!);
    }
    return kept.reverse();
  } finally {
    closeSync(fd);
  }
}

function newestMatching(dir: string, match: (name: string) => boolean): string | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  let best: { file: string; mtime: number } | null = null;
  for (const name of names) {
    if (!match(name)) continue;
    const full = path.join(dir, name);
    try {
      const st = statSync(full);
      if (st.isFile() && (!best || st.mtimeMs > best.mtime)) best = { file: full, mtime: st.mtimeMs };
    } catch {
      // vanished - skip
    }
  }
  return best?.file ?? null;
}

/** The daily files carry their date in the name, so the newest is the lexically greatest (mtime can tie or be reset by a copy). */
function newestAgentLogByName(dir: string): string | null {
  try {
    const names = readdirSync(dir).filter((n) => /^agent-\d{4}-\d{2}-\d{2}\.log$/.test(n)).sort();
    const last = names.at(-1);
    return last ? path.join(dir, last) : null;
  } catch {
    return null;
  }
}

export function collectLogs(opts: { localStoragePath: string; repoRoot: string; now?: Date }): CollectedLogs {
  const now = opts.now ?? new Date();
  const notes: string[] = [];
  const picks: Array<{ label: string; file: string }> = [];

  // (i) the agent's own daily log (same naming as logger.ts / housekeeping.ts)
  const logsDir = path.join(opts.localStoragePath, "logs");
  const todays = path.join(logsDir, `agent-${now.toISOString().slice(0, 10)}.log`);
  if (existsSync(todays)) {
    picks.push({ label: `agent/${path.basename(todays)}`, file: todays });
  } else {
    const newest = newestAgentLogByName(logsDir);
    if (newest) {
      picks.push({ label: `agent/${path.basename(newest)}`, file: newest });
      notes.push("There is no agent log for today yet, so the newest earlier one is shown.");
    } else {
      notes.push("No agent log file was found.");
    }
  }

  // (ii) the newest node-windows daemon log of each service
  for (const [app, label] of [
    ["agent", "agent-service"],
    ["gateway", "gateway-service"],
  ] as const) {
    const dir = path.join(opts.repoRoot, "apps", app, "daemon");
    const newest = newestMatching(dir, (n) => n.toLowerCase().endsWith(".log"));
    if (newest) picks.push({ label: `${label}/${path.basename(newest)}`, file: newest });
    else notes.push(`No ${app} service log was found (${app === "gateway" ? "the gateway" : "the agent"} may not be installed as a Windows service here).`);
  }

  const files: CollectedLogFile[] = [];
  let remaining = MAX_RESULT_BYTES;
  picks.forEach((pick, i) => {
    const budget = Math.min(FILE_BUDGETS[i] ?? 15 * 1024, remaining);
    if (budget <= 0) {
      notes.push(`${pick.label} was left out to stay under the size limit.`);
      return;
    }
    try {
      const lines = readTailLines(pick.file, budget);
      remaining -= lines.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
      files.push({ name: pick.label, lines });
    } catch (err) {
      notes.push(`${pick.label} could not be read (${err instanceof Error ? err.message.replace(/[A-Za-z]:[\\/][^\s'"]*/g, "<path>") : "error"}).`);
    }
  });

  return { files, notes };
}
