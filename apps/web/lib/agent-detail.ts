/**
 * The derivations behind app/admin/agents/[agentId] - kept out of the page
 * component so each one is unit-testable on plain objects rather than only
 * reachable through a Server Component and a live database (the same split
 * lib/reports.ts and lib/admin-setup-checklist.ts already use).
 *
 * Nothing here does I/O or reads a session: the page fetches org-scoped rows
 * (RLS-enforced, organization_id always from the session and never from the
 * URL) and hands them in.
 */

import { compareAgentVersions, LATEST_AGENT_VERSION } from "@printio/shared";

/** How long without a heartbeat before an Agent reads as offline - the same 5-minute rule AgentsPanel, PrintersPanel and admin/page.tsx already use. */
export const AGENT_ONLINE_WINDOW_MS = 5 * 60_000;

export interface QueueUsageInput {
  profileId: string;
  /** print_jobs rows for this profile: only the two fields the summary needs. */
  jobs: Array<{ created_at: string; status: string }>;
}

export interface QueueUsage {
  /** Total print jobs ever routed to this queue - the honest denominator, not a rolling window. */
  totalJobs: number;
  /** Jobs that actually reached the printer (submitted_to_spooler or completed) - see docs/known-limitations.md for why those two are not collapsed. */
  printedJobs: number;
  /** Most recent submission to this queue, or null if it has never been used. */
  lastUsedAt: string | null;
}

const PRINTED_STATUSES = new Set(["submitted_to_spooler", "completed"]);

/**
 * A rough, deliberately cheap usage signal per queue: how many jobs have ever
 * been sent to it, how many of those actually made it to the spooler, and
 * when it was last used. No windowing, no rates, no charts - the question an
 * admin actually has in front of this page is "is this queue in use at all,
 * and when did it last do anything," and a count plus a max(created_at)
 * answers it without inventing an analytics feature.
 */
export function summarizeQueueUsage(jobs: ReadonlyArray<{ created_at: string; status: string }>): QueueUsage {
  let printedJobs = 0;
  let lastUsedAt: string | null = null;
  for (const job of jobs) {
    if (PRINTED_STATUSES.has(job.status)) printedJobs += 1;
    if (!lastUsedAt || job.created_at > lastUsedAt) lastUsedAt = job.created_at;
  }
  return { totalJobs: jobs.length, printedJobs, lastUsedAt };
}

/** Groups a flat list of print_jobs rows into per-profile usage summaries, including profiles with no jobs at all. */
export function summarizeUsageByProfile(
  profileIds: readonly string[],
  jobs: ReadonlyArray<{ printer_profile_id: string | null; created_at: string; status: string }>,
): Record<string, QueueUsage> {
  const byProfile = new Map<string, Array<{ created_at: string; status: string }>>();
  for (const id of profileIds) byProfile.set(id, []);
  for (const job of jobs) {
    if (!job.printer_profile_id) continue;
    const bucket = byProfile.get(job.printer_profile_id);
    if (bucket) bucket.push({ created_at: job.created_at, status: job.status });
  }
  const out: Record<string, QueueUsage> = {};
  for (const [id, bucket] of byProfile) out[id] = summarizeQueueUsage(bucket);
  return out;
}

/**
 * The three timestamps this page distinguishes, and why they are not the same
 * thing (the question "is 'last synced' just last_seen_at?" has a real answer
 * here rather than a made-up second metric):
 *
 * - `lastSyncedAt` = `agents.last_seen_at`. Updated by every heartbeat, on a
 *   ~15s cadence, whether or not the machine has done any work. It answers
 *   "is this machine reachable and running the Agent right now?" and nothing
 *   else - a perfectly idle Agent keeps this fresh forever.
 * - `lastJobActivityAt` = the newest `print_jobs.updated_at` among jobs this
 *   Agent has actually held a lease on. It answers "when did this machine
 *   last do the thing it exists to do?" A machine that has been happily
 *   heartbeating for a week with this stuck a week back is exactly the
 *   situation the Agents list could not previously show.
 * - `lastCommandAt` = the newest `remote_commands.completed_at` for this
 *   Agent. It answers "when did this machine last actually carry out
 *   something an admin asked it to?" - which is what makes a "Restart queue"
 *   or "Check for update" button verifiable rather than fire-and-forget.
 *
 * All three are derived from rows that already exist; no new column, no new
 * write path, and nothing is invented when a signal genuinely isn't there
 * (each is independently nullable and rendered as "never").
 */
