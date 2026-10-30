"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Tables } from "@/lib/database.types";
import { debounce } from "@/lib/ui/debounce";
import { affectsApprovalQueue } from "@/lib/ui/realtime-refresh";
import { ApprovalList } from "./ApprovalList";

type PrintJob = Tables<"print_jobs">;

export function ApprovalQueue({
  initialJobs,
  organizationId,
  submitterNames,
  printerLabels,
}: {
  initialJobs: PrintJob[];
  organizationId: string;
  /** profiles.id -> display name (or email) of whoever submitted the job. */
  submitterNames: Record<string, string>;
  /** printer_profiles.id -> its admin-facing label. */
  printerLabels: Record<string, string>;
}) {
  const router = useRouter();
  const shownIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    shownIds.current = new Set(initialJobs.map((j) => j.id));
  }, [initialJobs]);

  /**
   * Live queue, per docs/architecture.md sec 15: any change to a print_jobs
   * row in this organization re-renders the page from the server, so a job
   * appears the moment it needs approval and disappears the moment any admin
   * acts on it (or it expires/is cancelled).
   *
   * Deliberately a router.refresh() rather than patching a local copy of the
   * list from the payload: the card shows facts that do NOT live on the
   * print_jobs row - who submitted it, which printer profile it targets - and
   * those are resolved server-side. Rendering the payload directly would show
   * "Unknown" for exactly the jobs that just arrived, which is when an
   * approver is most likely to be looking.
   *
   * `.subscribe()` is async - the websocket/join handshake takes a real,
   * variable amount of time, and a change landing before it completes is
   * missed entirely (no error, no replay) - the same gap that hid a job's
   * failure on the jobs pages (see JobsList.tsx/JobStatusLive.tsx). Firing
   * one router.refresh() the moment the subscription actually confirms
   * "SUBSCRIBED" re-syncs with whatever the server already has right as
   * we'd otherwise start missing live updates.
   */
  useEffect(() => {
    const supabase = createClient();
    // Only events that add/remove a queue entry matter, and bursts collapse into one refresh.
    const refreshSoon = debounce(() => router.refresh(), 2_000);
    const channel = supabase
      .channel(`approvals-${organizationId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "print_jobs", filter: `organization_id=eq.${organizationId}` },
        (payload) => {
          if (affectsApprovalQueue(payload, shownIds.current)) refreshSoon();
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") router.refresh();
      });

    return () => {
      refreshSoon.cancel();
      supabase.removeChannel(channel);
    };
  }, [organizationId, router]);

  return <ApprovalList jobs={initialJobs} submitterNames={submitterNames} printerLabels={printerLabels} />;
}
