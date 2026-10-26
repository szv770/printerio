import { redirect } from "next/navigation";
import { requireSessionOrRedirect } from "@/lib/auth/session";
import { routes } from "@/lib/routes";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import { DEFAULT_MAX_UPLOAD_BYTES } from "@/lib/pdf/client-precheck";
import { canUseLinks } from "@/lib/sources/access";
import { BookletBuilder } from "@/components/booklet/BookletBuilder";

// Combining files and fetching links happen on the server and can take a while.
export const maxDuration = 60;

export default async function BookletBuilderPage() {
  const session = await requireSessionOrRedirect();
  if (!session.membership) redirect(routes.noAccess);
  if (!canUseLinks(session.membership.role)) redirect(routes.print);

  const supabase = await createClient();
  const { data: settings } = await supabase
    .from("organization_settings")
    .select("max_upload_size_bytes")
    .eq("organization_id", session.membership.organization_id)
    .maybeSingle();

  return (
    <main className="mx-auto max-w-2xl px-4 py-6 sm:py-10">
      <PageHeader title="Make a booklet" description="Combine several PDFs into one booklet with a cover and contents page. You check it and print on the next screen." />
      <BookletBuilder maxUploadBytes={settings?.max_upload_size_bytes ?? DEFAULT_MAX_UPLOAD_BYTES} />
    </main>
  );
}
