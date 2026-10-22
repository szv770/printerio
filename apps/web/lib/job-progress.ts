import { JOB_STATES, type JobState } from "@printio/shared";
import type { JobEventType } from "./job-event-labels";
import { friendlyFailureMessage } from "./job-failure";

/**
 * "Where is my job up to right now?", answered as an ordered set of stages
 * rather than a single status word or a flat event log.
 *
 * Everything here is derived from things the system genuinely records:
 * packages/shared/src/job-state.ts's JOB_STATES/ALLOWED_TRANSITIONS (the
 * canonical state machine, mirrored by the print_jobs.status CHECK
 * constraint and by private.print_job_transition_allowed in
 * 0006_rls_policies.sql) and print_job_events.event_type. There is
 * deliberately NO percentage: nothing in this system knows how many pages
 * the printer has physically produced (docs/known-limitations.md), so a
 * percent-complete number would be invented. Discrete stages are the honest
 * unit of progress here.
 *
 * job-progress.test.ts asserts this file stays consistent with the real
 * state machine - every JobState maps to a stage, every event type is
 * classified, and no allowed forward transition ever moves a job backwards
 * through the stages except the two rewind edges the machine documents
 * (claimed -> approved on lease expiry, failed -> claimed on retry).
 */

export const JOB_STAGES = ["submitted", "policy", "approval", "queued", "sent", "printing", "done"] as const;

export type JobStageId = (typeof JOB_STAGES)[number];

export const JOB_STAGE_LABELS: Record<JobStageId, string> = {
  submitted: "Submitted",
  policy: "Checked against print rules",
  approval: "Approval",
  queued: "Waiting for a printer",
  sent: "Sent to the printer",
  printing: "Printing",
  done: "Done",
};

export type JobStageState =
  /** Already happened. */
  | "done"
  /** Where the job is right now. */
  | "current"
  /** Still ahead of the job. */
  | "upcoming"
  /** This is where the job stopped, and why. */
  | "failed"
  /** Genuinely did not apply to this job (e.g. approval on an auto-approved job). */
  | "skipped"
  /** The job stopped for good before reaching this - it will never happen. */
  | "unreachable";

export interface JobProgressStage {
  id: JobStageId;
  label: string;
  state: JobStageState;
  /** One plain sentence about what this stage means for THIS job, or null when the stage needs no explanation. */
  note: string | null;
}

export interface JobProgressExplanation {
  title: string;
  /** Specific, recorded detail - policy reason labels, the approver's reason, the agent's error message. Never a generic "failed". */
  lines: string[];
}

export interface JobProgress {
  stages: JobProgressStage[];
  currentStageId: JobStageId;
  /** True once the job has stopped and will not move again on its own. */
  halted: boolean;
  /** A failed job that still has attempts left - it can be picked up and retried. */
  retryable: boolean;
  /** Why the job is where it is, when that needs saying (denied/rejected/failed/expired/cancelled). */
  explanation: JobProgressExplanation | null;
}

export interface JobProgressInput {
  status: string;
  policyAction?: string | null;
  policyReasons?: readonly string[] | null;
  /** print_jobs.error_message - whatever the agent actually reported (spooler error, offline queue, download failure). */
  errorMessage?: string | null;
  /** approval_actions.reason / the REJECTED event's metadata.reason, when an approver gave one. */
  rejectionReason?: string | null;
  /** print_jobs.held_reason - why a held job is waiting for the sender's choices. */
  heldReason?: string | null;
  attemptCount?: number | null;
  maxAttempts?: number | null;
  /** print_job_events.event_type values for this job, oldest first. Optional: the jobs list renders without them. */
  eventTypes?: readonly string[];
  sourcePdfPages?: number | null;
  /** print_jobs.is_test_print - an admin-issued test print, which never went
   *  through the policy engine, the approval queue, or quota at all (see
   *  app/admin/printers/actions.ts). Everything after that is the identical
   *  pipeline, so only the two skipped stages change here. */
  isTestPrint?: boolean;
}

