"use client"; // Error boundaries must be Client Components (Next.js requirement).

import { useEffect } from "react";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Server-side console only (this runs in the browser, but Next.js
    // mirrors it to the terminal in dev) - never render `error.message`
    // directly to end users below, since it may contain internal details.
    console.error("Unhandled page error:", error);
  }, [error]);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="max-w-sm text-sm text-[var(--color-muted)]">
        This has been logged. Try again, or come back in a moment.
        {error.digest && <span className="mt-1 block font-mono text-xs">Reference: {error.digest}</span>}
      </p>
      <button
        onClick={reset}
        className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)]"
      >
        Try again
      </button>
    </main>
  );
}
