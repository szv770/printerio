/**
 * Pure helpers for the reports, activity log and storage pages: the date-range
 * pills, the "showing the first N rows" note, plain-language audit wording and
 * the storage meter. Unit tested in reports-view.test.ts.
 */
import { roleLabel } from "@/lib/role-label";

export const REPORT_ROW_LIMIT = 1000;

export type ReportRange = 7 | 30 | 90;

export const REPORT_RANGES: { days: ReportRange; label: string }[] = [
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
];

export function parseReportRange(raw: string | string[] | undefined): ReportRange {
  const v = Number.parseInt(Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? ""), 10);
  return v === 7 || v === 90 ? v : 30;
}

export function rangeSinceIso(days: number, now: Date): string {
  return new Date(now.getTime() - days * 24 * 3600 * 1000).toISOString();
}

/** A note for the user when a query hit its row cap (otherwise the cut-off would be silent). */
export function truncationNote(received: number, limit: number, which: "first" | "latest" = "first"): string | null {
  if (received < limit) return null;
  return `Showing the ${which} ${limit.toLocaleString("en-US")} rows`;
}

const AUDIT_LABELS: Record<string, string> = {
  "member.role_changed": "Changed someone's role",
  "member.status_changed": "Turned someone on or off",
  "member.removed": "Removed someone",
  "invitation.revoked": "Turned off an invite code",
  "invitation.redeemed": "Someone joined with an invite code",
  "storage.cleanup_run": "Cleaned up stored files",
  "agent.registered": "Connected a print server",
  "agent.disabled": "Paused a print server",
  "agent.deleted": "Removed a print server",
  "agent.credential_rotated": "Reset a print server's key",
  "remote_command.issued": "Sent a command to a print server",
  "remote_command.acknowledged": "A print server ran a command",
  "printer_profile.updated": "Changed a print queue",
  "printer_profile.deleted": "Removed a print queue",
  "printer_profile.test_print_sent": "Sent a test page",
  "organization.bootstrapped": "Set up the organization",
};

function sentenceCase(s: string): string {
  const t = s.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function auditActionLabel(action: string): string {
  return AUDIT_LABELS[action] ?? sentenceCase(action);
}

function humanKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function humanValue(key: string, v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return v.toLocaleString("en-US");
  if (typeof v === "string") return /role/i.test(key) ? roleLabel(v) : v;
  if (Array.isArray(v)) return v.map((x) => humanValue(key, x)).join(", ");
  if (typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${k}: ${humanValue(k, x)}`)
      .join(", ");
  }
  return String(v);
}

export function auditDetails(metadata: unknown): { label: string; value: string }[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  return Object.entries(metadata as Record<string, unknown>).map(([k, v]) => ({ label: humanKey(k), value: humanValue(k, v) }));
}

export interface StorageMeterSegment {
  key: "active" | "kept" | "cleanable";
  label: string;
  bytes: number;
  pct: number;
}

export function storageMeter(b: { active: number; withinRetention: number; cleanable: number }): {
  total: number;
  segments: StorageMeterSegment[];
} {
  const total = b.active + b.withinRetention + b.cleanable;
  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);
  return {
    total,
    segments: [
      { key: "active", label: "Waiting or printing", bytes: b.active, pct: pct(b.active) },
      { key: "kept", label: "Kept for now", bytes: b.withinRetention, pct: pct(b.withinRetention) },
      { key: "cleanable", label: "Ready to clean up", bytes: b.cleanable, pct: pct(b.cleanable) },
    ],
  };
}