/** The stage a job sitting in each state is AT. */
const STATUS_STAGE: Record<JobState, JobStageId> = {
  draft: "submitted",
  held: "submitted",
  pending_approval: "approval",
  approved: "queued",
  denied: "policy",
  rejected: "approval",
  // expired/cancelled/failed can be reached from several places, so the stage
  // below is only a floor - `stageIndexFor` takes the furthest stage the
  // recorded events prove the job actually got to.
  expired: "approval",
  cancelled: "submitted",
  claimed: "sent",
  downloading: "sent",
  downloaded: "sent",
  printing: "printing",
  submitted_to_spooler: "printing",
  completed: "done",
  failed: "sent",
};

/**
 * The stage a job has REACHED when each event is recorded. `null` means the
 * event annotates the job without advancing it (a failure, a cancellation, a
 * scheduled retry) - those are shown in the history, not as forward progress.
 */
const EVENT_STAGE: Record<JobEventType, JobStageId | null> = {
  JOB_CREATED: "submitted",
  PDF_UPLOADED: "submitted",
  PREFLIGHT_COMPLETED: "submitted",
  PREFLIGHT_REJECTED: "submitted",
  POLICY_EVALUATED: "policy",
  DENIED: "policy",
  APPROVAL_REQUIRED: "approval",
  REJECTED: "approval",
  // Approval is finished the moment it is granted; the job is now queued
  // waiting for an agent to claim it.
  APPROVED: "queued",
  LEASE_EXPIRED: "queued",
  AGENT_CLAIMED: "sent",
  DOWNLOAD_STARTED: "sent",
  DOWNLOAD_COMPLETED: "sent",
  PRINT_SUBMITTED: "printing",
  SPOOLER_ACCEPTED: "printing",
  JOB_COMPLETED: "done",
  JOB_EXPIRED: null,
  JOB_CANCELLED: null,
  PRINT_FAILED: null,
  RETRY_SCHEDULED: null,
};

/** States from which nothing further happens without a new job being created. */
const HALTED_STATES: ReadonlySet<string> = new Set(["denied", "rejected", "expired", "cancelled", "failed"]);

function stageIndex(id: JobStageId): number {
  return JOB_STAGES.indexOf(id);
}

function isJobState(status: string): status is JobState {
  return (JOB_STATES as readonly string[]).includes(status);
}

function stageIndexFor(input: JobProgressInput): number {
  const status = input.status;
  const base = isJobState(status) ? STATUS_STAGE[status] : "submitted";
  if (!HALTED_STATES.has(status)) return stageIndex(base);

  // A stopped job stopped SOMEWHERE, and only its history knows where: a
  // `failed` job may have died downloading or at the spooler; an `expired`
  // one may have expired waiting for approval or waiting for a printer.
  // Take the furthest stage its own recorded events prove it reached.
  let furthest = stageIndex(base);
  for (const eventType of input.eventTypes ?? []) {
    const stage = (EVENT_STAGE as Record<string, JobStageId | null>)[eventType];
    if (stage) furthest = Math.max(furthest, stageIndex(stage));
  }
  return furthest;
}

/** Did this job ever need a human approval decision? */
function approvalApplies(input: JobProgressInput): boolean {
  if (input.policyAction === "require_approval") return true;
  if (input.status === "pending_approval" || input.status === "rejected") return true;
  return (input.eventTypes ?? []).some((e) => e === "APPROVAL_REQUIRED" || e === "REJECTED");
}

