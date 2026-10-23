/**
 * "One section open at a time" for Collapsible, as pure, testable rules.
 *
 * Sections on the same page form one group: opening one closes the others, so a page never ends up with a pile of
 * open cards. A section nested inside another section is its own group (opening it must never close its parent).
 * Nothing is remembered between visits: a page starts closed unless a section is told to open (defaultOpen, a
 * #hash that names it, or forceOpen because something needs attention). Remembered state used to be kept in
 * localStorage, which is why sections piled up open over time.
 */

export const COLLAPSIBLE_OPEN_EVENT = "printio:collapsible-open";

export interface CollapsibleOpenDetail {
  group: string;
  id: string;
}

/** Top-level sections of a page share one group; sections inside another section get a group per parent. */
export function groupKey(pathname: string, parentId: string | null): string {
  return `${pathname}::${parentId ?? ""}`;
}

export function resolveInitialOpen(opts: { id: string; defaultOpen: boolean; forceOpen: boolean; hash: string }): boolean {
  if (opts.forceOpen) return true;
  if (opts.hash && opts.hash.replace(/^#/, "") === opts.id) return true;
  return opts.defaultOpen;
}

/** Should this section close because another section in its group just opened? */
export function shouldCloseOnOtherOpen(opts: {
  selfId: string;
  openedId: string;
  selfGroup: string;
  openedGroup: string;
  forceOpen: boolean;
  independent: boolean;
}): boolean {
  if (opts.independent) return false;
  if (opts.forceOpen) return false;
  if (opts.selfGroup !== opts.openedGroup) return false;
  return opts.selfId !== opts.openedId;
}
