import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { maybeBootstrapOrganization } from "@/lib/auth/bootstrap";
import { emailDomain } from "@/lib/auth/domains";
import { routes } from "@/lib/routes";
import { logger } from "@/lib/logger";

/** Google OAuth redirect target. Exchanges the auth code for a session, runs
 *  the (usually-a-no-op) single-org bootstrap check, enforces the org's
 *  allowed_domains sign-in gate for brand-new users (docs/architecture.md
 *  sec 19), stamps last_authenticated_at (the 30-day forced-reauth clock -
 *  same section), then redirects home. */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error && data.user?.email) {
      const userId = data.user.id;
      const email = data.user.email;

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
      // docs/architecture.md sec 19). Fails OPEN on an unexpected DB error -
      // this is a narrower access gate on top of RLS/invitations, not the
      // primary security boundary (same fail-open philosophy already used
      // for check_rate_limit, sec 18), so an outage here must not lock every
      // legitimate user out of the app.
      let domainAllowed = true;
      try {
        const { data: allowed, error: rpcError } = await supabase.rpc("email_domain_allowed");
        if (rpcError) {
          logger.error("email domain check failed", { userId, error: rpcError.message });
        } else {
          domainAllowed = allowed ?? true;
        }
      } catch (domainCheckError) {
        logger.error("email domain check threw", {
          userId,
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
      const { error: touchError } = await supabase
        .from("profiles")
        .update({ last_authenticated_at: new Date().toISOString() })
        .eq("id", userId);
      if (touchError) {
        logger.error("failed to stamp last_authenticated_at", { userId, error: touchError.message });
      }
    }
  }

  return NextResponse.redirect(`${origin}${routes.home}`);
}
