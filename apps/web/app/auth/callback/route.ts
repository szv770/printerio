import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { maybeBootstrapOrganization } from "@/lib/auth/bootstrap";
import { routes } from "@/lib/routes";
import { logger } from "@/lib/logger";

/** Google OAuth redirect target. Exchanges the auth code for a session, runs
 *  the (usually-a-no-op) single-org bootstrap check, then redirects home. */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error && data.user?.email) {
      try {
        await maybeBootstrapOrganization(data.user.id, data.user.email);
      } catch (bootstrapError) {
        // Never fail sign-in over a bootstrap hiccup - log and continue; the
        // user lands on the "no access yet" screen instead of a hard error.
        logger.error("organization bootstrap failed", {
          userId: data.user.id,
          error: bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError),
        });
      }
    }
  }

  return NextResponse.redirect(`${origin}${routes.home}`);
}
