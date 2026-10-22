import "server-only";
import { timingSafeEqual } from "node:crypto";
import { apiError } from "@/lib/api-errors";
import { getCronSecret } from "@/lib/env";

/** Constant-time compare of two strings of possibly different length - avoids
 *  the length/content timing signal a plain `!==` would leak (consistent with
 *  lib/agent-auth.ts's device-secret comparison). */
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still run an equal-length comparison so "wrong length" is not measurably faster.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Shared guard for every cron route. Returns an error Response to send back,
 * or null when the caller presented a valid secret.
 *
 * Accepts PRINTIO_CRON_SECRET (what GitHub Actions / manual calls use) and,
 * if set, Vercel's own CRON_SECRET: Vercel Cron only ever attaches
 * `Authorization: Bearer $CRON_SECRET` for a variable literally named
 * CRON_SECRET, so without it the vercel.json schedules would 401.
 */
export function rejectUnlessCronAuthorized(request: Request): Response | null {
  let primary: string;
  try {
    primary = getCronSecret();
  } catch (err) {
    // Operator misconfiguration, not a bad caller: surface as a clear 500.
    return apiError(500, "misconfigured", err instanceof Error ? err.message : "Cron secret not configured.");
  }
  const accepted = [primary];
  const vercelSecret = process.env.CRON_SECRET;
  if (vercelSecret) accepted.push(vercelSecret);

  const authHeader = request.headers.get("authorization") ?? "";
  // Evaluate every candidate (no early exit) to keep timing uniform.
  const ok = accepted.map((s) => safeCompare(authHeader, `Bearer ${s}`)).some(Boolean);
  return ok ? null : apiError(401, "unauthenticated", "Invalid cron secret.");
}
