/**
 * Remembered open/closed state for Collapsible sections, one JSON object per
 * page in localStorage. Every access is wrapped in try/catch: storage can be
 * missing or throw (private windows, blocked site data, Safari quotas), and a
 * section must then simply behave as "closed unless told otherwise".
 */

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type OpenMap = Record<string, boolean>;

export const OPEN_STATE_PREFIX = "printio:ui:open:";

export function openStateKey(pathname: string): string {
  return `${OPEN_STATE_PREFIX}${pathname}`;
}

export function readOpenState(storage: StorageLike | null | undefined, pathname: string): OpenMap {
  try {
    if (!storage) return {};
    const raw = storage.getItem(openStateKey(pathname));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: OpenMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (v === true) out[k] = true;
    return out;
  } catch {
    return {};
  }
}

/** Stores `open` for one section id. Closed sections are removed rather than
 *  stored as false, so the object stays small. Returns false if storage failed. */
export function writeOpenState(
  storage: StorageLike | null | undefined,
  pathname: string,
  id: string,
  open: boolean,
): boolean {
  try {
    if (!storage) return false;
    const map = readOpenState(storage, pathname);
    if (open) map[id] = true;
    else delete map[id];
    storage.setItem(openStateKey(pathname), JSON.stringify(map));
    return true;
  } catch {
    return false;
  }
}

/** Decide whether a section is open after mount. A hash match or forceOpen
 *  (error / needs attention) always opens it; otherwise the remembered state,
 *  then the default. */
export function resolveOpen(opts: {
  id: string;
  stored: OpenMap;
  defaultOpen: boolean;
  forceOpen: boolean;
  hash: string;
}): boolean {
  if (opts.forceOpen) return true;
  if (opts.hash && opts.hash.replace(/^#/, "") === opts.id) return true;
  if (opts.id in opts.stored) return opts.stored[opts.id] === true;
  return opts.defaultOpen;
}
