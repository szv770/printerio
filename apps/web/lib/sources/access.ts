/**
 * Who may print from a link and use libraries. Admins first (owner decision 2026-10-25: "start with admin testing, then
 * whoever the admin sets, maybe by groups"). One place to widen it later, for the screen and the server action alike.
 */
export function canUseLinks(role: string | null | undefined): boolean {
  return role === "org_admin";
}
