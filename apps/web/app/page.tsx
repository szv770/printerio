import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/session";

export default async function HomePage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.membership) redirect("/no-access");

  if (session.membership.role === "org_admin" || session.membership.role === "approver") {
    redirect("/admin");
  }
  redirect("/print");
}
