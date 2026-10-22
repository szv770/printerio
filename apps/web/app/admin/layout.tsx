import { redirect } from "next/navigation";
import { requireOrgRole, type SessionWithMembership } from "@/lib/auth/session";
import { routes } from "@/lib/routes";
import { AppShell } from "@/components/shell/AppShell";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  let session: SessionWithMembership;
  try {
    session = await requireOrgRole(["org_admin", "approver"]);
  } catch {
    redirect(routes.home);
  }
  return <AppShell session={session}>{children}</AppShell>;
}
