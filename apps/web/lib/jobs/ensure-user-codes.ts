import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { generateUserCode } from "@/lib/jobs/user-code";

const MAX_ATTEMPTS = 8;
const READ_CHUNK = 1000;
/** Most people given a code in one call (an admin presses the button again for more). */
export const CODE_BATCH_SIZE = 200;

export interface CodeMember {
  userId: string;
  displayName: string | null;
  email: string | null;
}

/** Every print code already used in the organization, read in chunks (a plain select stops at 1,000 rows). */
async function readUsedCodes(db: SupabaseClient<Database>, organizationId: string): Promise<Set<string>> {
  const used = new Set<string>();
  for (let from = 0; ; from += READ_CHUNK) {
    const { data, error } = await db
      .from("organization_members")
      .select("user_code")
      .eq("organization_id", organizationId)
      .not("user_code", "is", null)
      .order("user_id")
      .range(from, from + READ_CHUNK - 1);
    if (error) throw new Error(`Couldn't read the organization's user codes: ${error.message}`);
    for (const r of data ?? []) if (r.user_code) used.add(r.user_code.toUpperCase());
    if (!data || data.length < READ_CHUNK) break;
  }
  return used;
}

/**
 * Gives print codes to a batch of members who have none, reading the codes already in use ONCE. Same safety as
 * ensureMemberUserCode (lib/jobs/ensure-user-code.ts): each code is written with `user_code IS NULL` as a guard, so it
 * never overwrites a code that someone set meanwhile, and the per-organization unique index decides races (a
 * unique violation just moves on to the next candidate). Two admins pressing the button at the same time cannot give
 * anyone two codes or two people the same code.
 *
 * `db` MUST be the service-role client and the caller MUST already have checked that the viewer is an admin of
 * `organizationId`. Only the given members are touched, and only in that organization. A failure for one person is
 * counted, not thrown, so one bad row does not stop the batch.
 */
export async function ensureMemberUserCodes(
  db: SupabaseClient<Database>,
  input: { organizationId: string; members: CodeMember[] },
): Promise<{ assigned: number; failed: number }> {
  const members = input.members.slice(0, CODE_BATCH_SIZE);
  if (members.length === 0) return { assigned: 0, failed: 0 };
  const used = await readUsedCodes(db, input.organizationId);
  let assigned = 0;
  let failed = 0;
  for (const m of members) {
    let done = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !done; attempt++) {
      let code: string;
      try {
        code = generateUserCode({ displayName: m.displayName, email: m.email }, used);
      } catch {
        break;
      }
      const { data, error } = await db
        .from("organization_members")
        .update({ user_code: code })
        .eq("organization_id", input.organizationId)
        .eq("user_id", m.userId)
        .is("user_code", null)
        .select("user_code");
      if (error) {
        if ((error as { code?: string }).code === "23505") {
          used.add(code);
          continue;
        }
        break;
      }
      // Rows come back only when this call wrote the code. None means someone else just gave this person one: fine.
      if (data && data.length > 0) {
        used.add(code);
        assigned++;
      }
      done = true;
    }
    if (!done) failed++;
  }
  return { assigned, failed };
}

/** The members of one organization who still have no print code, oldest first, at most one batch. */
export async function findMembersWithoutCode(db: SupabaseClient<Database>, organizationId: string): Promise<CodeMember[]> {
  const { data, error } = await db
    .from("organization_members")
    .select("user_id, profiles(email, display_name)")
    .eq("organization_id", organizationId)
    .is("user_code", null)
    .order("created_at")
    .order("user_id")
    .limit(CODE_BATCH_SIZE);
  if (error) throw new Error(`Couldn't read members without a code: ${error.message}`);
  return (data ?? []).map((r) => ({ userId: r.user_id, displayName: r.profiles?.display_name ?? null, email: r.profiles?.email ?? null }));
}
