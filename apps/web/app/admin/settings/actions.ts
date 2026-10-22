"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { parseAllowedDomainsInput } from "@/lib/auth/domains";
import { describeDatabaseError } from "@/lib/action-errors";
import { routes } from "@/lib/routes";
import { normalizeStampSettings } from "@/lib/jobs/user-code";

export interface SettingsActionState {
  error?: string;
  /** Every form on this page saves a value the page can't visibly reflect
   *  back (a checkbox that was already checked, a textarea that already had
   *  the text in it), so without an explicit confirmation an admin clicking
   *  Save gets no signal at all and can't tell success from a dead button. */
  success?: string;
}

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

/** Updates organization_settings.admins_bypass_restrictions - whether an
 *  org_admin's own print jobs skip a require_approval/deny policy outcome
 *  and quota blocking (still recorded and shown as a warning, never hidden -
 *  see lib/policy/admin-bypass.ts and 0021_admin_bypass_restrictions.sql).
 *  Defaults on; this is how an org turns that off deliberately if it wants
 *  its own admins held to the same rules as everyone else. A checked
 *  checkbox submits "on"; an unchecked one submits nothing, so its absence
 *  from formData means false. */
export async function updateAdminsBypassRestrictionsAction(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const bypass = formData.get("adminsBypassRestrictions") === "on";

  const supabase = await createClient();
  const { error } = await supabase
    .from("organization_settings")
    .update({ admins_bypass_restrictions: bypass })
    .eq("organization_id", session.membership.organization_id);
  if (error) return { error: describeDatabaseError(error, "Couldn't save this setting.") };

  revalidatePath(routes.adminSettings);
  return {
    success: bypass
      ? "Saved. Admins' own print jobs will no longer be held up by approval/quota rules (still shown as a warning when one would otherwise have applied)."
      : "Saved. Admins are now subject to the same approval and quota rules as everyone else.",
  };
}

/** Updates the organization-level print stamp: whether every job gets its sender's user code stamped on page 1,
 *  what it shows, and how dark it is (organization_settings.stamp_*, supabase/migrations/0033_print_stamp.sql).
 *  Applies to jobs created from now on; a job already created keeps the file it was created with. A checked
 *  checkbox submits "on"; an unchecked one submits nothing, so its absence means off. */
export async function updateStampSettingsAction(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const parsed = normalizeStampSettings({
    stamp_enabled: formData.get("stampEnabled") === "on",
    stamp_show: String(formData.get("stampShow") ?? ""),
    stamp_strength: String(formData.get("stampStrength") ?? ""),
  });

  const supabase = await createClient();
  const { error } = await supabase
    .from("organization_settings")
    .update({ stamp_enabled: parsed.enabled, stamp_show: parsed.show, stamp_strength: parsed.strength })
    .eq("organization_id", session.membership.organization_id);
  if (error) return { error: describeDatabaseError(error, "Couldn't save the print stamp settings.") };

  revalidatePath(routes.adminSettings);
  return {
    success: parsed.enabled
      ? "Saved. New print jobs will carry the user code on page 1."
      : "Saved. New print jobs will not be stamped.",
  };
}
