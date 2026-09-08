import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireSessionOrRedirect } from "@/lib/auth/session";
import { routes } from "@/lib/routes";
import { PageHeader } from "@/components/ui";
import { DEFAULT_MAX_UPLOAD_BYTES } from "@/lib/pdf/client-precheck";
import { PrintForm } from "./PrintForm";

export default async function PrintPage() {
  const session = await requireSessionOrRedirect();
  if (!session.membership) redirect(routes.noAccess);

  const supabase = await createClient();
  const [{ data: profiles }, { data: settings }] = await Promise.all([
    supabase
      .from("printer_profiles")
      .select(
        "id, label, key, description, icon_key, declared_paper_sizes, declared_capabilities, booklet_binding_side, is_default, printers!inner(id, name, organization_id, status)",
      )
      .eq("printers.organization_id", session.membership.organization_id)
      .order("is_default", { ascending: false }),
    // Only the upload limit is handed to the client, purely so the form can
    // say "too big" before a slow upload rather than after. The server action
    // re-reads this setting itself and remains the authority - see
    // print/actions.ts and lib/pdf/client-precheck.ts.
    supabase
      .from("organization_settings")
      .select("max_upload_size_bytes")
      .eq("organization_id", session.membership.organization_id)
      .maybeSingle(),
  ]);

  const printerProfiles = (profiles ?? []).map((p) => ({
    id: p.id,
    label: `${p.printers.name} — ${p.label}`,
    description: p.description,
    iconKey: p.icon_key,
    declaredPaperSizes: p.declared_paper_sizes,
    declaredCapabilities: p.declared_capabilities as {
      duplex: boolean;
      color: boolean;
      staple: boolean;
      booklet: boolean;
      punch: boolean;
    },
    bookletBindingSide: p.booklet_binding_side === "right" ? ("right" as const) : ("left" as const),
    printerOnline: p.printers.status === "online",
  }));

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <PageHeader title="Print a document" description="Upload a PDF, choose your printer and options." />
      {/* Always render the form, even with zero printer_profiles - it shows
       *  its own inline notice and disables Submit in that case, rather than
       *  blocking the user from picking a file and preparing everything
       *  else just because a printer isn't connected yet. */}
      <PrintForm
        printerProfiles={printerProfiles}
        maxUploadBytes={settings?.max_upload_size_bytes ?? DEFAULT_MAX_UPLOAD_BYTES}
      />
    </main>
  );
}
