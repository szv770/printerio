import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/session";
import { routes } from "@/lib/routes";

export default async function HomePage() {
  const session = await getCurrentSession();
  if (!session) redirect(routes.login);
  if (!session.membership) redirect(routes.noAccess);

  if (session.membership.role === "org_admin" || session.membership.role === "approver") {
    redirect(routes.admin);
  }
  redirect(routes.print);
}
