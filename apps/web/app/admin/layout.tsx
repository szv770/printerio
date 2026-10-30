import { redirect } from "next/navigation";
import { AuthError, requireOrgRole, type SessionWithMembership } from "@/lib/auth/session";
import { routes } from "@/lib/routes";
import { AppShell } from "@/components/shell/AppShell";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  let session: SessionWithMembership;
  try {
    session = await requireOrgRole(["org_admin", "approver"]);
  } catch (err) {
    // Only a missing/forbidden role bounces to start. Anything else - notably Next's redirect errors (for example
    // the reauth_required redirect to login thrown by getCurrentSession) and real outages - must propagate.
    if (err instanceof AuthError) redirect(routes.start);
    throw err;
  }
  return <AppShell session={session}>{children}</AppShell>;
}
