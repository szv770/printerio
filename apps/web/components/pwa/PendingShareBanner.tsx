"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { createIndexedDbStore, peekLatestEntry } from "@/lib/pwa/inbox";
import { routes } from "@/lib/routes";

/**
 * A shared PDF that never reached the Print page (most often: the person had to sign in first, and signing in lands on
 * the home screen, not on /print). It is still waiting in the share inbox, so say so and offer one tap to carry on.
 * `where="login"` is the signed-out version: it only says the file is safe. Nothing here reads or sends the file.
 */
export function PendingShareBanner({ where }: { where: "login" | "home" }) {
  const [pending, setPending] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    let live = true;
    void peekLatestEntry(createIndexedDbStore(), Date.now()).then((p) => live && setPending(p));
    return () => {
      live = false;
    };
  }, []);

  if (!pending) return null;
  return (
    <div role="status" className="mb-4 flex items-start gap-3 rounded-[var(--radius-card)] border border-[var(--color-primary)]/25 bg-[var(--color-primary-soft)] p-3.5">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface)] text-[var(--color-primary)]">
        <FileText className="h-[18px] w-[18px]" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="break-words text-[15px] font-semibold leading-5 text-[var(--color-text)]">{pending.name}</p>
        {where === "login" ? (
          <p className="mt-0.5 text-sm leading-5 text-[var(--color-text-2)]">Your shared PDF is waiting. Sign in and Printio will have it ready.</p>
        ) : (
          <>
            <p className="mt-0.5 text-sm leading-5 text-[var(--color-text-2)]">You shared this PDF. It is waiting to be printed.</p>
            <Link
              href={`${routes.print}?shared=${encodeURIComponent(pending.id)}`}
              className="mt-2 inline-flex min-h-11 items-center rounded-[var(--radius-control)] bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] focus-visible:outline-none focus-visible:shadow-[var(--ring)]"
            >
              Continue to print
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
