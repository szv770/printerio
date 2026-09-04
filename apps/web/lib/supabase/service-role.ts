import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

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
 *
 * Every other read/write in this app must go through lib/supabase/server.ts
 * (or client.ts in the browser) so RLS is always the enforcement point.
 */
export function createServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_URL not configured");
  }
  return createSupabaseClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
