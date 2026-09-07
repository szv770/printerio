import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { logger } from "@/lib/logger";

/**
 * Refreshes the Supabase session cookie on every request. Required because
 * Server Components cannot write cookies themselves (see server.ts) - this is
 * the one place that reliably can, per @supabase/ssr's documented Next.js
 * middleware pattern.
 */
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  // This proxy/middleware runs on essentially every request (see
  // apps/web/proxy.ts's matcher) - a real production incident happened
  // because of exactly that: a malformed NEXT_PUBLIC_SUPABASE_URL made
  // @supabase/ssr's createServerClient throw synchronously
  // ("Invalid supabaseUrl: Must be a valid HTTP or HTTPS URL"), which
  // crashed literally every page load site-wide with a generic 500 and no
  // indication of which env var was wrong. lib/env.ts's getPublicEnv()
  // already produces a clear, specific error naming the exact missing/
  // invalid variable - but only for code paths that call it, which this
  // file historically bypassed (reading process.env directly with `!`
  // assertions). Wrapping this in try/catch so a misconfigured env var
  // degrades to "this one request's session isn't refreshed" instead of
  // "every request throws" - the specific page/route being visited will
  // still hit its own createClient()/getPublicEnv() and produce that clear,
  // actionable error for itself, rather than never getting the chance to.
  try {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
            supabaseResponse = NextResponse.next({ request });
            cookiesToSet.forEach(({ name, value, options }) => supabaseResponse.cookies.set(name, value, options));
          },
        },
      },
    );

    // Do not remove: this call refreshes the auth token and must run on
    // every request that might need an updated session.
    await supabase.auth.getUser();
  } catch (error) {
    logger.error("middleware session refresh failed - continuing without a refreshed session", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return supabaseResponse;
}
