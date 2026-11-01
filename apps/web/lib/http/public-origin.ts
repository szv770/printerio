/**
 * The address the browser actually used. Behind a reverse proxy or tunnel (Cloudflare -> http://localhost) the server
 * sees plain http and an internal host, so `new URL(request.url).origin` no longer equals the browser's `Origin`
 * header. This builds the public origin from the forwarded scheme + Host, and also trusts the configured app URL.
 */
function originOf(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function forwardedOrigin(request: Request): string | null {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host) return null;
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const scheme = proto === "https" || proto === "http" ? proto : new URL(request.url).protocol.replace(":", "");
  return originOf(`${scheme}://${host}`);
}

/** The origin to use when building absolute URLs for this request. */
export function publicOrigin(request: Request): string {
  return forwardedOrigin(request) ?? new URL(request.url).origin;
}

/** Browsers send Origin on cross-site POSTs; true when there is none or it is this site (as the browser sees it). */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  const allowed = new Set([new URL(request.url).origin, forwardedOrigin(request), originOf(process.env.NEXT_PUBLIC_APP_URL)]);
  return allowed.has(origin);
}
