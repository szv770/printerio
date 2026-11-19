export type HelpTab = "page" | "walkthrough" | "glossary" | "report";

export const OPEN_HELP_EVENT = "printio:open-help";

/** Opens the Help window from anywhere (the "?" button, a setup step). HelpMenu is the one listener. */
export function openHelp(tab: HelpTab = "page") {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<HelpTab>(OPEN_HELP_EVENT, { detail: tab }));
}
