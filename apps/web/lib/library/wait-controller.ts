import { createWaitPoller, type WaitPoller } from "./wait-poller";

/**
 * The library screens' bookkeeping around wait-poller.ts (docs/PHASE-C-PLAN.md, C1d): at most one poller per item (a key such
 * as "main" for a volume or year, or "entry:/maamorim/1" for one opened entry), a new wait for the same item replaces the old
 * one, and ONE tab-visibility listener serves all of them (added with the first poller, removed with the last). No React here,
 * so the rules are tested with fake timers (wait-controller.test.ts); the screen only calls `track` / `stop` / `stopAll`.
 */

export interface TrackOptions {
  /** Ask again. `isCurrent()` turns false once this wait was stopped or replaced: then do NOT show the answer. Resolve `true` while still waiting. */
  retry: (isCurrent: () => boolean) => Promise<boolean>;
  onProgress?: (elapsedMs: number) => void;
  onGiveUp: () => void;
  onSettled?: () => void;
}

export interface WaitControllerDeps {
  isVisible?: () => boolean;
  /** Subscribe to "the tab was hidden or shown"; returns the unsubscribe. Defaults to the document's `visibilitychange`. */
  onVisibilityChange?: (listener: () => void) => () => void;
  now?: () => number;
}

export interface WaitController {
  /** Start waiting for `key` (any wait already running for that key is stopped first). */
  track(key: string, options: TrackOptions): void;
  stop(key: string): void;
  /** Stop every wait whose key does not satisfy `keep` (all of them when `keep` is left out). */
  stopAll(keep?: (key: string) => boolean): void;
  active(key: string): boolean;
  readonly size: number;
}

const defaultOnVisibilityChange = (listener: () => void): (() => void) => {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
};

export function createWaitController(deps: WaitControllerDeps = {}): WaitController {
  const subscribe = deps.onVisibilityChange ?? defaultOnVisibilityChange;
  const running = new Map<string, { poller: WaitPoller; live: boolean }>();
  let unsubscribe: (() => void) | null = null;

  const syncListener = () => {
    if (running.size > 0 && !unsubscribe) unsubscribe = subscribe(() => running.forEach((r) => r.poller.visibilityChanged()));
    else if (running.size === 0 && unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  function end(key: string): void {
    const r = running.get(key);
    if (!r) return;
    r.live = false;
    r.poller.stop();
    running.delete(key);
  }

  return {
    track(key, options) {
      end(key);
      const entry = { poller: null as unknown as WaitPoller, live: true };
      const finishIfCurrent = (after?: () => void) => () => {
        if (!entry.live) return;
        entry.live = false;
        if (running.get(key) === entry) running.delete(key);
        syncListener();
        after?.();
      };
      entry.poller = createWaitPoller({
        retry: () => options.retry(() => entry.live),
        onProgress: (ms) => {
          if (entry.live) options.onProgress?.(ms);
        },
        onGiveUp: finishIfCurrent(options.onGiveUp),
        onSettled: finishIfCurrent(options.onSettled),
        ...(deps.isVisible ? { isVisible: deps.isVisible } : {}),
        ...(deps.now ? { now: deps.now } : {}),
      });
      running.set(key, entry);
      syncListener();
      entry.poller.start();
    },
    stop(key) {
      end(key);
      syncListener();
    },
    stopAll(keep) {
      for (const key of [...running.keys()]) if (!keep || !keep(key)) end(key);
      syncListener();
    },
    active: (key) => running.has(key),
    get size() {
      return running.size;
    },
  };
}
