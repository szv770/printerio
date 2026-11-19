"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { Button, Card } from "@/components/ui";
import { ReportProblemLink } from "@/components/help/ReportProblemLink";

/** Error boundary for the platform console: only the content column shows the message, the nav stays usable. */
export default function PlatformError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("Platform page error:", error);
  }, [error]);

  return (
    <Card className="flex flex-col items-center gap-3 py-10 text-center">
      <AlertTriangle className="h-8 w-8 text-[var(--color-warning)]" aria-hidden />
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="max-w-sm text-sm text-[var(--color-muted)]">
        This page could not be shown. It has been logged.
        {error.digest && <span className="mt-1 block font-mono text-xs">Reference: {error.digest}</span>}
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button type="button" variant="primary" onClick={reset}>
          Try again
        </Button>
        <ReportProblemLink digest={error.digest} variant="ghost" />
      </div>
    </Card>
  );
}
