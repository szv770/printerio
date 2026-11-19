import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { PREPARE_KIND } from "./prepare-jobs";

/**
 * Is a prepare job of this school waiting for its print server? The same filter the claim route uses (queued, or claimed with an expired lease), one indexed
 * read (server_jobs_prepare_claim_idx). It rides on the print server's existing poll (`?prepare=1` on the claimable-jobs call) so the prepare worker needs no
 * polling of its own. `null` = could not tell (the field is then left out and the print server falls back to its own timer): this never fails a poll.
 */
export async function prepareJobWaiting(db: SupabaseClient<Database>, organizationId: string): Promise<boolean | null> {
  try {
    const nowIso = new Date().toISOString();
    const { data, error } = await db
      .from("server_jobs")
      .select("id")
      .eq("kind", PREPARE_KIND)
      .eq("organization_id", organizationId)
      .or(`status.eq.queued,and(status.eq.claimed,lease_until.lt.${nowIso})`)
      .limit(1);
    if (error) return null;
    return (data?.length ?? 0) > 0;
  } catch {
    return null;
  }
}
