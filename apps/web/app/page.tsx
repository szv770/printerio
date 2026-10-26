import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/session";
import { routes } from "@/lib/routes";
import { Landing } from "@/components/landing/Landing";

export const metadata: Metadata = {
  title: { absolute: "Printio: press Print, it comes out of the right printer" },
  description:
    "Printio puts your school or office printer in everyone's normal Print menu on Windows, iPhone and Android, with rules, approvals and proper left and right booklets.",
  openGraph: {
    title: "Printio",
    description: "Press Print. It comes out of the right printer. Rules, approvals and real booklets built in.",
    type: "website",
  },
};

export default async function HomePage() {
  const session = await getCurrentSession();
  // Visitors who are not signed in see the public home page; signed-in people go straight to their own home.
  if (!session) return <Landing />;
  if (!session.membership) redirect(routes.noAccess);

  if (session.membership.role === "org_admin" || session.membership.role === "approver") {
    redirect(routes.admin);
  }
  redirect(routes.dashboard);
}
