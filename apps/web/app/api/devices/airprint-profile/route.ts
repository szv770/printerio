import { randomUUID } from "node:crypto";
import { getCurrentSession } from "@/lib/auth/session";
import { getGatewayEnv } from "@/lib/env";
import { buildAirPrintProfile, isDeviceHostname } from "@/lib/devices/airprint-profile";

/**
 * POST (form) { hostname, name? } -> the iPhone/iPad/Mac AirPrint profile for that device address.
 * A POST on purpose: the address is the device's secret, so it must not travel in a URL (which servers log). Signed-in
 * members only; the hostname must be a device address on OUR domain, so this cannot be used to point a profile elsewhere.
 * Nothing is stored. UNTESTED on a real iPhone.
 */
function fail(status: number, message: string): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== new URL(request.url).origin) return fail(403, "Not allowed.");

  const session = await getCurrentSession();
  if (!session) return fail(401, "Sign in first.");
  if (!session.membership) return fail(403, "Your account is not part of an organization yet.");

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail(400, "Bad request.");
  }
  const hostname = String(form.get("hostname") ?? "").trim();
  const { baseDomain } = getGatewayEnv();
  if (!baseDomain || !isDeviceHostname(hostname) || !hostname.endsWith(`.${baseDomain}`)) return fail(400, "That is not a Printio device address.");

  const rawName = String(form.get("name") ?? "").trim();
  const displayName = /^[A-Za-z0-9 ._-]{1,63}$/.test(rawName) ? rawName : "Printio";

  const profile = buildAirPrintProfile({ hostname, displayName, uuids: { content: randomUUID().toUpperCase(), profile: randomUUID().toUpperCase() } });
  return new Response(profile, {
    status: 200,
    headers: {
      "content-type": "application/x-apple-aspen-config; charset=utf-8",
      "content-disposition": 'attachment; filename="Printio.mobileconfig"',
      "cache-control": "no-store",
    },
  });
}
