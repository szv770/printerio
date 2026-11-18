import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { routes } from "@/lib/routes";
import { isReauthRequired } from "@/lib/auth/reauth";
import type { Tables } from "@/lib/database.types";
import type { OrgRole } from "@printio/shared";

export interface CurrentSession {
  userId: string;
  email: string;
  profile: SessionProfile;
  /** The user's first active organization membership (see docs/architecture.md
   *  sec 2.1 - schema supports multi-org membership; this build's UI assumes
   *  one active org per user, which is a UI simplification, not an RLS one). */
  membership: SessionMembership | null;
}

/** Only the columns callers read; keeps the two per-request lookups narrow. */
export type SessionProfile = Pick<
  Tables<"profiles">,
  "id" | "email" | "display_name" | "platform_role" | "last_authenticated_at"
>;
export type SessionMembership = Pick<
  Tables<"organization_members">,
  "user_id" | "organization_id" | "role" | "status" | "department" | "early_tools"
>;

/**
 * Wrapped in React cache() so the layout, page and nested components of one
 * request share a single lookup (one getUser + two table reads) instead of
 * repeating it. Outside a React render (Server Actions, Route Handlers) cache()
 * does not dedupe, so those behave exactly as before.
 */
export const getCurrentSession = cache(async function getCurrentSession(): Promise<CurrentSession | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, email, display_name, platform_role, last_authenticated_at")
    .eq("id", user.id)
    .maybeSingle();
  // A failed lookup is an outage, not "signed out": surface it instead of bouncing the user to login.
  if (profileError) throw profileError;
  if (!profile) return null; // profile row not created yet (auth trigger race) - treat as not-ready

  // Force a full interactive re-authentication at least every 30 days,
  // independent of Supabase's own refresh-token lifetime (which otherwise
  // refreshes silently forever) - see docs/architecture.md sec 19 and
  // lib/auth/reauth.ts. This is the single point of enforcement: every
  // Server Component/Server Action/Route Handler that needs the current user
  // flows through getCurrentSession (directly, or via requireSession/
  // requireOrgRole below), so putting the check here, rather than in each of
  // those, is what makes it actually apply everywhere at once.
  if (isReauthRequired(profile.last_authenticated_at, new Date())) {
    await supabase.auth.signOut();
    redirect(`${routes.login}?reason=reauth_required`);
  }

  const { data: membership, error: membershipError } = await supabase
    .from("organization_members")
    .select("user_id, organization_id, role, status, department, early_tools")
    .eq("user_id", user.id)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (membershipError) throw membershipError;

  return { userId: user.id, email: user.email ?? profile.email, profile, membership: membership ?? null };
});

export class AuthError extends Error {
  constructor(
    public code: "UNAUTHENTICATED" | "FORBIDDEN",
    message: string,
  ) {
    super(message);
  }
}

export async function requireSession(): Promise<CurrentSession> {
  const session = await getCurrentSession();
  if (!session) throw new AuthError("UNAUTHENTICATED", "Sign-in required");
  return session;
}

/**
 * Same as requireSession(), but for a Server Component/Server Action that
 * would rather redirect a signed-out visitor straight to login than crash to
 * the nearest error boundary with a raw "Sign-in required" exception - which
 * is exactly what happened to a real user (a session that read as valid to
 * (dashboard)/layout.tsx's own check no longer validated a moment later at
 * the page/action itself - a real, if rare, race between the two, most
 * visible on a flaky mobile connection). Every (dashboard) page/action that
 * only needs "some signed-in user" (not a specific org role - see
 * requireOrgRole/requirePlatformRole, which keep throwing so their own
 * callers can distinguish UNAUTHENTICATED from FORBIDDEN, per
 * requirePlatformRole's own comment on that same pattern) should call this
 * instead of the bare requireSession().
 */
export async function requireSessionOrRedirect(): Promise<CurrentSession> {
  try {
    return await requireSession();
  } catch (err) {
    if (err instanceof AuthError && err.code === "UNAUTHENTICATED") redirect(routes.login);
    throw err;
  }
}

export type SessionWithMembership = CurrentSession & { membership: SessionMembership };

export async function requireOrgRole(roles: OrgRole[]): Promise<SessionWithMembership> {
  const session = await requireSession();
  if (!session.membership || !roles.includes(session.membership.role as OrgRole)) {
    throw new AuthError("FORBIDDEN", `Requires one of roles: ${roles.join(", ")}`);
  }
  return session as SessionWithMembership;
}

export type PlatformRole = "user" | "super_admin";

/**
 * Guards every /platform (platform-level super-admin console) Server
 * Component/Server Action - mirrors requireOrgRole's shape exactly, but
 * checks `profiles.platform_role` instead of an org membership role.
 *
 * `session.profile` above already comes from a live `profiles` row read done
 * by getCurrentSession() for *this* request (see its own comment) - never a
 * client-supplied value and never a JWT claim, which is deliberate: unlike
 * organization_id/role (stamped into custom JWT claims for RLS/Realtime
 * performance, see docs/architecture.md sec 2.3), platform_role has no JWT
 * claim at all, and this function must never be changed to read one - a
 * super_admin promotion/demotion (service-role only, see
 * private.prevent_platform_role_escalation) must take effect on this user's
 * very next request, not whenever their token happens to refresh.
 *
 * Callers (app/platform/layout.tsx and, defense-in-depth, each page under it)
 * catch AuthError and redirect away - same pattern as requireOrgRole's callers
 * in app/admin/layout.tsx - rather than this function redirecting itself, so
 * it stays usable from Server Actions (which can't unconditionally redirect
 * on failure the way a Server Component can).
 */
export async function requirePlatformRole(): Promise<CurrentSession> {
  const session = await requireSession();
  if (session.profile.platform_role !== "super_admin") {
    throw new AuthError("FORBIDDEN", "Requires platform super_admin role");
  }
  return session;
}
