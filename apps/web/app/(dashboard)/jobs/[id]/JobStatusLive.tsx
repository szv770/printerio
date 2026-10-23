"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { routes } from "@/lib/routes";
import { jobStatusDisplay } from "@/lib/job-status-labels";
import { JOB_STAGE_LABELS, buildJobProgress, jobProgressPosition } from "@/lib/job-progress";
import { jobHeadline } from "@/lib/job-headline";
import { jobWaiting } from "@/lib/job-waiting";
import { AlertTriangle, ListChecks } from "lucide-react";
import { ButtonLink, Card, Collapsible } from "@/components/ui";
import type { Tables } from "@/lib/database.types";
import { LocalTime } from "../LocalTime";
import { JobProgressBar } from "../JobProgressBar";
import { JobProgressStepper } from "./JobProgressStepper";
import { HeldBookletCard } from "./HeldBookletCard";
import { BOOKLET_BINDING_REASON } from "@/lib/gateway/ipp-choices";

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

/** Dot colors are the printer inks: cyan in motion, yellow waiting on someone, magenta a problem. */
const HEADLINE_DOT = {
  neutral: "bg-[var(--color-faint)]",
  live: "bg-[var(--ink-c)]",
  success: "bg-[var(--color-success)]",
  warning: "bg-[var(--ink-y)]",
  danger: "bg-[var(--ink-m)]",
} as const;

const TONE_PANEL = {
  neutral: "bg-[var(--color-surface-2)] text-[var(--color-text)]",
  success: "bg-[var(--color-success-soft)] text-[var(--color-success-ink)]",
  warning: "bg-[var(--color-warning-soft)] text-[var(--color-warning-ink)]",
  danger: "bg-[var(--color-danger-soft)] text-[var(--color-danger-ink)]",
} as const;

