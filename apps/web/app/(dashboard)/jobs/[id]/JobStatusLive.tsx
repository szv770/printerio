"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { jobStatusDisplay } from "@/lib/job-status-labels";
import { Card } from "@/components/ui";

export function JobStatusLive({
  jobId,
  initialStatus,
  initialErrorMessage,
}: {
  jobId: string;
  initialStatus: string;
  initialErrorMessage: string | null;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [errorMessage, setErrorMessage] = useState(initialErrorMessage);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`job-${jobId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "print_jobs", filter: `id=eq.${jobId}` },
        (payload) => {
          const row = payload.new as { status: string; error_message: string | null };
          setStatus(row.status);
          setErrorMessage(row.error_message);
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [jobId]);

  const display = jobStatusDisplay(status);
  const { Icon } = display;
  const TONE_COLOR: Record<typeof display.tone, string> = {
    neutral: "text-[var(--color-muted)]",
    success: "text-[var(--color-success)]",
    warning: "text-[var(--color-warning)]",
    danger: "text-[var(--color-danger)]",
  };

  return (
    <Card>
      <p className="flex items-center gap-2 text-lg font-medium">
        <Icon className={`h-5 w-5 ${TONE_COLOR[display.tone]} ${display.spinning ? "animate-spin" : ""}`} />
        {display.label}
      </p>
      {errorMessage && <p className="mt-1 text-sm text-[var(--color-danger)]">{errorMessage}</p>}
      {status === "submitted_to_spooler" && (
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          Sent to the printer. &quot;Completed&quot; means the print spooler finished cleanly - see known limitations for
          what that does and doesn&apos;t guarantee about physical output.
        </p>
      )}
    </Card>
  );
}
