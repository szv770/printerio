import { redirect } from "next/navigation";
import { requireSessionOrRedirect } from "@/lib/auth/session";
import { routes } from "@/lib/routes";
import { PageHeader } from "@/components/ui";
import { canUseLinks } from "@/lib/sources/access";
import { LibraryBrowser } from "@/components/library/LibraryBrowser";
import { createClient } from "@/lib/supabase/server";
import { sieFromRow } from "@/lib/library/sie-store";

// Library pages are fetched from the library's own site on the server.
export const maxDuration = 60;

export default async function LibraryPage() {
  const session = await requireSessionOrRedirect();
  if (!session.membership) redirect(routes.noAccess);
  if (!canUseLinks(session.membership.role, session.membership.early_tools)) redirect(routes.print);

  // Weeks of Sichos In English an admin added after the saved copy (signed-in members may read this table).
  const supabase = await createClient();
  const { data: added } = await supabase.from("library_sie_entries").select("url, chelek, sefer, title, volume, page, from_page, to_page, page_count").order("added_at", { ascending: true }).limit(2000);

  return (
    <main className="mx-auto max-w-2xl px-4 py-6 sm:py-10">
      <PageHeader title="Library" description="Browse Likkutei Sichos, maamarim and sichos from mafteiach.app, tap the files you want, then make them into one booklet. Courtesy of Mafteiach is printed on the contents page." />
      <LibraryBrowser extraSie={(added ?? []).map(sieFromRow)} canRefreshSie={session.membership.role === "org_admin"} />
    </main>
  );
}
