"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { FileText } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { jobStatusDisplay } from "@/lib/job-status-labels";
import { routes } from "@/lib/routes";
import { EmptyState } from "@/components/ui";
import { ReprintButton } from "./[id]/ReprintButton";

interface JobRow {
  id: string;
  job_number: string;
  original_file_name: string;
  status: string;
  source_pdf_pages: number;
  color_mode: string;
  duplex: boolean;
  copies: number;
  created_at: string;
}

export function JobsList({ initialJobs, userId }: { initialJobs: JobRow[]; userId: string }) {
  const [jobs, setJobs] = useState(initialJobs);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`jobs-own-${userId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "print_jobs", filter: `created_by=eq.${userId}` },
        (payload) => {
          setJobs((prev) => {
            if (payload.eventType === "DELETE") {
              return prev.filter((j) => j.id !== (payload.old as JobRow).id);
            }
            const row = payload.new as JobRow;
            const exists = prev.some((j) => j.id === row.id);
            if (exists) return prev.map((j) => (j.id === row.id ? row : j));
            return [row, ...prev];
          });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId]);

  if (jobs.length === 0) {
    return (
      <EmptyState
        message="No print jobs yet."
        icon={FileText}
        action={
          <Link
            href={routes.print}
            className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] hover:opacity-90"
          >
            + Print your first document
          </Link>
        }
      />
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {jobs.map((job) => {
        const status = jobStatusDisplay(job.status);
        return (
          <li
            key={job.id}
            className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 hover:border-[var(--color-primary)]"
          >
            <Link href={routes.job(job.id)} className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{job.original_file_name}</span>
                <span className="flex shrink-0 items-center gap-1.5 text-sm">
                  <status.Icon className="h-4 w-4" />
                  {status.label}
                </span>
              </div>
              <p className="mt-1 text-xs text-[var(--color-muted)]">
                {job.job_number} • {job.source_pdf_pages} pages • {job.color_mode === "color" ? "Color" : "B&W"} •{" "}
                {job.duplex ? "Duplex" : "Simplex"} • {job.copies} {job.copies === 1 ? "copy" : "copies"}
              </p>
            </Link>
            <ReprintButton jobId={job.id} />
          </li>
        );
      })}
    </ul>
  );
}