export function JobStatusLive({
  job: serverJob,
  eventTypes,
  rejectionReason,
  actions,
}: {
  job: PrintJob;
  /** print_job_events.event_type for this job, oldest first - what tells the stepper how far a stopped job actually got. */
  eventTypes: string[];
  /** The approver's own words, from the REJECTED event's metadata (mirrors approval_actions.reason). */
  rejectionReason: string | null;
  /** The primary buttons (Cancel / Try again / Print again), rendered by the server page so each keeps its own action wiring. */
  actions?: React.ReactNode;
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
   *
   * `.subscribe()` itself is async - the websocket/join handshake takes a
   * real, variable amount of time, and any change to the row that happens
   * before it completes is missed entirely (no error, no replay). That
   * window is exactly the one that bit a real user: landing on a
   * freshly-created job right after "Print again" redirects here, while its
   * Agent was mid-poll-cycle and claimed + failed the job within the same
   * second or two the page was still connecting - so the failure never
   * arrived live, only on a manual reload. Waiting for the "SUBSCRIBED"
   * callback and firing one router.refresh() at that moment closes the gap.
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
      .subscribe((status) => {
        if (status === "SUBSCRIBED") router.refresh();
      });

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

  const display = jobStatusDisplay(job.status, job.error_message);
  const isBindingQuestion =
    job.status === "held" && !!(job.finishing as { booklet?: boolean } | null)?.booklet && job.held_reason === BOOKLET_BINDING_REASON;
  const progress = useMemo(
    () =>
      buildJobProgress({
        status: job.status,
        policyAction: job.policy_action,
        policyReasons: job.policy_reasons,
        errorMessage: job.error_message,
        heldReason: job.held_reason,
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

  // Guaranteed backstop, independent of Realtime: a real user's job sat on
  // this page for the better part of a minute and completed without ever
  // updating live, on a fresh page load, well past the handshake window the
  // SUBSCRIBED-refresh above closes - meaning something can keep Realtime
  // from delivering an update at all, not just miss the first one. Rather
  // than keep chasing exactly why (WebSocket/proxy/browser-specific - none
  // of it reproducible from here), poll on a plain interval as long as the
  // job could still move, so the page is correct within a few seconds no
  // matter what Realtime does. Cheap (one row, RLS-scoped) and only runs
  // while there's still something to wait for.
  const stillMoving = !progress.halted || progress.retryable;
  useEffect(() => {
    if (!stillMoving) return;
    const interval = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(interval);
  }, [stillMoving, router]);

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

  // A job that is already waiting for the printer has its own plain explanation (the Waiting for the printer panel).
  const stalledInQueue = waitingForAgent && !jobWaiting(job.status, job.error_message) && nowMs !== null && nowMs - Date.parse(job.updated_at) > STALLED_IN_QUEUE_MS;
  const policyReasons = job.policy_reasons ?? [];
  const explanation = progress.explanation;
  const headline = jobHeadline(job.status, job.error_message);
  const stageLabel = JOB_STAGE_LABELS[progress.currentStageId];

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-4 sm:p-6">
        <div>
          <div className="flex items-center gap-3">
            <span className="relative flex h-3.5 w-3.5 shrink-0" aria-hidden="true">
              {headline.tone === "live" && (
                <span className={`absolute inset-0 animate-ping rounded-full opacity-50 motion-reduce:animate-none ${HEADLINE_DOT.live}`} />
              )}
              <span className={`relative h-3.5 w-3.5 rounded-full ${HEADLINE_DOT[headline.tone]}`} />
            </span>
            <h2 className="text-2xl font-semibold leading-8 tracking-[-0.01em] sm:text-[1.75rem] sm:leading-9">{headline.sentence}</h2>
          </div>
          <p className="mt-1.5 pl-[1.625rem] text-[13px] leading-5 text-[var(--color-muted)]">
            {/* A step counter only means something while the job is still moving - on a stopped job it would read
             *  as progress that is not happening. */}
            {!progress.halted && (
              <>
                Step {position.step} of {position.total}: {stageLabel} ·{" "}
              </>
            )}
            Updated <LocalTime iso={job.updated_at} />
          </p>
        </div>

        <JobProgressBar status={job.status} policyAction={job.policy_action} progress={progress} large />

        {/* Says plainly what this row is, so nobody reading the job list or an audit trail later mistakes an
         *  admin's queue check for a person's print job - and so the two deliberately-skipped stages need no
         *  further explanation. */}
        {job.is_test_print && (
          <div className={`rounded-xl p-3.5 text-sm ${TONE_PANEL.neutral}`}>
            <p className="font-medium">Test print</p>
            <p className="mt-1">
              Sent from Admin &rarr; Printers to check this printer from start to finish. Print rules, approval and quota are skipped on purpose, and it is
              not counted in anyone&apos;s usage or in the reports.
            </p>
          </div>
        )}

        {explanation && (
          <div className={`rounded-xl p-3.5 text-sm ${TONE_PANEL[display.tone]}`} role={display.tone === "danger" ? "alert" : undefined}>
            <div className="flex items-start gap-2.5">
              {(display.tone === "danger" || display.tone === "warning") && (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              )}
              <div className="min-w-0">
                <p className="font-semibold">{explanation.title}</p>
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
            </div>
          </div>
        )}

        {/* Held ONLY to ask left or right binding: one tap finishes it. A booklet held for any other reason too
         *  (e.g. an A4 page size) keeps the ordinary "choose again" route, so nothing else is silently dropped. */}
        {isBindingQuestion && <HeldBookletCard jobId={job.id} reason={job.held_reason} />}
        {job.status === "held" && !isBindingQuestion && (
          <ButtonLink href={routes.print} size="lg" className="w-full sm:w-auto">
            Choose your options again
          </ButtonLink>
        )}

        {/* Never silent about an override: this job's own policy_action/reasons say what the rules would otherwise
         *  have done - see lib/policy/admin-bypass.ts and Admin > Settings' "Admins bypass approval & quota" toggle. */}
        {job.policy_bypassed_for_admin && (
          <div className={`rounded-xl p-3.5 text-sm ${TONE_PANEL.warning}`}>
            <p className="font-semibold">Printed as an admin override</p>
            <p className="mt-1">This would normally have {job.policy_action === "deny" ? "been denied" : "required approval"}:</p>
            {policyReasons.length > 0 && (
              <ul className="mt-1 list-inside list-disc">
                {policyReasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            )}
            <p className="mt-1 text-xs opacity-80">
              Allowed anyway because admin jobs skip these rules in this organization (Admin &rarr; Settings).
            </p>
          </div>
        )}

        {actions}
      </Card>

      <Collapsible
        id="job-steps"
        title="Step by step"
        icon={<ListChecks className="h-4 w-4" aria-hidden="true" />}
        summary={progress.halted ? `Stopped at: ${stageLabel}` : `Now: ${stageLabel}`}
      >
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
                agent for this printer may not be running. Ask an administrator to check it.
              </p>
            ) : null,
          }}
        />
      </Collapsible>
    </div>
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
