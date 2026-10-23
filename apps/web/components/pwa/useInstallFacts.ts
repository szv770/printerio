"use client";

import { useSyncExternalStore } from "react";
import { installCardMode, isIosDevice, type InstallMode } from "@/lib/pwa/install";
import { isInstallDismissed, isInstallPromptAvailable, subscribeInstallState } from "@/lib/pwa/install-prompt";

function isStandalone(): boolean {
  try {
    return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

function subscribe(cb: () => void): () => void {
  const off = subscribeInstallState(cb);
  let mq: MediaQueryList | null = null;
  try {
    mq = window.matchMedia("(display-mode: standalone)");
    mq.addEventListener("change", cb);
  } catch {
    // no matchMedia
  }
  return () => {
    off();
    mq?.removeEventListener("change", cb);
  };
}

/** A primitive snapshot (standalone, dismissed, ios, prompt) so useSyncExternalStore sees a stable value. */
function snapshot(): string {
  const ios = isIosDevice({ userAgent: navigator.userAgent, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints });
  return [isStandalone(), isInstallDismissed(), ios, isInstallPromptAvailable()].map((b) => (b ? "1" : "0")).join("");
}

/** Server and first paint: pretend it is installed, so nothing is drawn until the browser has been asked. */
const SERVER_SNAPSHOT = "1000";

export function useInstallMode(opts: { ignoreDismissed?: boolean } = {}): InstallMode {
  const s = useSyncExternalStore(subscribe, snapshot, () => SERVER_SNAPSHOT);
  return installCardMode(
    { standalone: s[0] === "1", dismissed: s[1] === "1", ios: s[2] === "1", promptAvailable: s[3] === "1" },
    opts,
  );
}
