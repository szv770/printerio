import { createClient } from "@/lib/supabase/server";

export interface OrgFontOption {
  id: string;
  name: string;
  hasVowels: boolean;
  hasCantillation: boolean;
}

/**
 * The Hebrew fonts an organization's admins have uploaded (Admin -> Fonts), for the booklet form's font dropdown.
 * Reads with the signed-in member's own client: row-level security (migration 0052) lets members see only their own
 * organization's rows, and the organization filter below is the explicit scope on top of it. Names only - the font bytes are
 * never sent to a browser (loadOrgFontBytes in custom-font.ts reads them server-side, with the service role).
 */
export async function listOrgFonts(organizationId: string): Promise<OrgFontOption[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("org_fonts")
    .select("id, name, has_vowels, has_cantillation")
    .eq("organization_id", organizationId)
    .order("name", { ascending: true })
    .limit(50);
  if (error || !data) return [];
  return data.map((r) => ({ id: r.id, name: r.name, hasVowels: r.has_vowels, hasCantillation: r.has_cantillation }));
}
