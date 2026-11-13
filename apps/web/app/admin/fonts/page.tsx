import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { PageHeader } from "@/components/ui";
import { routes } from "@/lib/routes";
import { MAX_FONTS_PER_ORG } from "@/lib/booklet/custom-font";
import { FontsPanel } from "./FontsPanel";

export default async function AdminFontsPage() {
  const session = await requireOrgRole(["org_admin", "approver"]);
  // Fonts are an org_admin tool (the nav link is hidden for approvers too; this is the real gate).
  if (session.membership.role !== "org_admin") redirect(routes.admin);

  const supabase = await createClient();
  const { data } = await supabase
    .from("org_fonts")
    .select("id, name, file_name, size_bytes, has_vowels, has_cantillation, created_at")
    .eq("organization_id", session.membership.organization_id)
    .order("name", { ascending: true })
    .limit(MAX_FONTS_PER_ORG + 1);

  const fonts = (data ?? []).map((f) => ({
    id: f.id,
    name: f.name,
    fileName: f.file_name,
    sizeBytes: f.size_bytes,
    hasVowels: f.has_vowels,
    hasCantillation: f.has_cantillation,
  }));

  return (
    <div>
      <PageHeader
        title="Fonts"
        description="Hebrew fonts for the daily study booklets. Add one here and it shows up in the booklet's font list."
      />
      <FontsPanel fonts={fonts} maxFonts={MAX_FONTS_PER_ORG} />
    </div>
  );
}
