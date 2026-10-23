import "server-only";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { checkInviteRateLimit } from "@/lib/auth/invite-rate-limit";
import { inviteStatus, isPlausibleInviteCode, type InviteStatus } from "@/lib/auth/invite-link";

export type InviteLookup =
  | { state: InviteStatus; orgName: string }
  | { state: "not_found" | "rate_limited" };

/** Public (signed-out) lookup behind the join page: tells the visitor which
 *  organization the code belongs to, and whether it still works. Rate limited
 *  per IP so it cannot be used to guess codes. Email-targeted invitations
 *  (no code) are never reachable from here. */
export async function lookupInvite(code: string | undefined, ip: string): Promise<InviteLookup> {
  if (!isPlausibleInviteCode(code)) return { state: "not_found" };
  const supabase = createServiceRoleClient();
  if (!(await checkInviteRateLimit(supabase, { ip }))) return { state: "rate_limited" };

  const { data: inv } = await supabase
    .from("organization_invitations")
    .select("uses_count, max_uses, expires_at, organization_id")
    .eq("code", code)
    .maybeSingle();
  if (!inv) return { state: "not_found" };
  const { data: org } = await supabase.from("organizations").select("name").eq("id", inv.organization_id).maybeSingle();
  return {
    state: inviteStatus({ usesCount: inv.uses_count, maxUses: inv.max_uses, expiresAt: inv.expires_at }),
    orgName: org?.name ?? "",
  };
}
