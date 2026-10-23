"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { startVisibleInterval } from "@/lib/ui/visible-interval";

/** How often the Print server page re-reads its data while a request is in flight. */
export const COMMAND_REFRESH_MS = 4_000;

/**
 * Re-runs the server page every ~4 seconds while `active` (a request is pending/running or was just sent), so the
 * "Recent requests" list updates without a reload. Paused while the tab is hidden, refreshes once when it is shown
 * again, and cleans up on unmount or when `active` turns off.
 */
export function CommandAutoRefresh({ active, everyMs = COMMAND_REFRESH_MS }: { active: boolean; everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    return startVisibleInterval(() => router.refresh(), everyMs, document);
  }, [active, everyMs, router]);
  return null;
}
