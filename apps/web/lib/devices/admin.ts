/** Pure helpers for device problem reports and the admin Devices list (no server-only imports, safe in client components). */

export const ISSUE_KINDS = ["cant_add", "nothing_prints", "prints_wrong", "other"] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];

export const MAX_ISSUE_NOTE = 2000;

const KIND_LABELS: Record<IssueKind, string> = {
  cant_add: "I couldn't add it",
  nothing_prints: "I added it but nothing prints",
  prints_wrong: "It prints, but not right",
  other: "Something else",
};

export function issueKindLabel(kind: string): string {
  return KIND_LABELS[kind as IssueKind] ?? "Something else";
}

export type IssueValidation =
  | { ok: true; kind: IssueKind; note: string }
  | { ok: false; error: string; field: "kind" | "note" };

export function validateIssueInput(input: { kind: string; note: string }): IssueValidation {
  if (!(ISSUE_KINDS as readonly string[]).includes(input.kind)) return { ok: false, error: "Choose what went wrong.", field: "kind" };
  const note = input.note.trim();
  if (note.length > MAX_ISSUE_NOTE) return { ok: false, error: `Please keep your note under ${MAX_ISSUE_NOTE} characters.`, field: "note" };
  return { ok: true, kind: input.kind as IssueKind, note };
}

export function validateResolveNote(raw: string): { ok: true; note: string } | { ok: false; error: string } {
  const note = raw.trim();
  if (note.length > MAX_ISSUE_NOTE) return { ok: false, error: `Please keep the note under ${MAX_ISSUE_NOTE} characters.` };
  return { ok: true, note };
}

export const STUCK_AFTER_MS = 10 * 60_000;

export type StuckReason = "open_issue" | "connected_no_job" | "job_not_printed";

export interface StuckInput {
  id: string;
  revoked_at: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  first_job_at: string | null;
  first_printed_at: string | null;
  created_at: string;
}

const t = (iso: string | null) => (iso ? new Date(iso).getTime() : NaN);

/** Why an admin should look at this device, or null. Turned-off devices are never "stuck". */
export function stuckReason(d: StuckInput, openIssues: number, now: Date): StuckReason | null {
  if (d.revoked_at) return null;
  if (openIssues > 0) return "open_issue";
  if (d.first_printed_at) return null;
  if (d.first_job_at) {
    return now.getTime() - t(d.first_job_at) > STUCK_AFTER_MS ? "job_not_printed" : null;
  }
  const seen = t(d.first_seen_at ?? d.last_seen_at);
  if (!Number.isNaN(seen) && now.getTime() - seen > STUCK_AFTER_MS) return "connected_no_job";
  return null;
}

export const STUCK_LABELS: Record<StuckReason, string> = {
  open_issue: "Asked for help",
  connected_no_job: "Connected, nothing sent yet",
  job_not_printed: "Sent a print, not printed yet",
};

/** Stuck first, then most recently active; turned-off devices last. Returns a new array. */
export function sortStuckFirst<T extends StuckInput>(devices: T[], openIssuesByDevice: Record<string, number>, now: Date): T[] {
  const rank = (d: T) => (d.revoked_at ? 2 : stuckReason(d, openIssuesByDevice[d.id] ?? 0, now) ? 0 : 1);
  const activity = (d: T) => {
    const v = Math.max(t(d.last_seen_at) || 0, t(d.created_at) || 0);
    return v;
  };
  return [...devices].sort((a, b) => rank(a) - rank(b) || activity(b) - activity(a));
}
