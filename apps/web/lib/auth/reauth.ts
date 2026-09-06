/**
 * Forces a full interactive re-authentication at least every 30 days,
 * independent of Supabase's own refresh-token lifetime (which otherwise
 * refreshes silently forever - there is no built-in "expire the session for
 * real after N days" primitive). See docs/architecture.md sec 19.
 *
 * `profiles.last_authenticated_at` is set to now() in exactly one place -
 * app/auth/callback/route.ts, right after a real `exchangeCodeForSession`
 * succeeds (a genuine interactive OAuth redirect). It is never touched by
 * the silent background token refresh that runs on every request via
 * proxy.ts/lib/supabase/middleware.ts (that path only calls
 * `supabase.auth.getUser()`, which never calls `exchangeCodeForSession`) -
 * so this clock only resets on a real sign-in, which is what makes the
 * 30-day cap actually bite instead of being reset on every page load.
 */
export const REAUTH_MAX_AGE_DAYS = 30;
const REAUTH_MAX_AGE_MS = REAUTH_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

/**
 * A null `lastAuthenticatedAt` is treated as expired (fail closed) - it means
 * either a pre-migration row that somehow missed the backfill, or a profile
 * this code path never actually stamped, and re-authenticating is always a
 * safe, cheap way to resolve that ambiguity.
 */
export function isReauthRequired(lastAuthenticatedAt: string | null, now: Date): boolean {
  if (!lastAuthenticatedAt) return true;
  const last = new Date(lastAuthenticatedAt).getTime();
  if (Number.isNaN(last)) return true;
  return now.getTime() - last > REAUTH_MAX_AGE_MS;
}
