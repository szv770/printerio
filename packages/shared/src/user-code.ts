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
  return (text ?? "").normalize("NFKD").replace(/\p{M}+/gu, "").replace(/[^A-Za-z]+/g, " ").trim().split(/\s+/).filter(Boolean);
}

/** Largest numeric suffix tried; with a 1-2 letter prefix this stays well inside the 12 character limit. */
const MAX_SUFFIX = 9_999_999_999;

/**
 * Every code a member could get, best first (lazy, no repeats, all matching ^[A-Z0-9]{1,12}$):
 *  1. initials: first letter of the first and of the last name (a single name: its first two letters);
 *  2. initials + one more letter: the remaining letters of the first name, then of the last name, in order;
 *  3. initials + 1, 2, 3...
 * Only A-Z letters count (accents are folded, digits and non-Latin scripts are dropped); the display name is used
 * first, the email's local part when the name has no Latin letters. With no Latin letters at all: U1, U2, U3...
 */
export function* userCodeCandidates(m: { displayName: string | null; email: string | null }): Generator<string> {
  let w = words(m.displayName);
  if (w.length === 0) w = words((m.email ?? "").split("@")[0]);
  const seen = new Set<string>();
  const fresh = (c: string) => (seen.has(c) ? false : (seen.add(c), true));

  let prefix = "U";
  if (w.length > 0) {
    const first = w[0]!.toUpperCase();
    const last = w[w.length - 1]!.toUpperCase();
    const single = w.length === 1;
    prefix = single ? first.slice(0, 2) : first[0]! + last[0]!;
    if (fresh(prefix)) yield prefix;
    const extras = single ? first.slice(2) : first.slice(1) + last.slice(1);
    for (const ch of extras) {
      const c = prefix + ch;
      if (fresh(c)) yield c;
    }
  }
  for (let n = 1; n <= MAX_SUFFIX; n++) yield prefix + n;
}

/** The first candidate (see userCodeCandidates) not in `used`. `used` is compared case-insensitively. */
export function generateUserCode(
  m: { displayName: string | null; email: string | null },
  used: Iterable<string>,
): string {
  const taken = new Set<string>();
  for (const u of used) taken.add(String(u).trim().toUpperCase());
  for (const c of userCodeCandidates(m)) if (!taken.has(c)) return c;
  throw new Error("No free user code");
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
