import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { QuotaBasis } from "@printos/shared";

type Client = SupabaseClient<Database>;

export interface QuotaContext {
  organizationId: string;
  userId: string;
  role: string;
  department: string | null;
  groupIds: string[];
}

export interface UsageAmounts {
  pdfPages: number;
  printedSides: number;
  physicalSheets: number;
  colorWeighted: number;
}

export function currentPeriod(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Most-restrictive-wins: if a user matches more than one configured quota
 * scope (e.g. their role AND their department both have a limit), the lowest
 * limit_value applies. Returns null if no quota is configured for this user
 * at all (unlimited).
 */
export async function getApplicableQuotaLimit(supabase: Client, ctx: QuotaContext): Promise<number | null> {
  const { data, error } = await supabase
    .from("quotas")
    .select("scope_type, scope_value, limit_value")
    .eq("organization_id", ctx.organizationId)
    .eq("period", "monthly");
  if (error) throw error;
  if (!data || data.length === 0) return null;

  const applicable = data.filter((q) => {
    switch (q.scope_type) {
      case "organization":
        return true;
      case "role":
        return q.scope_value === ctx.role;
      case "department":
        return ctx.department !== null && q.scope_value === ctx.department;
      case "group":
        return q.scope_value !== null && ctx.groupIds.includes(q.scope_value);
      case "user":
        return q.scope_value === ctx.userId;
      default:
        return false;
    }
  });
  if (applicable.length === 0) return null;
  return Math.min(...applicable.map((q) => q.limit_value));
}

export async function getUsageSnapshot(
  supabase: Client,
  organizationId: string,
  userId: string,
  period: string,
): Promise<UsageAmounts> {
  const { data } = await supabase
    .from("monthly_usage")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .eq("period", period)
    .maybeSingle();

  if (!data) return { pdfPages: 0, printedSides: 0, physicalSheets: 0, colorWeighted: 0 };

  return {
    pdfPages: data.pdf_pages_used + data.reserved_pdf_pages,
    printedSides: data.printed_sides_used + data.reserved_printed_sides,
    physicalSheets: data.physical_sheets_used + data.reserved_physical_sheets,
    colorWeighted: data.color_weighted_used + data.reserved_color_weighted,
  };
}

export function usageForBasis(usage: UsageAmounts, basis: QuotaBasis): number {
  switch (basis) {
    case "pdf_pages":
      return usage.pdfPages;
    case "printed_sides":
      return usage.printedSides;
    case "physical_sheets":
      return usage.physicalSheets;
    case "color_weighted":
      return usage.colorWeighted;
  }
}

/** Read-only usage percentage for policy-engine facts / UI preview. Null if unlimited. */
export async function computeQuotaUsagePct(
  supabase: Client,
  ctx: QuotaContext,
  basis: QuotaBasis,
): Promise<number | null> {
  const limit = await getApplicableQuotaLimit(supabase, ctx);
  if (limit === null) return null;
  const usage = await getUsageSnapshot(supabase, ctx.organizationId, ctx.userId, currentPeriod());
  return Math.min(999, Math.round((usageForBasis(usage, basis) / limit) * 100));
}

export type QuotaAdjustMode = "reserve" | "release" | "consume";

/**
 * Atomic reserve/release/consume via the `adjust_monthly_usage` Postgres
 * function - see supabase/migrations/0010_quota_functions.sql and
 * docs/architecture.md sec 14. Runs as the caller's own session (RLS-governed
 * - no service-role needed for an ordinary submission).
 *
 * @returns false only for `mode: "reserve"` when the limit would be exceeded
 *   (the underlying UPDATE affected zero rows); always true for release/consume.
 */
export async function adjustMonthlyUsage(
  supabase: Client,
  ctx: Pick<QuotaContext, "organizationId" | "userId">,
  amounts: UsageAmounts,
  basis: QuotaBasis,
  limit: number | null,
  mode: QuotaAdjustMode,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("adjust_monthly_usage", {
    p_organization_id: ctx.organizationId,
    p_user_id: ctx.userId,
    p_period: currentPeriod(),
    p_pdf_pages: amounts.pdfPages,
    p_printed_sides: amounts.printedSides,
    p_physical_sheets: amounts.physicalSheets,
    p_color_weighted: amounts.colorWeighted,
    p_quota_basis: basis,
    p_limit: limit,
    p_mode: mode,
  });
  if (error) throw error;
  return data === true;
}
