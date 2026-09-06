"use client"; // Required: global-error replaces the root layout entirely on a
// render-time failure in the root layout itself, so it must render its own
// <html>/<body> (and re-import globals.css, since layout.tsx is bypassed).

import "./globals.css";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
          <h1 className="text-2xl font-semibold">Printio hit an unexpected error</h1>
          <p className="max-w-sm text-sm text-[var(--color-muted)]">
            {error.digest && <span className="block font-mono text-xs">Reference: {error.digest}</span>}
          </p>
          <button
            onClick={reset}
            className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)]"
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
