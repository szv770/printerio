"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { describeDatabaseError } from "@/lib/action-errors";
import { findQuotaForScope } from "@/lib/quota";
import { routes } from "@/lib/routes";

export interface QuotaActionState {
  error?: string;
  success?: string;
}
const initial: QuotaActionState = {};
export { initial as initialQuotaActionState };

const VALID_SCOPE_TYPES = ["organization", "role", "department", "group", "user"];
const VALID_ROLES = ["student", "staff", "approver", "org_admin"];

export async function createQuotaAction(_prev: QuotaActionState, formData: FormData): Promise<QuotaActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const scopeType = String(formData.get("scopeType") ?? "");
  const scopeValueRaw = String(formData.get("scopeValue") ?? "").trim();
  const limitRaw = String(formData.get("limitValue") ?? "");

  if (!VALID_SCOPE_TYPES.includes(scopeType)) return { error: "Invalid scope type." };

  const limitValue = Number.parseInt(limitRaw, 10);
  if (!Number.isFinite(limitValue) || limitValue <= 0) return { error: "Limit must be a positive whole number." };

  let scopeValue: string | null;
  if (scopeType === "organization") {
    scopeValue = null;
  } else {
    if (!scopeValueRaw) return { error: "This scope type needs a value (role, department, group, or user)." };
    if (scopeType === "role" && !VALID_ROLES.includes(scopeValueRaw)) return { error: "Invalid role." };
    scopeValue = scopeValueRaw;
  }

  const supabase = await createClient();

  // group/user scope values must belong to this org - the RLS policy already
  // enforces organization_id on the quota row itself, but scope_value is a
  // free-standing FK-less reference (see supabase/migrations/0002_printing_tables.sql),
  // so it's worth a light sanity check here rather than silently accepting a
  // stray id from another org that will just never match anyone.
  if (scopeType === "group") {
    const { data } = await supabase
      .from("groups")
      .select("organization_id")
      .eq("id", scopeValue!)
      .maybeSingle();
    if (data?.organization_id !== session.membership.organization_id) return { error: "Group not found." };
  }
  if (scopeType === "user") {
    const { data } = await supabase
      .from("organization_members")
      .select("organization_id")
      .eq("user_id", scopeValue!)
      .eq("organization_id", session.membership.organization_id)
      .maybeSingle();
    if (!data) return { error: "Member not found in this organization." };
  }

  // Edit an existing quota for this exact scope rather than stacking a second
  // row behind it. `quotas` has no unique constraint on the scope, and
  // getApplicableQuotaLimit is most-restrictive-wins - so adding a second,
  // HIGHER limit for a scope that already has one used to do nothing
  // observable at all: the old, lower row kept winning and the admin was left
  // wondering why the user was still blocked. See lib/quota.ts's
  // findQuotaForScope.
  const { data: existingRows, error: readError } = await supabase
    .from("quotas")
    .select("id, scope_type, scope_value, limit_value")
    .eq("organization_id", session.membership.organization_id)
    .eq("period", "monthly");
  if (readError) return { error: describeDatabaseError(readError, "Couldn't read this organization's existing quotas.") };

  const existing = findQuotaForScope(existingRows ?? [], scopeType, scopeValue);
  if (existing) {
    if (existing.limit_value === limitValue) {
      return { success: `That scope is already limited to ${limitValue.toLocaleString()} per month - nothing to change.` };
    }
    const { error: updateError } = await supabase
      .from("quotas")
      .update({ limit_value: limitValue })
      .eq("id", existing.id)
      .eq("organization_id", session.membership.organization_id);
    if (updateError) return { error: describeDatabaseError(updateError, "Couldn't update that quota.") };

    revalidatePath(routes.adminQuotas);
    return {
      success: `This scope already had a quota - changed it from ${existing.limit_value.toLocaleString()} to ${limitValue.toLocaleString()} per month.`,
    };
  }

  const { error } = await supabase.from("quotas").insert({
    organization_id: session.membership.organization_id,
    scope_type: scopeType,
    scope_value: scopeValue,
    period: "monthly",
    limit_value: limitValue,
  });
  if (error) return { error: describeDatabaseError(error, "Couldn't add that quota.") };

  revalidatePath(routes.adminQuotas);
  return { success: `Quota set to ${limitValue.toLocaleString()} per month.` };
}

export async function deleteQuotaAction(_prev: QuotaActionState, formData: FormData): Promise<QuotaActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const quotaId = String(formData.get("quotaId") ?? "");

  const supabase = await createClient();
  const { error } = await supabase
    .from("quotas")
    .delete()
    .eq("id", quotaId)
    .eq("organization_id", session.membership.organization_id);
  if (error) return { error: describeDatabaseError(error, "Couldn't remove that quota.") };

  revalidatePath(routes.adminQuotas);
  return {};
}
