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

  return (
    <Card>
      <p className="text-lg font-medium">
        {display.emoji} {display.label}
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
