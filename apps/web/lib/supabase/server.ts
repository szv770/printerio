import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "@/lib/database.types";

/**
 * Server-side Supabase client for Server Components/Actions/Route Handlers.
 * Runs as the authenticated user (RLS-governed) via their session cookie -
 * this is NOT the service-role client. See lib/supabase/service-role.ts for
 * the small, explicit set of operations that must bypass RLS.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch {
            // Called from a Server Component (not a Server Action/Route
            // Handler) - cookies() is read-only there. Safe to ignore because
            // middleware.ts refreshes the session on every request.
          }
        },
      },
    },
  );
}
