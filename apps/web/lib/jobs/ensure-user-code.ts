import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { generateUserCode, normalizeUserCode } from "@/lib/jobs/user-code";

const MAX_ATTEMPTS = 8;

/**
 * Gives a member their PERSISTENT user code (organization_members.user_code) the first time one is needed and
 * returns it. Idempotent: a member who already has a code keeps it.
 *
 * `db` MUST be the service-role client and the caller MUST already have authorized the request (the member's
 * own job, or an org admin/approver viewing the roster); this function does no authorization of its own.
 *
 * Uniqueness: the first free candidate (see generateUserCode) is written with `user_code IS NULL` as a guard, so it
 * can never overwrite a code an admin set meanwhile; the per-organization unique index is the final guard - on a
 * unique violation (23505, someone took it between our read and write) the next candidate is tried, up to
 * MAX_ATTEMPTS times. It throws rather than ever returning a code that is not saved.
 *
 * `stored` is optional: pass what the caller has already read (null = known empty) to skip a query.
 */
export async function ensureMemberUserCode(
  db: SupabaseClient<Database>,
  m: { organizationId: string; userId: string; displayName: string | null; email: string | null; stored?: string | null },
): Promise<string> {
  const readOwn = async (): Promise<string | null> => {
    const { data, error } = await db
      .from("organization_members")
      .select("user_code")
      .eq("organization_id", m.organizationId)
      .eq("user_id", m.userId)
      .maybeSingle();
    if (error) throw new Error(`Couldn't read the member's user code: ${error.message}`);
    return normalizeUserCode(data?.user_code ?? null);
  };

  const existing = m.stored !== undefined ? normalizeUserCode(m.stored) : await readOwn();
  if (existing) return existing;

  const { data: rows, error: usedError } = await db
    .from("organization_members")
    .select("user_code")
    .eq("organization_id", m.organizationId)
    .not("user_code", "is", null);
  if (usedError) throw new Error(`Couldn't read the organization's user codes: ${usedError.message}`);
  const used = new Set<string>();
  for (const r of rows ?? []) if (r.user_code) used.add(r.user_code.toUpperCase());

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = generateUserCode(m, used);
    const { data, error } = await db
      .from("organization_members")
      .update({ user_code: code })
      .eq("organization_id", m.organizationId)
      .eq("user_id", m.userId)
      .is("user_code", null)
      .select("user_code");
    if (error) {
      if ((error as { code?: string }).code === "23505") {
        used.add(code);
        continue;
      }
      throw new Error(`Couldn't save the member's user code: ${error.message}`);
    }
    if (data && data.length > 0) return code;
    // Nothing updated: a code was set by someone else (or the member no longer exists). Use whatever is stored now.
    const now = await readOwn();
    if (now) return now;
    throw new Error("Couldn't save the member's user code: member not found");
  }
  throw new Error("Couldn't find a free user code after several attempts");
}
