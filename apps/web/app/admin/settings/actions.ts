"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { parseAllowedDomainsInput } from "@/lib/auth/domains";
import { describeDatabaseError } from "@/lib/action-errors";
import { routes } from "@/lib/routes";

export interface SettingsActionState {
  error?: string;
  /** Every form on this page saves a value the page can't visibly reflect
   *  back (a checkbox that was already checked, a textarea that already had
   *  the text in it), so without an explicit confirmation an admin clicking
   *  Save gets no signal at all and can't tell success from a dead button. */
  success?: string;
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
  if (error) return { error: describeDatabaseError(error, "Couldn't save the allowed sign-in domains.") };

  revalidatePath(routes.adminSettings);
  return {
    success:
      domains.length === 0
        ? "Saved. Sign-in is no longer restricted by email domain."
        : `Saved. New users may now sign in from: ${domains.join(", ")}.`,
  };
}

/** Updates organization_settings.default_booklet_binding_side - the binding
 *  side ("left edge binding" / "right edge binding", matching the Kyocera KX
 *  driver's own booklet Layout-tab terminology - docs/architecture.md sec 8)
 *  a NEW booklet-capable printer_profiles row is prefilled with
 *  (app/admin/printers). Never touches any existing profile or in-flight
 *  job - see supabase/migrations/0017_*.sql's column comment. */
export async function updateDefaultBookletBindingSideAction(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const bindingSide = formData.get("defaultBookletBindingSide") === "right" ? "right" : "left";

  const supabase = await createClient();
  const { error } = await supabase
    .from("organization_settings")
    .update({ default_booklet_binding_side: bindingSide })
    .eq("organization_id", session.membership.organization_id);
  if (error) return { error: describeDatabaseError(error, "Couldn't save the default booklet binding side.") };

  revalidatePath(routes.adminSettings);
  return {
    success: `Saved. New booklet-capable printer profiles will default to ${
      bindingSide === "right" ? "right edge binding (RTL)" : "left edge binding (LTR)"
    }.`,
  };
}

/** Updates organizations.magic_link_requires_allowed_domain - whether
 *  magic-link (email OTP) sign-in is subject to the same allowed_domains
 *  gate Google OAuth always enforces, or open to any email address
 *  (docs/architecture.md sec 19.3, email_domain_allowed_for_magic_link() in
 *  supabase/migrations/0014_*.sql). Never touches Google OAuth's gate, which
 *  has no toggle at all. A checked checkbox submits "on"; an unchecked one
 *  submits nothing, so its absence from formData means false. */
export async function updateMagicLinkDomainToggleAction(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const requireAllowedDomain = formData.get("magicLinkRequiresAllowedDomain") === "on";

  const supabase = await createClient();
  const { error } = await supabase
    .from("organizations")
    .update({ magic_link_requires_allowed_domain: requireAllowedDomain })
    .eq("id", session.membership.organization_id);
  if (error) return { error: describeDatabaseError(error, "Couldn't save the magic-link sign-in setting.") };

  revalidatePath(routes.adminSettings);
  return {
    success: requireAllowedDomain
      ? "Saved. Magic-link sign-in is now restricted to the allowed domains above."
      : "Saved. Magic-link sign-in is now open to any email domain.",
  };
}
