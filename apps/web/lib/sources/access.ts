/**
 * Who may print from a link and use the booklet builder. Admins always; anyone else only when an admin switched "early
 * tools" on for them (organization_members.early_tools, set on the person's page in Admin -> Users). One place for the
 * screen and the server actions alike. Owner decision 2026-10-25: start with admin testing, then whoever the admin sets.
 */
export function canUseLinks(role: string | null | undefined, earlyTools?: boolean | null): boolean {
  return role === "org_admin" || earlyTools === true;
}
