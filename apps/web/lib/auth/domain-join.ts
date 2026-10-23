import "server-only";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { logger } from "@/lib/logger";

/**
 * Asks Postgres (join_org_by_domain, migration 0039, service role only) to add
 * the signed-in user to an org that lets their VERIFIED email domain join.
 * Fails CLOSED: any error means "not joined" (the person lands on the
 * "You need an invite" page), never "joined".
 */
export async function tryJoinByDomain(userId: string): Promise<string | null> {
  try {
    const { data, error } = await createServiceRoleClient().rpc("join_org_by_domain", { p_user_id: userId });
    if (error) {
      logger.error("join by domain failed", { userId, error: error.message });
      return null;
    }
    return typeof data === "string" ? data : null;
  } catch (e) {
    logger.error("join by domain threw", { userId, error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** True when the user has an active membership in any organization (service-role read, by id from the verified session). */
export async function hasActiveMembership(userId: string): Promise<boolean> {
  const { data, error } = await createServiceRoleClient()
    .from("organization_members")
    .select("organization_id")
    .eq("user_id", userId)
    .eq("status", "active")
    .limit(1);
  if (error) {
    logger.error("membership check failed", { userId, error: error.message });
    return false;
  }
  return (data?.length ?? 0) > 0;
}
