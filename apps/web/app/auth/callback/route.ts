import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { finishSignIn } from "@/lib/auth/finish-sign-in";
import { routes } from "@/lib/routes";
import { isPlausibleInviteCode } from "@/lib/auth/invite-link";
import { clientIpFrom } from "@/lib/auth/invite-rate-limit";

/** Redirect target for both sign-in methods - Google OAuth and Supabase
 *  magic-link (email OTP, app/login/MagicLinkForm.tsx). Establishes a session
 *  (Google: PKCE `code` exchange; magic link: server-side `token_hash`
 *  verifyOtp, which works from any browser), runs the (usually-a-no-op) single-org bootstrap
 *  check, stamps last_authenticated_at (the 30-day forced-reauth clock,
 *  docs/architecture.md sec 19), redeems an invite link if one came along,
 *  applies the org's "Who can join" rule (migration 0039), then redirects
 *  home - or to the "You need an invite" page for someone with no membership. */
/** Only these OTP types may be verified here. `recovery`, `invite`, `signup`,
 *  `email_change` etc. must never be redeemable through this sign-in route. */
const ALLOWED_OTP_TYPES = ["email", "magiclink"] as const;
type AllowedOtpType = (typeof ALLOWED_OTP_TYPES)[number];

function isAllowedOtpType(value: string | null): value is AllowedOtpType {
  return value !== null && (ALLOWED_OTP_TYPES as readonly string[]).includes(value);
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
    return finishSignIn(data.user, data.user.email, origin, invite);
  }

  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error && data.user?.email) {
      return finishSignIn(data.user, data.user.email, origin, invite);
    }
  }

  return NextResponse.redirect(`${origin}${routes.start}`);
}
