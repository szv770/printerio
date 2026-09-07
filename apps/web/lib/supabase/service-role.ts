import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { getPublicEnv, getServiceRoleEnv } from "@/lib/env";

/**
 * Service-role client - BYPASSES ROW LEVEL SECURITY ENTIRELY. Never import
 * this into anything a client component could pull in; the `server-only`
 * import above makes any accidental client-bundle import a build error.
 *
 * Only use for the small, explicit set of operations documented in
 * docs/architecture.md that must legitimately bypass RLS:
 *   - organization bootstrap (lib/auth/bootstrap.ts)
 *   - invitation redemption
 *   - agent bearer-auth request handling (the Agent has no Supabase JWT at all)
 *   - the Vercel Cron retention/lease-expiry sweep
 *   - releasing a rejected job's quota reservation (app/admin/approvals):
 *     the approval queue is open to `approver`, but monthly_usage's UPDATE
 *     policy only admits the row's own user or an org_admin, so an approver's
 *     own session cannot refund the submitter. Strictly a decrease, on a job
 *     row already verified server-side to be in the caller's organization -
 *     see the comment at that call site.
 *   - the /platform super-admin console (app/platform/**): every cross-org
 *     read (the Overview page's per-organization stats), organization
 *     creation, super_admin promotion/demotion (RLS-blocked entirely for
 *     authenticated clients - see private.prevent_platform_role_escalation),
 *     and a super_admin self-granting org_admin access to a specific
 *     organization ("Join organization as admin"). Every one of these calls
 *     MUST sit behind requirePlatformRole() (lib/auth/session.ts) and only
 *     ever run in a Server Component or Server Action - never anything
 *     client-bundled.
 *
 * Every other read/write in this app must go through lib/supabase/server.ts
 * (or client.ts in the browser) so RLS is always the enforcement point.
 */
export function createServiceRoleClient() {
  const { NEXT_PUBLIC_SUPABASE_URL } = getPublicEnv();
  const { SUPABASE_SERVICE_ROLE_KEY } = getServiceRoleEnv();
  return createSupabaseClient<Database>(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
