import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/session";
import { routes } from "@/lib/routes";
import { AppShell } from "@/components/shell/AppShell";

/** Shared shell for the member pages (Print, My Jobs, Usage, Devices, Profile).
 *  AppShell picks the shell by role: org admins and approvers get the admin
 *  sidebar here too, plain members get the simple header. */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getCurrentSession();
  if (!session) redirect(routes.login);
  if (!session.membership) redirect(routes.noAccess);

  return <AppShell session={{ ...session, membership: session.membership }}>{children}</AppShell>;
}
