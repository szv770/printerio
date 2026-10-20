/**
 * The one place that decides what a stored org role is called on screen.
 * Stored values (notably 'student') never change; only the wording does.
 */
const LABELS: Record<string, string> = {
  org_admin: "Admin",
  approver: "Approver",
  staff: "Staff",
  student: "User",
};

export function roleLabel(role: string): string {
  return LABELS[role] ?? role;
}
