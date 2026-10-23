/** Pure logic for the "Did it come out OK?" loop (no server-only imports: safe in client components). */

/** The setups we have written steps for. Anything else is filed under other_<device type>. */
export const SETUP_KEYS = ["windows_manual_wizard", "android_bare_host", "mac_lpadmin", "mac_ip_tab"] as const;
export type SetupKey = (typeof SETUP_KEYS)[number];

const LABELS: Record<SetupKey, string> = {
  windows_manual_wizard: "Windows 11 - manual wizard (Add manually > shared printer by name)",
  android_bare_host: "Android - Add by IP/hostname (bare hostname)",
  mac_lpadmin: "Mac - Terminal line (lpadmin)",
  mac_ip_tab: "Mac - System Settings > Add Printer > IP tab",
};

/** Must match private.setup_key_for() in supabase/migrations/0042_setup_feedback.sql. */
export function setupKeyFor(deviceType: string, variant?: string | null): string {
  if (deviceType === "windows") return "windows_manual_wizard";
  if (deviceType === "android") return "android_bare_host";
  if (deviceType === "mac") return variant === "ip_tab" ? "mac_ip_tab" : "mac_lpadmin";
  return `other_${deviceType || "unknown"}`;
}

export function setupMethodLabel(key: string): string {
  return (LABELS as Record<string, string>)[key] ?? key.replace(/^other_/, "Other: ").replace(/_/g, " ");
}

/** How long after a device's first print we still ask about it. */
export const FEEDBACK_ASK_WINDOW_MS = 30 * 86_400_000;

export interface FeedbackDevice {
  id: string;
  name: string;
  device_type: string;
  revoked_at: string | null;
  first_printed_at: string | null;
}

/**
 * Devices to ask "Did it come out OK?" about: first print reached printed, no job from the device failed, the
 * member has no open problem on it, has not answered yet, and the first print was recent.
 */
export function feedbackCardDevices<T extends FeedbackDevice>(
  devices: T[],
  ctx: { answered: Set<string>; openIssues: Map<string, number>; failedJobs: Map<string, number>; now: Date },
): T[] {
  return devices.filter((d) => {
    if (d.revoked_at || !d.first_printed_at) return false;
    if (ctx.answered.has(d.id)) return false;
    if ((ctx.openIssues.get(d.id) ?? 0) > 0) return false;
    if ((ctx.failedJobs.get(d.id) ?? 0) > 0) return false;
    const age = ctx.now.getTime() - new Date(d.first_printed_at).getTime();
    return Number.isFinite(age) && age <= FEEDBACK_ASK_WINDOW_MS;
  });
}

export const FEEDBACK_NOTE_MAX = 1000;

export function validateFeedback(input: { outcome: string; note: string; variant?: string | null }): { ok: true; outcome: "ok" | "problem"; note: string; variant: "terminal" | "ip_tab" | null } | { ok: false; error: string } {
  if (input.outcome !== "ok" && input.outcome !== "problem") return { ok: false, error: "Choose Yes or Something was wrong." };
  const note = input.outcome === "problem" ? input.note.trim() : "";
  if (note.length > FEEDBACK_NOTE_MAX) return { ok: false, error: `Keep the note under ${FEEDBACK_NOTE_MAX} characters.` };
  const variant = input.variant === "terminal" || input.variant === "ip_tab" ? input.variant : null;
  return { ok: true, outcome: input.outcome, note, variant };
}

export interface FeedbackRow {
  setup_key: string;
  outcome: "ok" | "problem";
  user_id: string;
  note: string;
  created_at: string;
}

export type SetupStatus = "not_tested" | "reported" | "confirmed";

export interface SetupSummary {
  key: string;
  label: string;
  status: SetupStatus;
  /** "Not tested yet" / "Reported working by N people" / "Confirmed working" */
  statusLabel: string;
  /** Alias kept for tests and callers that want the label text. */
  worked: number;
  problems: number;
  confirmed: boolean;
  problemNotes: string[];
}

/** One row per documented setup, plus any other setup that has answers. An admin confirmation always wins. */
export function summarizeSetups(feedback: FeedbackRow[], confirmations: { setup_key: string }[]): (SetupSummary & { label: string })[] {
  const keys = [...SETUP_KEYS, ...[...new Set(feedback.map((f) => f.setup_key))].filter((k) => !(SETUP_KEYS as readonly string[]).includes(k)).sort()] as string[];
  const confirmed = new Set(confirmations.map((c) => c.setup_key));
  return keys.map((key) => {
    const rows = feedback.filter((f) => f.setup_key === key);
    const worked = new Set(rows.filter((r) => r.outcome === "ok").map((r) => r.user_id)).size;
    const problemRows = rows.filter((r) => r.outcome === "problem");
    const isConfirmed = confirmed.has(key);
    const status: SetupStatus = isConfirmed ? "confirmed" : worked > 0 ? "reported" : "not_tested";
    const statusLabel = isConfirmed ? "Confirmed working" : worked > 0 ? `Reported working by ${worked} ${worked === 1 ? "person" : "people"}` : "Not tested yet";
    return {
      key,
      label: setupMethodLabel(key),
      status,
      statusLabel,
      worked,
      problems: problemRows.length,
      confirmed: isConfirmed,
      problemNotes: problemRows.map((r) => r.note).filter((n) => n.trim() !== ""),
    };
  });
}
