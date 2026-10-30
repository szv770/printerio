"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { startVisibleInterval } from "@/lib/ui/visible-interval";

/** How often the Print server page re-reads its data while an ordinary request is in flight. */
export const COMMAND_REFRESH_MS = 10_000;
/** Faster cadence while an update is live (progress is what the admin is watching). */
export const UPDATE_REFRESH_MS = 5_000;
/** Hard cap on refreshes per activation so a stuck request can never poll forever (about 10-20 minutes). */
export const MAX_AUTO_REFRESHES = 120;

export function refreshIntervalMs(updateLive: boolean): number {
  return updateLive ? UPDATE_REFRESH_MS : COMMAND_REFRESH_MS;
}

/**
 * Re-runs the server page periodically while `active` (a request is pending/running or was just sent), so the
 * "Recent requests" list updates without a reload. Stops by itself once the server says nothing is live (`active`
 * turns false) or after MAX_AUTO_REFRESHES. Paused while the tab is hidden, refreshes once when it is shown
 * again, and cleans up on unmount.
 */
export function CommandAutoRefresh({ active, everyMs = COMMAND_REFRESH_MS }: { active: boolean; everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    let count = 0;
    let stop: () => void = () => {};
    stop = startVisibleInterval(
      () => {
        if (++count > MAX_AUTO_REFRESHES) {
          stop();
          return;
        }
        router.refresh();
      },
      everyMs,
      document,
    );
    return () => stop();
  }, [active, everyMs, router]);
  return null;
}
