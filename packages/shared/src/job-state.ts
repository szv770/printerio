/**
 * Print job state machine.
 *
 * Design goals (see docs/architecture.md "Job State Machine" section):
 *  - Every transition is explicit and recorded as a print_job_events row.
 *  - "submitted_to_spooler" and "completed" are NOT the same thing as
 *    "the printer physically produced pages". We can only reliably observe
 *    the spooler; see docs/architecture.md and docs/known-limitations.md.
 *  - Failure is a first-class state with retry bookkeeping, not an exception.
 *  - A job can only be claimed by one agent at a time (lease), and leases
 *    expire so a crashed/disconnected agent can't permanently strand a job.
 */

export const JOB_STATES = [
  "draft",
  "held",
  "pending_approval",
  "approved",
  "denied",
  "rejected",
  "expired",
  "cancelled",
  "claimed",
  "downloading",
  "downloaded",
  "printing",
  "submitted_to_spooler",
  "completed",
  "failed",
] as const;

export type JobState = (typeof JOB_STATES)[number];

/**
 * Terminal states: no further transitions are possible. Note `failed` is
 * deliberately NOT terminal - it has outgoing edges (retry back to `claimed`,
 * or `cancelled` once retries are exhausted), since it structurally supports
 * ALLOWED_TRANSITIONS below rather than being a dead end. A job service layer
 * that has exhausted attempt_count treats `failed` as its practical stopping
 * point, but the state machine itself still allows a transition out of it.
 */
export const TERMINAL_STATES: ReadonlySet<JobState> = new Set([
  "denied",
  "rejected",
  "expired",
  "cancelled",
  "completed",
]);

/** True if `state` has no possible outgoing transition at all (a stricter check than isTerminalState). */
export function isDeadEnd(state: JobState): boolean {
  return ALLOWED_TRANSITIONS[state].length === 0;
}

export function isTerminalState(state: JobState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Allowed forward transitions. This is intentionally a strict allowlist -
 * any transition not listed here must be rejected by the job service layer,
 * never silently allowed (e.g. "approved -> completed" skipping every
 * intermediate step is explicitly forbidden by the spec).
 *
 * Retry note: on failure, the job service may transition failed -> approved
 * (re-queued, lease cleared, quota reservation kept) if attempt_count <
 * max_attempts - by the owner's "Try again" or automatically when the
 * organization enables it; failed -> claimed (a fresh lease) is also legal.
 * Those retry edges are included below rather than treated as special cases.
 */
export const ALLOWED_TRANSITIONS: Record<JobState, readonly JobState[]> = {
  draft: ["held", "pending_approval", "approved", "denied", "cancelled"],
  // held: print options could not be confidently resolved; the sender or an admin must choose.
  // Entered only from draft. Expires (7 days, admin-configurable) and is then cancelled/expired.
  held: ["pending_approval", "approved", "denied", "cancelled", "expired"],
  pending_approval: ["approved", "rejected", "expired", "cancelled"],
  approved: ["claimed", "expired", "cancelled"],
  denied: [],
  rejected: [],
  expired: [],
  cancelled: [],
  claimed: ["downloading", "approved", "cancelled", "failed"], // claimed -> approved: lease expiry, released back to pool
  downloading: ["downloaded", "failed", "cancelled"],
  downloaded: ["printing", "failed", "cancelled"],
  printing: ["submitted_to_spooler", "failed"],
  submitted_to_spooler: ["completed", "failed"],
  completed: [],
  failed: ["claimed", "approved", "cancelled"], // retry: re-queued to the claim pool (approved) or re-leased; exhausted retries stay failed
};

export function canTransition(from: JobState, to: JobState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export interface JobEventInput {
  jobId: string;
  eventType: JobEventType;
  actorType: "user" | "system" | "agent" | "admin";
  actorId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Canonical event_type values for the print_job_events audit trail
 * (spec section 41). Keep this list in sync with any CHECK constraint
 * in supabase/migrations.
 */
export const JOB_EVENT_TYPES = [
  "JOB_CREATED",
  "PDF_UPLOADED",
  "PREFLIGHT_COMPLETED",
  "PREFLIGHT_REJECTED",
  "POLICY_EVALUATED",
  "APPROVAL_REQUIRED",
  "APPROVED",
  "REJECTED",
  "DENIED",
  "JOB_EXPIRED",
  "JOB_CANCELLED",
  "AGENT_CLAIMED",
  "LEASE_EXPIRED",
  "DOWNLOAD_STARTED",
  "DOWNLOAD_COMPLETED",
  "PRINT_SUBMITTED",
  "SPOOLER_ACCEPTED",
  "PRINT_FAILED",
  "JOB_COMPLETED",
  "RETRY_SCHEDULED",
] as const;

export type JobEventType = (typeof JOB_EVENT_TYPES)[number];
