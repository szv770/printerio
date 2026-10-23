import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// Next.js 16 renamed the "middleware.ts" convention to "proxy.ts" (same
// mechanism, clarified naming - the exported function must be named `proxy`).
// See https://nextjs.org/docs/app/api-reference/file-conventions/proxy
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    // Skip static assets and image optimization; every route that could read
    // the session runs through here so it always sees a fresh token.
    "/((?!_next/static|_next/image|favicon.ico|sw\\.js$|manifest\\.webmanifest$|share-target$|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
