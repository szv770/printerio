/** Realtime payload slice we need (matches Supabase postgres_changes shape). */
interface PayloadLike {
  eventType?: string;
  new?: { id?: string; status?: string } | null;
  old?: { id?: string; status?: string } | null;
}

/**
 * The approvals queue only changes when a job enters or leaves pending_approval. print_jobs uses the default replica
 * identity, so `old` carries only the primary key, not the previous status. "Entered" is therefore a new status of
 * pending_approval; "left" is a change to a job id the queue is currently showing.
 */
export function affectsApprovalQueue(payload: PayloadLike, shownIds: ReadonlySet<string>): boolean {
  const next = payload.new?.status;
  const prev = payload.old?.status;
  if (next === "pending_approval" || prev === "pending_approval") return true;
  const id = payload.new?.id ?? payload.old?.id;
  return id !== undefined && shownIds.has(id);
}
