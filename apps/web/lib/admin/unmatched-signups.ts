import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * "Sign-ups without access" (security review F4): people who created a sign-in
 * but belong to no organization and are not platform super admins. They see
 * nothing and can print nothing; this lets an org admin see and remove them.
 *
 * Must be called with the SERVICE-ROLE client, only after an org_admin check.
 * Removal is allowed ONLY for accounts that are unmatched in every organization,
 * which is what makes it impossible to touch another org's people.
 */
export interface UnmatchedSignup {
  userId: string;
  email: string;
  signedUpAt: string;
  lastSignInAt: string | null;
}

const PAGE = 200;
const MAX_PAGES = 5;
const MAX_SHOWN = 100;

export async function findUnmatchedSignups(admin: SupabaseClient): Promise<UnmatchedSignup[]> {
  const all: Array<{ id: string; email?: string | null; created_at: string; last_sign_in_at?: string | null }> = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: PAGE });
    if (error) throw error;
    all.push(...data.users);
    if (data.users.length < PAGE) break;
  }
  if (all.length === 0) return [];

  const ids = all.map((u) => u.id);
  const exclude = new Set<string>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const [members, supers] = await Promise.all([
      admin.from("organization_members").select("user_id").in("user_id", chunk),
      admin.from("profiles").select("id").in("id", chunk).eq("platform_role", "super_admin"),
    ]);
    if (members.error) throw members.error;
    if (supers.error) throw supers.error;
    for (const m of members.data ?? []) exclude.add(m.user_id);
    for (const p of supers.data ?? []) exclude.add(p.id);
  }

  return all
    .filter((u) => !exclude.has(u.id))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, MAX_SHOWN)
    .map((u) => ({ userId: u.id, email: u.email ?? "(no email)", signedUpAt: u.created_at, lastSignInAt: u.last_sign_in_at ?? null }));
}

export type RemoveSignupResult = { ok: true } | { ok: false; error: string };

export async function removeUnmatchedSignup(
  admin: SupabaseClient,
  input: { actorId: string; organizationId: string; targetId: string },
): Promise<RemoveSignupResult> {
  if (input.targetId === input.actorId) return { ok: false, error: "You can't remove your own account." };

  // Re-derive from the database, never trust the page: the target must still be unmatched everywhere right now.
  const target = (await findUnmatchedSignups(admin)).find((u) => u.userId === input.targetId);
  if (!target) {
    return { ok: false, error: "That account can't be removed here. It belongs to an organization, or it's already gone." };
  }

  // Audit first: if the delete then fails we have a record of the attempt; the reverse could lose it.
  await admin.from("audit_logs").insert({
    organization_id: input.organizationId,
    actor_id: input.actorId,
    action: "signup.removed",
    target_type: "auth_user",
    target_id: input.targetId,
    metadata: { email: target.email },
  });

  const { error } = await admin.auth.admin.deleteUser(input.targetId);
  if (error) return { ok: false, error: "Couldn't remove that account. Try again." };
  return { ok: true };
}
