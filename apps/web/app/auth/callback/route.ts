import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { maybeBootstrapOrganization } from "@/lib/auth/bootstrap";
import { emailDomain } from "@/lib/auth/domains";
import { isGoogleSignIn } from "@/lib/auth/provider";
import { routes } from "@/lib/routes";
import { logger } from "@/lib/logger";
import { redeemInvitation } from "@/lib/auth/invitations";
import { isPlausibleInviteCode } from "@/lib/auth/invite-link";
import { clientIpFrom } from "@/lib/auth/invite-rate-limit";

/** Redirect target for both sign-in methods - Google OAuth and Supabase
 *  magic-link (email OTP, app/login/MagicLinkForm.tsx). Establishes a session
 *  (Google: PKCE `code` exchange; magic link: server-side `token_hash`
 *  verifyOtp, which works from any browser), runs the (usually-a-no-op) single-org bootstrap
 *  check, enforces the org's allowed_domains sign-in gate for brand-new
 *  users (docs/architecture.md sec 19) - a different gate function per
 *  method, see below - stamps last_authenticated_at (the 30-day
 *  forced-reauth clock - same section), then redirects home. */
/** Only these OTP types may be verified here. `recovery`, `invite`, `signup`,
 *  `email_change` etc. must never be redeemable through this sign-in route. */
const ALLOWED_OTP_TYPES = ["email", "magiclink"] as const;
type AllowedOtpType = (typeof ALLOWED_OTP_TYPES)[number];

function isAllowedOtpType(value: string | null): value is AllowedOtpType {
  return value !== null && (ALLOWED_OTP_TYPES as readonly string[]).includes(value);
}

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;
type SessionUser = NonNullable<
  Awaited<ReturnType<SupabaseServerClient["auth"]["exchangeCodeForSession"]>>["data"]["user"]
>;

/** Post-login steps shared by BOTH entry paths (code exchange and token-hash
 *  verification): bootstrap, domain gate, reauth stamp, redirect. */
async function finishSignIn(
  supabase: SupabaseServerClient,
  user: SessionUser,
  email: string,
  origin: string,
  invite?: { code: string; ip: string },
): Promise<NextResponse> {
  const userId = user.id;

  try {
    await maybeBootstrapOrganization(userId, email);
  } catch (bootstrapError) {
    // Never fail sign-in over a bootstrap hiccup - log and continue; the
    // user lands on the "no access yet" screen instead of a hard error.
    logger.error("organization bootstrap failed", {
      userId,
      error: bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError),
    });
  }

  // Domain gate (see supabase/migrations/0013_domain_restriction_and_reauth.sql,
  // 0014_magic_link_domain_toggle.sql, docs/architecture.md sec 19).
  // Google OAuth always goes through email_domain_allowed() exactly as
  // before - unchanged, no toggle, always enforced. A magic-link sign-in
  // instead goes through email_domain_allowed_for_magic_link(), which
  // additionally honors each organization's
  // magic_link_requires_allowed_domain toggle (lib/auth/provider.ts
  // explains why identities[]/last_sign_in_at, not
  // app_metadata.provider, is what decides which sign-in method this
  // was). Fails OPEN on an unexpected DB error either way - this is a
  // narrower access gate on top of RLS/invitations, not the primary
  // security boundary (same fail-open philosophy already used for
  // check_rate_limit, sec 18), so an outage here must not lock every
  // legitimate user out of the app.
  const domainCheckFn = isGoogleSignIn(user)
    ? "email_domain_allowed"
    : "email_domain_allowed_for_magic_link";
  let domainAllowed = true;
  try {
    const { data: allowed, error: rpcError } = await supabase.rpc(domainCheckFn);
    if (rpcError) {
      logger.error("email domain check failed", { userId, domainCheckFn, error: rpcError.message });
    } else {
      domainAllowed = allowed ?? true;
    }
  } catch (domainCheckError) {
    logger.error("email domain check threw", {
      userId,
      domainCheckFn,
      error: domainCheckError instanceof Error ? domainCheckError.message : String(domainCheckError),
    });
  }

  if (!domainAllowed) {
    await supabase.auth.signOut();
    const domain = emailDomain(email);
    const url = new URL(`${origin}${routes.noAccess}`);
    url.searchParams.set("reason", "domain_not_allowed");
    if (domain) url.searchParams.set("domain", domain);
    return NextResponse.redirect(url);
  }

  // Only stamp the reauth clock for a sign-in that was actually accepted
  // (see lib/auth/reauth.ts) - never for one just rejected above.
  //
  // Must go through the service-role client, not the ordinary
  // session-scoped `supabase` used above for exchangeCodeForSession:
  // supabase/migrations/0016_protect_last_authenticated_at.sql adds a
  // trigger that rejects any change to this column from a caller whose
  // role isn't service_role (closing a real hole where any authenticated
  // client could otherwise re-stamp its own row and defeat the 30-day
  // reauth control entirely - see that migration's own comment). Using
  // the ordinary client here would have every legitimate sign-in's
  // update silently rejected by that same trigger, which is exactly the
  // bug this comment is warning against re-introducing.
  const { error: touchError } = await createServiceRoleClient()
    .from("profiles")
    .update({ last_authenticated_at: new Date().toISOString() })
    .eq("id", userId);
  if (touchError) {
    logger.error("failed to stamp last_authenticated_at", { userId, error: touchError.message });
  }

  // Invite link (/join?code=...): the code travelled through the emailed
  // link (or a cookie set on the join page), so the person never types it.
  if (invite) {
    const result = await redeemInvitation(invite.code, userId, email, { ip: invite.ip });
    if (!result.ok && result.reason !== "already_member") {
      const url = new URL(`${origin}${routes.noAccess}`);
      url.searchParams.set("code", invite.code);
      url.searchParams.set("invite_error", result.reason);
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.redirect(`${origin}${routes.home}`);
}

/** The invite code for this sign-in: ?invite= wins, else the join-page cookie. */
function inviteFromRequest(request: Request, searchParams: URLSearchParams): { code: string; ip: string } | undefined {
  const fromQuery = searchParams.get("invite");
  const cookie = /(?:^|;\s*)printio_invite=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
  const code = fromQuery ?? (cookie ? decodeURIComponent(cookie) : null);
  return isPlausibleInviteCode(code) ? { code, ip: clientIpFrom(request.headers) } : undefined;
}

function loginLinkInvalid(origin: string): NextResponse {
  const url = new URL(`${origin}${routes.login}`);
  url.searchParams.set("reason", "link_invalid");
  return NextResponse.redirect(url);
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const invite = inviteFromRequest(request, searchParams);

  // Cross-browser magic link: verified server-side, so it does not need the
  // PKCE code-verifier cookie (which is missing when the email link opens in
  // a different browser, e.g. the Gmail in-app browser).
  if (tokenHash) {
    const type = searchParams.get("type");
    if (!isAllowedOtpType(type)) return loginLinkInvalid(origin);
    const supabase = await createClient();
    const { data, error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (error || !data.user?.email) return loginLinkInvalid(origin);
    return finishSignIn(supabase, data.user, data.user.email, origin, invite);
  }

  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error && data.user?.email) {
      return finishSignIn(supabase, data.user, data.user.email, origin, invite);
    }
  }

  return NextResponse.redirect(`${origin}${routes.home}`);
}
