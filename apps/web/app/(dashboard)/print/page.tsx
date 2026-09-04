import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/auth/session";
import { routes } from "@/lib/routes";
import { PageHeader, EmptyState } from "@/components/ui";
import { PrintForm } from "./PrintForm";

export default async function PrintPage() {
  const session = await requireSession();
  if (!session.membership) redirect(routes.noAccess);

  const supabase = await createClient();
  const { data: profiles } = await supabase
    .from("printer_profiles")
    .select("id, label, key, declared_paper_sizes, declared_capabilities, is_default, printers!inner(id, name, organization_id, status)")
    .eq("printers.organization_id", session.membership.organization_id)
    .order("is_default", { ascending: false });

  const printerProfiles = (profiles ?? []).map((p) => ({
    id: p.id,
    label: `${p.printers.name} — ${p.label}`,
    declaredPaperSizes: p.declared_paper_sizes,
    declaredCapabilities: p.declared_capabilities as {
      duplex: boolean;
      color: boolean;
      staple: boolean;
      booklet: boolean;
      punch: boolean;
    },
    printerOnline: p.printers.status === "online",
  }));

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <PageHeader title="Print a document" description="Upload a PDF, choose your printer and options." />
      {printerProfiles.length === 0 ? (
        <EmptyState message="No printers are configured for your organization yet. Ask your administrator to add one under Admin → Printers." />
      ) : (
        <PrintForm printerProfiles={printerProfiles} />
      )}
    </main>
  );
}
