import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { getBuildInfo } from "@/lib/build-info";

export const dynamic = "force-dynamic";

const DATABASE_TIMEOUT_MS = 3_000;

/**
 * GET /api/health - is the website itself running, and which build is it?
 *
 *   /api/health          -> always 200 while the site answers. This is what a deploy waits for (and rolls back on),
 *                           so a database hiccup can never make a good release look broken.
 *   /api/health?deep=1   -> also pings the database; 503 "degraded" if it does not answer in 3 s. This is what an
 *                           outside uptime monitor should watch.
 *
 * It never contacts a print server or the gateway: the website must be healthy with every print server off
 * (owner rule, 2026-11-18). No secrets and nothing tenant-scoped in the answer (build metadata only), and it skips the
 * sign-in middleware (proxy.ts matcher) so it answers even when Supabase auth is down.
 */
export async function GET(request: Request): Promise<Response> {
  const build = getBuildInfo();
  const base = { service: "printio-web", version: build.version, commit: build.commitSha, builtAt: build.builtAt };
  const headers = { "cache-control": "no-store" };

  if (new URL(request.url).searchParams.get("deep") !== "1") {
    return Response.json({ status: "ok", ...base }, { headers });
  }

  const database = await pingDatabase();
  return Response.json(
    { status: database === "ok" ? "ok" : "degraded", ...base, database },
    { status: database === "ok" ? 200 : 503, headers },
  );
}

async function pingDatabase(): Promise<"ok" | "down"> {
  try {
    const supabase = createServiceRoleClient();
    const query = supabase.from("organizations").select("id", { head: true }).limit(1);
    const result = await Promise.race([
      Promise.resolve(query).then((r) => (r.error ? "down" : "ok")),
      new Promise<"down">((resolve) => setTimeout(() => resolve("down"), DATABASE_TIMEOUT_MS).unref?.()),
    ]);
    return result;
  } catch {
    return "down";
  }
}
