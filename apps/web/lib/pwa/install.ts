/** Rules for the "Install Printio" card. Pure, so they are unit-tested; the component only gathers the facts. */

export interface InstallFacts {
  /** Already running as an installed app (display-mode: standalone / navigator.standalone). */
  standalone: boolean;
  /** The person pressed "Not now" on the card before. */
  dismissed: boolean;
  ios: boolean;
  /** The browser fired beforeinstallprompt and we are holding the event. */
  promptAvailable: boolean;
}

export type InstallMode = "hidden" | "prompt" | "ios";

/** `ignoreDismissed` is for menu rows (Me sheet, admin sidebar): they have no "Not now", so an earlier dismissal of the home card must not hide them. */
export function installCardMode(facts: InstallFacts, opts: { ignoreDismissed?: boolean } = {}): InstallMode {
  if (facts.standalone) return "hidden";
  if (facts.dismissed && !opts.ignoreDismissed) return "hidden";
  if (facts.promptAvailable) return "prompt";
  if (facts.ios) return "ios";
  return "hidden";
}

export function isIosDevice(nav: { userAgent: string; platform: string; maxTouchPoints: number }): boolean {
  if (/iPhone|iPad|iPod/.test(nav.userAgent)) return true;
  // iPadOS 13+ says it is a Mac; a real Mac has no touch screen.
  return nav.platform === "MacIntel" && nav.maxTouchPoints > 1;
}

