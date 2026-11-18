"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { startVisibleInterval } from "@/lib/ui/visible-interval";
import { COMMAND_REFRESH_MS, MAX_AUTO_REFRESHES } from "@/lib/ui/command-refresh";

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