function noteForStage(stage: JobStageId, state: JobStageState, input: JobProgressInput): string | null {
  const status = input.status;
  const pages = input.sourcePdfPages ?? null;

  switch (stage) {
    case "submitted":
      if (state === "done" || state === "current") {
        return pages ? `Your ${pages}-page document was uploaded and checked.` : "Your document was uploaded and checked.";
      }
      return null;
    case "policy":
      if (state === "skipped") return "Not needed - a test print isn't checked against print rules or quota.";
      if (state === "failed") return "Your organization's print rules do not allow this job.";
      if (state === "done" || state === "current") return "Checked against your organization's print rules and quota.";
      return null;
    case "approval":
      if (state === "skipped") return "Not needed - this job was approved automatically.";
      if (state === "current") return "An approver has to review this job before it can print.";
      if (state === "failed") {
        if (status === "rejected") return "An approver reviewed this job and rejected it.";
        if (status === "expired") return "Nobody reviewed this job before the approval window closed.";
        return "This job stopped while it was waiting for approval.";
      }
      if (state === "done") return "An approver released this job for printing.";
      return null;
    case "queued":
      if (state === "current") return "Approved, and waiting for a print agent to collect it.";
      if (state === "failed") {
        if (status === "expired") return "No print agent picked this job up before it expired.";
        return "This job stopped while it was waiting for a printer.";
      }
      if (state === "done") return "A print agent picked this job up.";
      return null;
    case "sent":
      if (state === "current") {
        if (status === "claimed") return "A print agent has taken this job and is fetching your document.";
        if (status === "downloading") return "The print agent is downloading your document.";
        return "The print agent has your document and is starting the print.";
      }
      if (state === "failed") return "The print agent could not get this job ready to print.";
      if (state === "done") return "Your document reached the print agent.";
      return null;
    case "printing":
      if (state === "current") {
        if (status === "printing") return "Sending your document to the printer.";
        return "The printer has accepted your document and is working through it.";
      }
      if (state === "failed") return "The printer rejected this job or could not be reached.";
      if (state === "done") return "Sent to the printer.";
      return null;
    case "done":
      if (state === "done") {
        return "The printer accepted the whole job. Printio can't see the paper come out, so collect your pages to be sure.";
      }
      return null;
  }
}

function buildExplanation(input: JobProgressInput, retryable: boolean): JobProgressExplanation | null {
  const reasons = (input.policyReasons ?? []).filter((r) => r.trim().length > 0);
  const attempt =
    typeof input.attemptCount === "number" && typeof input.maxAttempts === "number" && input.maxAttempts > 0
      ? `Tried ${Math.min(input.attemptCount, input.maxAttempts)} of ${input.maxAttempts} times.`
      : null;

  switch (input.status) {
    case "held":
      return {
        title: "Waiting for you to choose options",
        lines: [
          input.heldReason?.trim() || "Printio could not tell exactly how you want this printed, so it has not printed anything.",
          "Nothing has been printed. Choose your options again to print it.",
        ],
      };
    case "denied":
      return {
        title: "Denied by your organization's print rules",
        lines:
          reasons.length > 0
            ? reasons
            : ["No rule detail was recorded for this job. Ask an administrator which rule applied."],
      };
    case "rejected":
      return {
        title: "Rejected by an approver",
        lines: [input.rejectionReason?.trim() || "The approver did not give a reason. Ask them, or submit the job again."],
      };
    case "expired":
      return {
        title: "Expired before it could print",
        lines: [
          "Nobody acted on this job inside the window your organization allows, so it was closed automatically and your quota was released. Submitting it again is safe.",
        ],
      };
    case "cancelled":
      return { title: "Cancelled", lines: ["This job was cancelled and never printed. Your quota was released."] };
    case "failed": {
      // What failed, in plain words - never the agent's raw text (stack traces, spooler codes, database errors).
      const lines = [friendlyFailureMessage(input.errorMessage)];
      if (attempt) lines.push(attempt);
      lines.push(
        retryable
          ? "Press “Try again” to send it to the printer again, or cancel it."
          : "Every allowed try has been used, so this job will not be retried. Use “Print again” to send a fresh copy.",
      );
      return { title: "This job did not print", lines };
    }
    default:
      return null;
  }
}

/**
 * Builds the whole stage model for one job. Pure - no clock, no I/O - so it
 * renders identically on the server and in the browser, and the jobs list
 * can call it with nothing but a status.
 */
