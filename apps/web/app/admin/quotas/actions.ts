"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { routes } from "@/lib/routes";

export interface QuotaActionState {
  error?: string;
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

  const { error } = await supabase.from("quotas").insert({
    organization_id: session.membership.organization_id,
    scope_type: scopeType,
    scope_value: scopeValue,
    period: "monthly",
    limit_value: limitValue,
  });
  if (error) return { error: error.message };

  revalidatePath(routes.adminQuotas);
  return {};
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
  if (error) return { error: error.message };

  revalidatePath(routes.adminQuotas);
  return {};
}
