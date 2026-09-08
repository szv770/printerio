"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { jobStatusDisplay } from "@/lib/job-status-labels";
import { buildJobProgress, jobProgressPosition } from "@/lib/job-progress";
import { Card } from "@/components/ui";
import type { Tables } from "@/lib/database.types";
import { LocalTime } from "../LocalTime";
import { JobProgressStepper } from "./JobProgressStepper";

type PrintJob = Tables<"print_jobs">;

/**
 * A job in `approved` is waiting for an agent to poll and claim it. The agent
 * polls every PRINTIO_POLL_INTERVAL_SECONDS (default 15s) and backs off to at
 * most PRINTIO_MAX_POLL_INTERVAL_SECONDS (default 300s) when it has been idle
 * - so anything past ~5 minutes is no longer "normal polling latency" and is
 * worth telling the user about honestly, rather than leaving them watching a
 * spinner. We deliberately do NOT claim the agent is offline: `agents` is
 * only readable by org_admins under RLS (0006_rls_policies.sql), so a
 * non-admin's browser genuinely cannot know that.
 */
const STALLED_IN_QUEUE_MS = 5 * 60 * 1000;

const TONE_TEXT = {
  neutral: "text-[var(--color-muted)]",
  success: "text-[var(--color-success)]",
  warning: "text-[var(--color-warning)]",
  danger: "text-[var(--color-danger)]",
} as const;

const TONE_PANEL = {
  neutral: "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)]",
  success: "border-[var(--color-success)] bg-[var(--color-bg)] text-[var(--color-text)]",
  warning: "border-[var(--color-warning)] bg-[var(--color-bg)] text-[var(--color-text)]",
  danger: "border-[var(--color-danger)] bg-[var(--color-bg)] text-[var(--color-danger)]",
} as const;

