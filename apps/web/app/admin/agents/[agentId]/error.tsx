"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { Button, Card } from "@/components/ui";
import { routes } from "@/lib/routes";

/**
 * Error boundary for one print server page. Without it a failure while loading this page (a database hiccup, an
 * unexpected row) bubbled to the whole-app boundary. Now only this page shows the message and the rest of the
 * admin area keeps working.
 */
export default function AgentDetailError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("Print server page error:", error);
  }, [error]);

  return (
    <div className="mx-auto max-w-3xl">
      <Card className="flex flex-col items-center gap-3 py-10 text-center">
        <AlertTriangle className="h-8 w-8 text-[var(--color-warning)]" aria-hidden />
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="max-w-sm text-sm text-[var(--color-muted)]">
          This page could not be shown. It has been logged. Your print server and print jobs are not affected.
          {error.digest && <span className="mt-1 block font-mono text-xs">Reference: {error.digest}</span>}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button type="button" variant="primary" onClick={reset}>
            Try again
          </Button>
          <Link
            href={routes.adminAgents}
            className="inline-flex min-h-11 items-center rounded-[var(--radius-control)] px-4 text-sm font-medium text-[var(--color-primary)] underline"
          >
            Back to print servers
          </Link>
        </div>
      </Card>
    </div>
  );
}
