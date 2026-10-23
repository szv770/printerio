/**
 * Client-only holder for the browser's "install this app" offer (the beforeinstallprompt event, Chrome/Edge/Android/
 * Chromebook). The event is captured once, early (components/pwa/PwaBoot.tsx, mounted in the root layout), and any
 * install card on any page can read it and trigger the prompt.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
let started = false;
let dismissedInMemory = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export const INSTALL_DISMISSED_STORAGE_KEY = "printio:pwa-install-dismissed";

export function startCapturingInstallPrompt(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    notify();
  });
}

export function subscribeInstallState(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function isInstallPromptAvailable(): boolean {
  return deferred !== null;
}

/** Shows the browser's install dialog. Resolves true if the person accepted. */
export async function promptInstall(): Promise<boolean> {
  const event = deferred;
  if (!event) return false;
  deferred = null; // an event can be used once
  notify();
  try {
    await event.prompt();
    const { outcome } = await event.userChoice;
    return outcome === "accepted";
  } catch {
    return false;
  }
}

export function isInstallDismissed(): boolean {
  if (dismissedInMemory) return true;
  try {
    return window.localStorage.getItem(INSTALL_DISMISSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissInstallCard(): void {
  dismissedInMemory = true;
  try {
    window.localStorage.setItem(INSTALL_DISMISSED_STORAGE_KEY, "1");
  } catch {
    // Storage blocked: the in-memory flag still hides it until the next load.
  }
  notify();
}
