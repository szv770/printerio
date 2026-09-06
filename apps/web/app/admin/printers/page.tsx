import Link from "next/link";
import { Wand2 } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { PageHeader } from "@/components/ui";
import { routes } from "@/lib/routes";
import { PrintersPanel } from "./PrintersPanel";

export default async function PrintersPage() {
  const session = await requireOrgRole(["org_admin", "approver"]);
  const supabase = await createClient();
  const orgId = session.membership.organization_id;

  const [{ data: printers }, { data: profiles }, { data: agents }, { data: settings }] = await Promise.all([
    supabase.from("printers").select("*").eq("organization_id", orgId).order("created_at", { ascending: true }),
    supabase.from("printer_profiles").select("*, printers!inner(organization_id)").eq("printers.organization_id", orgId),
    supabase.from("agents").select("id, name, last_seen_at").eq("organization_id", orgId),
    supabase.from("organization_settings").select("default_booklet_binding_side").eq("organization_id", orgId).single(),
  ]);

  return (
    <div>
      <PageHeader
        title="Printers"
        action={
          session.membership.role === "org_admin" && (
            <Link
              href={routes.adminPrintersSetup}
              className="flex items-center gap-1.5 rounded-lg bg-[var(--color-primary)] px-4 py-3 text-sm font-medium text-[var(--color-primary-fg)] hover:opacity-90"
            >
              <Wand2 className="h-4 w-4" /> Guided setup wizard
            </Link>
          )
        }
      />
      <PrintersPanel
        printers={printers ?? []}
        profiles={(profiles ?? []).map(({ printers: _p, ...rest }) => rest)}
        agents={agents ?? []}
        canManage={session.membership.role === "org_admin"}
        defaultBookletBindingSide={settings?.default_booklet_binding_side === "right" ? "right" : "left"}
      />
    </div>
  );
}
