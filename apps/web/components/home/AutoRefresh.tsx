"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { HOME_REFRESH_MS } from "@/lib/ui/refresh-intervals";

/**
 * Re-runs the server page every `everyMs` while the tab is visible, so a job
 * that comes through shows up without a reload. Paused while hidden, refreshes
 * once when the tab becomes visible again, and cleans up on unmount.
 */
export function AutoRefresh({ everyMs = HOME_REFRESH_MS }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer === null) timer = setInterval(() => router.refresh(), everyMs);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        router.refresh();
        start();
      } else stop();
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [router, everyMs]);
  return null;
}
