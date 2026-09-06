/**
 * Detects which identity provider a just-completed sign-in actually used -
 * Google OAuth vs Supabase magic-link (email OTP) - so
 * app/auth/callback/route.ts can branch to the right domain gate
 * (email_domain_allowed() vs email_domain_allowed_for_magic_link(),
 * supabase/migrations/0014_*.sql). Getting this wrong would silently apply
 * (or fail to apply) the wrong organization's toggle to the wrong sign-in
 * method, so this is deliberately its own small, testable module rather than
 * an inline check in the callback route.
 *
 * Why not `user.app_metadata.provider`: per @supabase/auth-js's own type
 * (UserAppMetadata.provider - "the first provider that the user used to sign
 * up with"), that field is a lifetime property of the account, not of this
 * specific sign-in. An account that first signed up via Google and later
 * also linked a magic-link ("email") identity would keep reporting "google"
 * forever, even on a sign-in that just used magic link - the wrong answer
 * for this callback, which needs to know how *this* session was created.
 *
 * Instead this reads `user.identities[]` (each a UserIdentity with its own
 * `provider` and `last_sign_in_at`, confirmed in the installed
 * @supabase/auth-js's dist/module/lib/types.d.ts) and picks the identity
 * with the most recent `last_sign_in_at` - Supabase stamps that field fresh,
 * on the specific identity that was actually used, every time
 * exchangeCodeForSession succeeds. That is the one accurate way (short of
 * decoding the session JWT's `amr` claim) to answer "which provider did
 * *this* sign-in use," using data already returned by
 * exchangeCodeForSession with no extra network round trip.
 *
 * Falls back to `app_metadata.provider` only if `identities` is empty/absent
 * (shouldn't happen right after a successful code exchange, but keeps this
 * total rather than throwing on an unexpected shape).
 */

export interface SignInIdentity {
  provider: string;
  last_sign_in_at?: string;
}

export interface SignInUser {
  app_metadata?: { provider?: string } | null;
  identities?: SignInIdentity[] | null;
}

export const GOOGLE_PROVIDER = "google";

export function detectSignInProvider(user: SignInUser): string | null {
  const identities = user.identities ?? [];
  if (identities.length === 0) {
    return user.app_metadata?.provider ?? null;
  }

  let latest = identities[0]!;
  let latestTime = parseTimestamp(latest.last_sign_in_at);
  for (const identity of identities.slice(1)) {
    const time = parseTimestamp(identity.last_sign_in_at);
    if (time > latestTime) {
      latest = identity;
      latestTime = time;
    }
  }
  return latest.provider;
}

/** Whether this sign-in was Google OAuth specifically - everything else
 *  (in practice, always "email" in this app, which has no password path) is
 *  treated as magic link. */
export function isGoogleSignIn(user: SignInUser): boolean {
  return detectSignInProvider(user) === GOOGLE_PROVIDER;
}

function parseTimestamp(value: string | undefined): number {
  if (!value) return -Infinity;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? -Infinity : parsed;
}
