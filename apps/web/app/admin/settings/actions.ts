"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { parseAllowedDomainsInput } from "@/lib/auth/domains";
import { routes } from "@/lib/routes";

export interface SettingsActionState {
  error?: string;
}
const initial: SettingsActionState = {};
export { initial as initialSettingsActionState };

/** Updates organizations.allowed_domains - the sign-in domain gate for
 *  brand-new users (docs/architecture.md sec 19, email_domain_allowed() in
 *  supabase/migrations/0013_*.sql). An empty list means unrestricted. */
export async function updateAllowedDomainsAction(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const raw = String(formData.get("domains") ?? "");

  const { domains, invalid } = parseAllowedDomainsInput(raw);
  if (invalid.length > 0) {
    return {
      error: `Enter bare domains only (e.g. "lecfl.com"), not an email or URL. Couldn't parse: ${invalid.join(", ")}`,
    };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("organizations")
    .update({ allowed_domains: domains })
    .eq("id", session.membership.organization_id);
  if (error) return { error: error.message };

  revalidatePath(routes.adminSettings);
  return {};
}
