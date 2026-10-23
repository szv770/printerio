"use client";

import { useEffect } from "react";
import { startCapturingInstallPrompt } from "@/lib/pwa/install-prompt";

/**
 * Mounted once in the root layout. Does two quiet things:
 *  - starts listening for the browser's install offer, so the install card works on any page;
 *  - in production, registers the service worker (/sw.js), whose only jobs are taking a shared PDF (the manifest's
 *    share_target) and nothing else: no caching.
 * Kill switch: if /sw.js ever answers 404, an already-registered worker is removed on the next visit.
 */
export function PwaBoot() {
  useEffect(() => {
    startCapturingInstallPrompt();
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    const sw = navigator.serviceWorker;
    void (async () => {
      try {
        const existing = await sw.getRegistration("/");
        if (existing) {
          const res = await fetch("/sw.js", { method: "HEAD", cache: "no-store" });
          if (res.status === 404) {
            await existing.unregister();
            return;
          }
        }
        await sw.register("/sw.js", { scope: "/", updateViaCache: "none" });
      } catch {
        // A failed registration only means "no share target yet"; the app works without it.
      }
    })();
  }, []);
  return null;
}
