import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { routes } from "@/lib/routes";
import { isReauthRequired } from "@/lib/auth/reauth";
import type { Tables } from "@/lib/database.types";
import type { OrgRole } from "@printio/shared";

export interface CurrentSession {
  userId: string;
  email: string;
  profile: Tables<"profiles">;
  /** The user's first active organization membership (see docs/architecture.md
   *  sec 2.1 - schema supports multi-org membership; this build's UI assumes
   *  one active org per user, which is a UI simplification, not an RLS one). */
  membership: Tables<"organization_members"> | null;
}

export async function getCurrentSession(): Promise<CurrentSession | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).single();
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

  const { data: membership } = await supabase
    .from("organization_members")
    .select("*")
    .eq("user_id", user.id)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();

  return { userId: user.id, email: user.email ?? profile.email, profile, membership: membership ?? null };
}

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

export type SessionWithMembership = CurrentSession & { membership: Tables<"organization_members"> };

export async function requireOrgRole(roles: OrgRole[]): Promise<SessionWithMembership> {
  const session = await requireSession();
  if (!session.membership || !roles.includes(session.membership.role as OrgRole)) {
    throw new AuthError("FORBIDDEN", `Requires one of roles: ${roles.join(", ")}`);
  }
  return session as SessionWithMembership;
}
