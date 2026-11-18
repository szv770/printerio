/** How often a print server asks the website for work, as an admin can set it (see agents.poll_interval_seconds). */
export const MIN_ADMIN_POLL_SECONDS = 2;
export const MAX_ADMIN_POLL_SECONDS = 300;

export const POLL_PRESETS = [
  { seconds: 2, label: "Fastest (every 2 seconds)" },
  { seconds: 3, label: "Fast (every 3 seconds)" },
  { seconds: 10, label: "Relaxed (every 10 seconds)" },
  { seconds: 30, label: "Slow (every 30 seconds)" },
  { seconds: 60, label: "Very slow (every minute)" },
  { seconds: 300, label: "Minimal (every 5 minutes)" },
] as const;

export type ParsedPollSeconds = { ok: true; value: number | null } | { ok: false };

/** Blank / "default" = let the PC use its own setting (null). Otherwise whole seconds from 2 to 300. */
export function parsePollSeconds(raw: string): ParsedPollSeconds {
  const text = raw.trim();
  if (text === "" || text === "default") return { ok: true, value: null };
  if (!/^\d+$/.test(text)) return { ok: false };
  const n = Number(text);
  if (n < MIN_ADMIN_POLL_SECONDS || n > MAX_ADMIN_POLL_SECONDS) return { ok: false };
  return { ok: true, value: n };
}
