import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { finishSignIn } from "@/lib/auth/finish-sign-in";
import { isPlausibleInviteCode } from "@/lib/auth/invite-link";
import { clientIpFrom } from "@/lib/auth/invite-rate-limit";
import { logger } from "@/lib/logger";

/** Sign in with the short code from the sign-in email. This is for the person who asked for the email in one browser
 *  window but opened it somewhere else: they type the code into the window they started in. Same verification and
 *  same post-login steps as the emailed link (lib/auth/finish-sign-in.ts). */
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WINDOW_SECONDS = 15 * 60;
const MAX_PER_EMAIL = 10;
const MAX_PER_IP = 30;

function json(body: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

/** Browsers always send Origin on a cross-site POST; refuse one that is not this site. */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin === null || origin === new URL(request.url).origin;
}

async function underRateLimit(email: string, ip: string): Promise<boolean> {
  const client = createServiceRoleClient();
  for (const [key, max] of [
    [`login_code:email:${email}`, MAX_PER_EMAIL],
    [`login_code:ip:${ip}`, MAX_PER_IP],
  ] as const) {
    const { data, error } = await client.rpc("check_rate_limit", {
      p_key: key,
      p_max_count: max,
      p_window_seconds: WINDOW_SECONDS,
    });
    if (!error && data === false) return false; // fails open on a database error, like the other limiters
  }
  return true;
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Not allowed." }, 403);

  let body: { email?: unknown; code?: unknown; invite?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Enter your email and the code from the email." }, 400);
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const code = typeof body.code === "string" ? body.code.replace(/\s+/g, "") : "";
  if (!LOOKS_LIKE_EMAIL.test(email) || !/^\d{6,8}$/.test(code)) {
    return json({ error: "Enter the email you used and the numeric code from the email." }, 400);
  }

  const ip = clientIpFrom(request.headers);
  if (!(await underRateLimit(email, ip))) {
    return json({ error: "Too many tries. Please wait a few minutes and try again." }, 429);
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.verifyOtp({ email, token: code, type: "email" });
  if (error || !data.user?.email) {
    logger.info("sign-in code rejected", { reason: error?.message ?? "no user" });
    return json({ error: "That code didn't work or has expired. Check it, or request a new one." }, 401);
  }

  const invite = typeof body.invite === "string" && isPlausibleInviteCode(body.invite) ? { code: body.invite, ip } : undefined;
  const origin = new URL(request.url).origin;
  const done = await finishSignIn(data.user, data.user.email, origin, invite);
  const location = done.headers.get("location");
  const path = location ? new URL(location, origin).pathname + new URL(location, origin).search : "/";
  return json({ redirect: path }, 200);
}
