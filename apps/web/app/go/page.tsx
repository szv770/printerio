import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/session";
import { routes } from "@/lib/routes";

// "Take me to my own home" - the role-based redirect that used to live at "/". The public home page is at "/" now and is
// shown to everyone, so everything that means "send this person to their home" (after sign-in, the logo, a refused
// page) points here instead.
export const dynamic = "force-dynamic";

export default async function GoPage() {
  const session = await getCurrentSession();
  if (!session) redirect(routes.login);
  if (!session.membership) redirect(routes.noAccess);
  if (session.membership.role === "org_admin" || session.membership.role === "approver") redirect(routes.admin);
  redirect(routes.dashboard);
}