export function JobStatusLive({
  job: serverJob,
  eventTypes,
  rejectionReason,
}: {
  job: PrintJob;
  /** print_job_events.event_type for this job, oldest first - what tells the stepper how far a stopped job actually got. */
  eventTypes: string[];
  /** The approver's own words, from the REJECTED event's metadata (mirrors approval_actions.reason). */
  rejectionReason: string | null;
}) {
  const router = useRouter();
  const [liveJob, setLiveJob] = useState<PrintJob | null>(null);
  /** Set only after mount, so no clock-dependent text differs between the server render and hydration. */
  const [nowMs, setNowMs] = useState<number | null>(null);

  /**
   * Live updates use Supabase Realtime `postgres_changes` on print_jobs -
   * the exact mechanism the realtime approval queue already uses
   * (app/admin/approvals/ApprovalQueue.tsx, docs/architecture.md sec 3.4/15,
   * table added to the publication in 0011_realtime_publication.sql).
   * Visibility is still governed by this table's own RLS policy, so a user
   * only ever receives changes to rows they could already read.
   *
   * The payload row is applied immediately (instant status change), and
   * router.refresh() re-runs the server component so everything *derived*
   * from the job - its event history, the approver's reason - arrives too.
   * print_job_events is not in the realtime publication, and adding it would
   * mean an unapplied migration silently degrading this page (migrations are
   * applied by hand here, see docs/deployment.md), so refreshing off the
   * job-row change is both simpler and more robust: every event this page
   * cares about is written in the same operation as a status change.
   */
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`job-${serverJob.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "print_jobs", filter: `id=eq.${serverJob.id}` },
        (payload) => {
          setLiveJob(payload.new as PrintJob);
          router.refresh();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [serverJob.id, router]);

  // A realtime payload is only preferred while it is genuinely newer than
  // what the server render carried - once router.refresh() lands, the server
  // row wins again, so a slow refresh can never roll the page back to an
  // older status.
  const job = useMemo(() => {
    if (!liveJob) return serverJob;
    return Date.parse(liveJob.updated_at) > Date.parse(serverJob.updated_at) ? liveJob : serverJob;
  }, [liveJob, serverJob]);

  const display = jobStatusDisplay(job.status);
  const progress = useMemo(
    () =>
      buildJobProgress({
        status: job.status,
        policyAction: job.policy_action,
        policyReasons: job.policy_reasons,
        errorMessage: job.error_message,
        rejectionReason,
        attemptCount: job.attempt_count,
        maxAttempts: job.max_attempts,
        eventTypes,
        sourcePdfPages: job.source_pdf_pages,
        isTestPrint: job.is_test_print,
      }),
    [job, eventTypes, rejectionReason],
  );
  const position = jobProgressPosition(progress);

  // Only ticks while the job is sitting in the claim queue - the one place
  // where "how long has this been like this" changes the message. Everything
  // else on this page is event-driven.
  const waitingForAgent = job.status === "approved";
  useEffect(() => {
    if (!waitingForAgent) return;
    // The first read is deferred to a timer rather than done in the effect
    // body on purpose: reading the clock during render/commit would make the
    // server HTML and the hydrated HTML disagree, and setting state
    // synchronously inside an effect is a cascading render.
    const first = setTimeout(() => setNowMs(Date.now()), 0);
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [waitingForAgent, job.updated_at]);

  const stalledInQueue = waitingForAgent && nowMs !== null && nowMs - Date.parse(job.updated_at) > STALLED_IN_QUEUE_MS;
  const policyReasons = job.policy_reasons ?? [];
  const explanation = progress.explanation;
  const { Icon } = display;

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-lg font-medium">
          <Icon className={`h-5 w-5 ${TONE_TEXT[display.tone]} ${display.spinning ? "animate-spin" : ""}`} />
          {display.label}
        </p>
        <p className="text-xs text-[var(--color-muted)]">
          {/* A step counter only means something while the job is still
           *  moving - on a stopped job it would read as progress that isn't
           *  happening. */}
          {!progress.halted && (
            <>
              Step {position.step} of {position.total} •{" "}
            </>
          )}
          updated <LocalTime iso={job.updated_at} />
        </p>
      </div>

      {/* Says plainly what this row is, so nobody reading the job list or an
       *  audit trail later mistakes an admin's queue check for a person's
       *  print job - and so the two deliberately-skipped stages below need no
       *  further explanation. */}
      {job.is_test_print && (
        <div className={`mt-3 rounded-lg border p-3 text-sm ${TONE_PANEL.neutral}`}>
          <p className="font-medium">Test print</p>
          <p className="mt-1">
            Sent from Admin → Printers to check this queue end to end. It goes through the same upload, the same print
            agent and the same Windows queue as a real job, but print rules, approval and quota are skipped on purpose -
            it isn&apos;t counted in anyone&apos;s usage or in the reports.
          </p>
        </div>
      )}

      {explanation && (
        <div className={`mt-3 rounded-lg border p-3 text-sm ${TONE_PANEL[display.tone]}`}>
          <p className="font-medium">{explanation.title}</p>
          {explanation.lines.length === 1 ? (
            <p className="mt-1">{explanation.lines[0]}</p>
          ) : (
            <ul className="mt-1 list-inside list-disc">
              {explanation.lines.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Never silent about an override: this job's own policy_action/reasons
       *  say what the rules would otherwise have done - see
       *  lib/policy/admin-bypass.ts and Admin → Settings' "Admins bypass
       *  approval & quota" toggle, which is what let this through. */}
      {job.policy_bypassed_for_admin && (
        <div className={`mt-3 rounded-lg border p-3 text-sm ${TONE_PANEL.warning}`}>
          <p className="font-medium">Printed as an admin override</p>
          <p className="mt-1">
            This would normally have {job.policy_action === "deny" ? "been denied" : "required approval"}:
          </p>
          {policyReasons.length > 0 && (
            <ul className="mt-1 list-inside list-disc">
              {policyReasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Allowed anyway because admin jobs bypass these rules in this organization (Admin → Settings).
          </p>
        </div>
      )}

      <div className="mt-4 border-t border-[var(--color-border)] pt-4">
        <JobProgressStepper
          progress={progress}
          spinning={display.spinning === true}
          extra={{
            policy:
              job.policy_action === "allow" && policyReasons.length > 0 ? (
                <ReasonList title="Allowed by:" reasons={policyReasons} />
              ) : null,
            approval:
              job.policy_action === "require_approval" && policyReasons.length > 0 ? (
                <>
                  <ReasonList title="Why this needs approval:" reasons={policyReasons} />
                  {job.status === "pending_approval" && job.expires_at && (
                    <p className="mt-1 text-xs text-[var(--color-muted)]">
                      Expires if nobody reviews it by <LocalTime iso={job.expires_at} />.
                    </p>
                  )}
                </>
              ) : null,
            queued: stalledInQueue ? (
              <p className="mt-1 text-xs text-[var(--color-warning)]">
                Still waiting after several minutes. Print agents normally collect a job within a minute or two, so the
                agent for this printer may not be running - ask an administrator to check it.
              </p>
            ) : null,
          }}
        />
      </div>
    </Card>
  );
}

function ReasonList({ title, reasons }: { title: string; reasons: string[] }) {
  return (
    <div className="mt-1 text-xs text-[var(--color-muted)]">
      <p>{title}</p>
      <ul className="list-inside list-disc">
        {reasons.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>
    </div>
  );
}
