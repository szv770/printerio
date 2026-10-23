/** Pure helpers for invite links (no server-only imports: used by client components too). */

export type InviteStatus = "active" | "used" | "expired";

/** Codes are 12 hex chars today; accept a slightly wider safe alphabet. */
export function isPlausibleInviteCode(code: string | null | undefined): code is string {
  return typeof code === "string" && /^[A-Za-z0-9_-]{4,64}$/.test(code);
}

export function buildInviteUrl(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, "")}/join?code=${encodeURIComponent(code)}`;
}

export function inviteShareMessage(orgName: string, url: string): string {
  const where = orgName.trim() ? ` at ${orgName.trim()}` : "";
  return `You're invited to print${where} with Printio: ${url}`;
}

export function inviteStatus(
  inv: { usesCount: number; maxUses: number | null; expiresAt: string | null },
  now: Date = new Date(),
): InviteStatus {
  if (inv.expiresAt && new Date(inv.expiresAt).getTime() < now.getTime()) return "expired";
  if (inv.maxUses !== null && inv.usesCount >= inv.maxUses) return "used";
  return "active";
}
