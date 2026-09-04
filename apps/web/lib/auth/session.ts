import { createClient } from "@/lib/supabase/server";
import type { Tables } from "@/lib/database.types";
import type { OrgRole } from "@printos/shared";

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
