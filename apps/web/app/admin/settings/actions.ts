"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { isDomainJoinRole, validateJoinSettings } from "@/lib/auth/join-policy";
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

/** "Who can join" (security review F4, migration 0039): join_mode + allowed_domains +
 *  domain_join_role saved in ONE update, because the database refuses domain mode with
 *  an empty list. Matching itself is enforced in Postgres (join_org_by_domain), on the
 *  verified sign-in email. Only org admins (RLS: "org_admins can update their organization"). */
export async function updateAllowedDomainsAction(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const parsed = validateJoinSettings({
    mode: String(formData.get("joinMode") ?? ""),
    domainsInput: String(formData.get("domains") ?? ""),
  });
  if (!parsed.ok) return { error: parsed.error };
  const role = formData.get("domainJoinRole");
  if (!isDomainJoinRole(role)) return { error: "Choose whether people who join by email become students or staff." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("organizations")
    .update({ allowed_domains: parsed.domains, join_mode: parsed.mode, domain_join_role: role })
    .eq("id", session.membership.organization_id);
  if (error) return { error: describeDatabaseError(error, "Couldn't save who can join.") };

  revalidatePath(routes.adminSettings);
  return {
    success:
      parsed.mode === "invite_only"
        ? "Saved. Only people you invite can join."
        : `Saved. People can join with an invitation, or by signing in with a verified email at ${parsed.domains.join(", ")} (they join as ${role === "staff" ? "staff" : "students"}).`,
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

/** Updates organization_settings.auto_retry_failed_prints (supabase/migrations/0035_retry_failed_prints.sql): when
 *  on, a failed print is re-queued automatically until the job's max_attempts is reached, then stays failed with its
 *  message. Off by default - then the teacher presses "Try again". A checked checkbox submits "on"; an unchecked one
 *  submits nothing. If the migration has not been applied the column does not exist and the save fails with a plain
 *  message instead of silently doing nothing. */
export async function updateAutoRetryFailedPrintsAction(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const enabled = formData.get("autoRetryFailedPrints") === "on";

  const supabase = await createClient();
  const { error } = await supabase
    .from("organization_settings")
    .update({ auto_retry_failed_prints: enabled })
    .eq("organization_id", session.membership.organization_id);
  if (error) return { error: describeDatabaseError(error, "Couldn't save this setting.") };

  revalidatePath(routes.adminSettings);
  return {
    success: enabled
      ? "Saved. A print that fails will now be retried automatically until its tries run out."
      : "Saved. A failed print now waits for its sender to press Try again.",
  };
}
