/**
 * Pure helpers for remote_commands rows: tolerant parsing of the Agent-written `result` jsonb, the plain phase
 * text the Print server page shows, and the audit-safe form of a result. No imports from server-only code so
 * both Server and Client Components (and tests) can use it.
 */

const MAX_FILES = 6;
const MAX_LINES_PER_FILE = 400;
const MAX_LINE_CHARS = 4000;
const MAX_NOTES = 10;
const AUDIT_RESULT_MAX_CHARS = 2000;

/** A finished command created this recently still triggers live refresh, in case its result has not been seen yet. */
export const AUTO_REFRESH_RECENT_MS = 120_000;
const ACTIVE_GIVE_UP_MS = 30 * 60_000;
/** A pending command older than this gets the "probably offline" wording. */
const PENDING_TOO_LONG_MS = 5 * 60_000;

export interface ParsedCommandResult {
  message: string | null;
  updated: boolean | null;
  reason: string | null;
  files: Array<{ name: string; lines: string[] }>;
  notes: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Never throws, whatever shape arrives. Anything that is not the expected type is dropped, and sizes are bounded. */
export function parseCommandResult(result: unknown): ParsedCommandResult {
  const out: ParsedCommandResult = { message: null, updated: null, reason: null, files: [], notes: [] };
  if (!isRecord(result)) return out;

  if (typeof result.message === "string" && result.message.trim()) out.message = result.message;
  if (typeof result.updated === "boolean") out.updated = result.updated;
  if (typeof result.reason === "string") out.reason = result.reason;

  if (Array.isArray(result.files)) {
    for (const f of result.files) {
      if (out.files.length >= MAX_FILES) break;
      if (!isRecord(f) || typeof f.name !== "string" || !Array.isArray(f.lines)) continue;
      const lines = f.lines
        .filter((l) => l !== null && l !== undefined && typeof l !== "object")
        .slice(-MAX_LINES_PER_FILE)
        .map((l) => String(l).slice(0, MAX_LINE_CHARS));
      out.files.push({ name: f.name.slice(0, 200), lines });
    }
  }
  if (Array.isArray(result.notes)) {
    out.notes = result.notes.filter((n): n is string => typeof n === "string").slice(0, MAX_NOTES);
  }
  return out;
}

/** What may be copied into audit_logs.metadata: never log content, and never a large blob. */
export function auditSafeResult(command: string, result: unknown): Record<string, unknown> | null {
  if (!isRecord(result)) return null;
  if (command === "GET_LOGS") {
    const files = Array.isArray(result.files) ? result.files : [];
    const lines = files.reduce<number>((n, f) => n + (isRecord(f) && Array.isArray(f.lines) ? f.lines.length : 0), 0);
    return { files: files.length, lines };
  }
  try {
    if (JSON.stringify(result).length > AUDIT_RESULT_MAX_CHARS) return { omitted: "result too large for the audit log" };
  } catch {
    return { omitted: "result could not be recorded" };
  }
  return result;
}

export interface CommandLike {
  id?: string;
  command?: string;
  status: string;
  createdAt: string;
  completedAt?: string | null;
  result?: unknown;
}

export interface CommandPhase {
  kind: "waiting" | "running" | "done" | "failed" | "unknown";
  text: string;
}

export function commandPhase(command: CommandLike, now: number): CommandPhase {
  const created = Date.parse(command.createdAt);
  switch (command.status) {
    case "pending": {
      if (Number.isFinite(created) && now - created > PENDING_TOO_LONG_MS) {
        return {
          kind: "waiting",
          text: "The print server has not picked this up yet. It may be switched off or offline; it will run when the server is back.",
        };
      }
      return { kind: "waiting", text: "Waiting for the print server to pick it up (it checks about every 15 seconds)" };
    }
    case "acknowledged":
      return { kind: "running", text: "Running..." };
    case "completed": {
      const parsed = parseCommandResult(command.result);
      if (command.command === "GET_LOGS" && !parsed.message) {
        return {
          kind: "done",
          text: parsed.files.length > 0 ? 'Logs received. Open "Logs" above to read or copy them.' : "The print server answered but had no log files to show.",
        };
      }
      return { kind: "done", text: parsed.message ?? "Done." };
    }
    case "failed":
      return { kind: "failed", text: parseCommandResult(command.result).message ?? "It did not complete." };
    default:
      return { kind: "unknown", text: "Status unknown." };
  }
}

/** True while anything is pending/running, or was created within the last 2 minutes. */
export function hasActiveCommand(commands: Array<Pick<CommandLike, "status" | "createdAt">>, now: number): boolean {
  return commands.some((c) => {
    const created = Date.parse(c.createdAt);
    if (!Number.isFinite(created)) return c.status === "pending" || c.status === "acknowledged";
    // A request nobody picked up for half an hour (server off) should not keep the page polling all day.
    if (c.status === "pending" || c.status === "acknowledged") return now - created < ACTIVE_GIVE_UP_MS;
    return now - created < AUTO_REFRESH_RECENT_MS;
  });
}