export interface AgentActivity {
  lastSyncedAt: string | null;
  lastJobActivityAt: string | null;
  lastCommandAt: string | null;
}

export function deriveAgentActivity(
  lastSeenAt: string | null,
  leasedJobs: ReadonlyArray<{ updated_at: string }>,
  commands: ReadonlyArray<{ completed_at: string | null }>,
): AgentActivity {
  let lastJobActivityAt: string | null = null;
  for (const job of leasedJobs) {
    if (!lastJobActivityAt || job.updated_at > lastJobActivityAt) lastJobActivityAt = job.updated_at;
  }
  let lastCommandAt: string | null = null;
  for (const command of commands) {
    if (!command.completed_at) continue;
    if (!lastCommandAt || command.completed_at > lastCommandAt) lastCommandAt = command.completed_at;
  }
  return { lastSyncedAt: lastSeenAt, lastJobActivityAt, lastCommandAt };
}

export interface AgentVersionStatus {
  reported: string | null;
  latest: string;
  state: "unknown" | "up_to_date" | "outdated" | "ahead";
  /** Plain-English, admin-facing - this page's audience is a school IT admin, not a release engineer. */
  summary: string;
}

/**
 * "This Agent is on 0.1.0, latest is 0.2.0" instead of a bare version string
 * with nothing to compare it against. `latest` is what this repository
 * currently ships (@printio/shared's LATEST_AGENT_VERSION), which is exactly
 * the right compare-target: the Agent updates by pulling this same
 * repository, so "the version in the repo the cloud was deployed from" IS
 * the version a successful update would land on.
 */
export function describeAgentVersion(reported: string | null, latest: string = LATEST_AGENT_VERSION): AgentVersionStatus {
  const state = compareAgentVersions(reported, latest);
  const summary =
    state === "unknown"
      ? "This Agent hasn't reported a version yet - it hasn't completed a heartbeat since it was registered."
      : state === "outdated"
        ? `This Agent is running ${reported}, but ${latest} is available.`
        : state === "ahead"
          ? `This Agent reports ${reported}, which is newer than the ${latest} this console expects - the cloud may be running an older deployment.`
          : `This Agent is up to date (${latest}).`;
  return { reported, latest, state, summary };
}

/** Whether an Agent counts as online right now, by the same staleness rule used everywhere else in /admin. */
export function isAgentOnline(lastSeenAt: string | null, now: number): boolean {
  if (!lastSeenAt) return false;
  return now - new Date(lastSeenAt).getTime() < AGENT_ONLINE_WINDOW_MS;
}

/**
 * The single, honest connection line for an Agent, resolving the three states
 * that used to be flattened into "online"/"offline". Paused deliberately
 * outranks online: an admin looking at a queue that is intentionally held
 * needs to see THAT, not a green "online" badge that makes a deliberately
 * idle machine look like a broken one (or vice versa).
 */
export function describeAgentConnection(
  agent: { status: string; paused: boolean; last_seen_at: string | null },
  now: number,
): { label: string; tone: "success" | "warning" | "danger" | "neutral"; detail: string } {
  if (agent.status === "disabled") {
    return {
      label: "Disabled",
      tone: "danger",
      detail: "This Agent's credential has been revoked - it can no longer connect at all until it is re-registered.",
    };
  }
  if (agent.status === "pending") {
    return {
      label: "Awaiting setup",
      tone: "warning",
      detail: "This Agent has been registered here but has never connected - run its enrollment code on the Windows machine.",
    };
  }
  if (agent.paused) {
    return {
      label: "Paused",
      tone: "warning",
      detail: isAgentOnline(agent.last_seen_at, now)
        ? "Connected and healthy, but deliberately held: it will not take new print jobs until it is resumed."
        : "Deliberately held (it will not take new print jobs) - and it also hasn't checked in recently.",
    };
  }
  if (isAgentOnline(agent.last_seen_at, now)) {
    return { label: "Online", tone: "success", detail: "Checked in within the last 5 minutes and is taking print jobs." };
  }
  return {
    label: "Offline",
    tone: "neutral",
    detail: agent.last_seen_at
      ? "Hasn't checked in for more than 5 minutes - the machine may be off, asleep, or without internet access."
      : "Has never checked in since it was registered.",
  };
}
