import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/auth/session";
import { PrintForm } from "./PrintForm";

export default async function PrintPage() {
  const session = await requireSession();
  if (!session.membership) redirect("/no-access");

  const supabase = await createClient();
  const { data: profiles } = await supabase
    .from("printer_profiles")
    .select("id, label, key, declared_paper_sizes, declared_capabilities, is_default, printers!inner(id, name, organization_id, status)")
    .eq("printers.organization_id", session.membership.organization_id)
    .order("is_default", { ascending: false });

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="mb-1 text-2xl font-semibold">Print a document</h1>
      <p className="mb-8 text-sm text-[var(--color-muted)]">Upload a PDF, choose your printer and options.</p>
      <PrintForm
        printerProfiles={(profiles ?? []).map((p) => ({
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
        }))}
      />
    </main>
  );
}