export function buildJobProgress(input: JobProgressInput): JobProgress {
  const currentIndex = stageIndexFor(input);
  const halted = HALTED_STATES.has(input.status);
  const completed = input.status === "completed";
  const retryable =
    input.status === "failed" &&
    typeof input.attemptCount === "number" &&
    typeof input.maxAttempts === "number" &&
    input.attemptCount < input.maxAttempts;
  const needsApproval = approvalApplies(input);

  const stages: JobProgressStage[] = JOB_STAGES.map((id, index) => {
    let state: JobStageState;
    // An admin test print genuinely never ran the policy engine (its
    // policy_action is null, not "allow"), so claiming it was "checked
    // against your print rules" would be a small lie on the one screen whose
    // whole job is to say honestly where a job is. Marked skipped for the
    // same reason approval is on an auto-approved job.
    if (id === "policy" && input.isTestPrint) {
      state = "skipped";
    } else if (id === "approval" && !needsApproval) {
      // Auto-approved and auto-denied jobs never had an approval step. Saying
      // so explicitly answers the question a waiting user actually has
      // ("is a teacher sitting on this?") instead of hiding the step.
      state = index <= currentIndex ? "skipped" : halted && !retryable ? "unreachable" : "skipped";
    } else if (index < currentIndex) {
      state = "done";
    } else if (index === currentIndex) {
      state = halted ? "failed" : completed ? "done" : "current";
    } else {
      state = halted && !retryable ? "unreachable" : "upcoming";
    }
    return { id, label: JOB_STAGE_LABELS[id], state, note: noteForStage(id, state, input) };
  });

  return {
    stages,
    currentStageId: JOB_STAGES[currentIndex] ?? "submitted",
    halted,
    retryable,
    explanation: buildExplanation(input, retryable),
  };
}

/**
 * Which pile a job belongs in on the jobs list.
 *
 * "attention" is deliberately only the states where something actually went
 * wrong: a job waiting on an approver is progressing normally, not stuck, so
 * it counts as active. `cancelled` is "other" - the user already knows, and
 * it isn't a problem to chase.
 */
export type JobListBucket = "active" | "attention" | "done" | "other";

export function jobListBucket(status: string): JobListBucket {
  if (status === "completed") return "done";
  if (status === "held" || status === "denied" || status === "rejected" || status === "failed" || status === "expired") return "attention";
  if (status === "cancelled") return "other";
  return "active";
}

/**
 * The one-line "why" a list row went wrong, from detail the system really
 * recorded for that job. Returns null for a job that is fine.
 *
 * A rejected job's reason lives on approval_actions/the REJECTED event rather
 * than on print_jobs, and the list does not load those, so that row points at
 * the detail page instead of inventing a reason here.
 */
export function jobAttentionLine(input: {
  status: string;
  errorMessage?: string | null;
  policyReasons?: readonly string[] | null;
  heldReason?: string | null;
}): string | null {
  switch (input.status) {
    case "held":
      return input.heldReason?.trim() || "Waiting for you to choose your print options.";
    case "failed":
      return friendlyFailureMessage(input.errorMessage);
    case "denied":
      return input.policyReasons?.[0] ?? "Blocked by your organization's print rules.";
    case "rejected":
      return "An approver rejected this job - open it to see their reason.";
    case "expired":
      return "Nobody acted on this in time, so it was closed and your quota released.";
    default:
      return null;
  }
}

/** Compact "step 4 of 7" summary for list views. Skipped stages still count - they are part of the same pipeline. */
export function jobProgressPosition(progress: JobProgress): { step: number; total: number } {
  return { step: stageIndex(progress.currentStageId) + 1, total: JOB_STAGES.length };
}

/** Exported for the tests that pin these maps to the real state machine and event-type list. */
export const JOB_PROGRESS_EVENT_STAGES = EVENT_STAGE;
export const JOB_PROGRESS_STATUS_STAGES = STATUS_STAGE;
