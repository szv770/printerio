/**
 * True when a cookie name is a Supabase auth-token cookie (sb-<ref>-auth-token,
 * including the chunked ".0", ".1" variants). Without one there is no session
 * to refresh, so the proxy can skip the auth round trip.
 */
export function isSupabaseAuthCookie(name: string): boolean {
  return /^sb-.+-auth-token(\.\d+)?$/.test(name);
}

export function hasSupabaseAuthCookie(cookies: ReadonlyArray<{ name: string }>): boolean {
  return cookies.some((c) => isSupabaseAuthCookie(c.name));
}
