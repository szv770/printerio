/**
 * The member "user code" stamped on page 1 of every printout, and the organization's stamp settings.
 * Pure helpers (no I/O) so the website, the IPP gateway pipeline and the admin pages agree on one meaning.
 * Design: docs/superpowers/specs/2026-10-20-printio-setup-design.md (Phase 3).
 */

export type StampShow = "code" | "code_date";
export type StampStrength = "light" | "medium" | "strong";
export interface StampSettings {
  enabled: boolean;
  show: StampShow;
  strength: StampStrength;
}

export const DEFAULT_STAMP_SETTINGS: StampSettings = { enabled: true, show: "code", strength: "light" };
export const STAMP_SHOW_OPTIONS: ReadonlyArray<{ value: StampShow; label: string }> = [
  { value: "code", label: "User code only" },
  { value: "code_date", label: "User code and date" },
];
export const STAMP_STRENGTH_OPTIONS: ReadonlyArray<{ value: StampStrength; label: string }> = [
  { value: "light", label: "Light (very faint)" },
  { value: "medium", label: "Medium" },
  { value: "strong", label: "Strong (darker grey)" },
];

const CODE_RE = /^[A-Z0-9]{1,12}$/;

/** Uppercased code, or null if it is empty / too long / has anything but letters and digits. */
export function normalizeUserCode(input: string | null | undefined): string | null {
  const v = (input ?? "").trim().toUpperCase();
  return CODE_RE.test(v) ? v : null;
}

function words(text: string | null | undefined): string[] {
  return (text ?? "").normalize("NFKD").replace(/[^A-Za-z]+/g, " ").trim().split(/\s+/).filter(Boolean);
}

function initialsOf(name: string | null | undefined, email: string | null | undefined): string {
  let w = words(name);
  if (w.length === 0) w = words((email ?? "").split("@")[0]);
  if (w.length === 0) return "U";
  const letters = w.length === 1 ? w[0]!.slice(0, 2) : w[0]![0]! + w[w.length - 1]![0]!;
  return letters.toUpperCase();
}

/** Initials + two digits derived from the user id, so it is stable without being stored. */
export function fallbackUserCode(m: { displayName: string | null; email: string | null; userId: string }): string {
  let h = 0;
  for (let i = 0; i < m.userId.length; i++) h = (h * 31 + m.userId.charCodeAt(i)) >>> 0;
  return `${initialsOf(m.displayName, m.email)}${String(h % 100).padStart(2, "0")}`;
}

/** The code to show and stamp: the stored one if valid, else the generated fallback (generated: true). */
export function effectiveUserCode(m: {
  stored: string | null | undefined;
  displayName: string | null;
  email: string | null;
  userId: string;
}): { code: string; generated: boolean } {
  const stored = normalizeUserCode(m.stored);
  if (stored) return { code: stored, generated: false };
  return { code: fallbackUserCode(m), generated: true };
}

export function buildStampText(o: { code: string; show: StampShow; now: Date }): string {
  return o.show === "code_date" ? `${o.code} ${o.now.toISOString().slice(0, 10)}` : o.code;
}

/** organization_settings row (or null) -> settings. A missing row/column means the default: ON, code only, light. */
export function normalizeStampSettings(row: Record<string, unknown> | null | undefined): StampSettings {
  const show = row?.stamp_show;
  const strength = row?.stamp_strength;
  return {
    enabled: typeof row?.stamp_enabled === "boolean" ? row.stamp_enabled : DEFAULT_STAMP_SETTINGS.enabled,
    show: show === "code_date" ? "code_date" : "code",
    strength: strength === "medium" || strength === "strong" ? strength : "light",
  };
}
