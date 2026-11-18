import type { Metadata } from "next";
import { getCurrentSession } from "@/lib/auth/session";
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

// The public home page is for everyone, including people who are signed in (they get an "Open Printio" button).
export default async function HomePage() {
  const session = await getCurrentSession();
  return <Landing signedIn={!!session} />;
}
