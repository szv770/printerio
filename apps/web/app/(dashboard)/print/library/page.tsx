import { redirect } from "next/navigation";
import { requireSessionOrRedirect } from "@/lib/auth/session";
import { routes } from "@/lib/routes";
import { PageHeader } from "@/components/ui";
import { canUseLinks } from "@/lib/sources/access";
import { LibraryBrowser } from "@/components/library/LibraryBrowser";

// Library pages are fetched from the library's own site on the server.
export const maxDuration = 60;

export default async function LibraryPage() {
  const session = await requireSessionOrRedirect();
  if (!session.membership) redirect(routes.noAccess);
  if (!canUseLinks(session.membership.role, session.membership.early_tools)) redirect(routes.print);

  return (
    <main className="mx-auto max-w-2xl px-4 py-6 sm:py-10">
      <PageHeader title="Library" description="Browse Likkutei Sichos, maamarim and sichos from mafteiach.app, tap the files you want, then make them into one booklet. Courtesy of Mafteiach is printed on the contents page." />
      <LibraryBrowser />
    </main>
  );
}
