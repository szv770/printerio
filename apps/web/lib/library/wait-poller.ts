/**
 * The waiting state of the library screens (docs/PHASE-C-PLAN.md, C1d). When the website has asked the print server for a page
 * and the page is not there yet, the screen asks again BY ITSELF: first after 5 seconds, then 10, then 15 and every 15 after that,
 * for at most about 90 seconds. Pure scheduling, no React and no network: the screen hands in what "ask again" means.
 *
 * The rules, all covered by wait-poller.test.ts:
 *  - one timer per poller (a one-second beat that also drives the "about N seconds" text) and never two; a retry that has not
 *    answered yet is never joined by another;
 *  - it only runs while the tab is visible: `visibilityChanged()` stops it at once when the tab is hidden and goes on when it is shown again;
 *  - `stop()` ends it for good (the person left the page, or opened something else), and an answer that arrives afterwards is ignored;
 *  - past the cap it stops asking and tells the screen once (`onGiveUp`), which then shows the plain "taking longer" text.
 * No Realtime in this step; that stays a later option.
 */

/** The wait before the first, second, third retry; every later one waits the last value. */
export const WAIT_DELAYS_MS = [5_000, 10_000, 15_000] as const;
/** The poller gives up this long after it started. */
export const WAIT_CAP_MS = 90_000;
/** How often the poller's one timer fires (it drives the seconds shown on screen; a retry is only made when one is due). */
const BEAT_MS = 1_000;

/** How long to wait before retry number `attempt` (0 = the first): 5 s, 10 s, 15 s, then 15 s again. */
export function waitDelayMs(attempt: number): number {
  return WAIT_DELAYS_MS[Math.min(Math.max(0, Math.floor(attempt)), WAIT_DELAYS_MS.length - 1)]!;
}

/** The sentence shown while waiting. The seconds are rounded to 5 and left out for the first moments. */
export function waitingText(elapsedMs: number): string {
  const base = "Waiting for your print server to fetch this page";
  const seconds = Math.round(elapsedMs / 5_000) * 5;
  return seconds >= 5 ? `${base} (about ${seconds} seconds)` : `${base}...`;
}

/** Shown once the cap has passed (the Try again button goes with it). */
export const WAIT_GAVE_UP_TEXT = "This is taking longer than usual. Try again in a minute.";

export interface WaitPollerOptions {
  /** Ask again. Resolves `true` while the page is still not there (keep waiting), `false` when the question is settled (page, error, or anything else). */
  retry: () => Promise<boolean>;
  /** Called each second with the time waited so far (for the text). Never after `stop()`. */
  onProgress?: (elapsedMs: number) => void;
  /** Called once when the cap is reached with the page still not there. Never after `stop()`. */
  onGiveUp: () => void;
  /** Called once when a retry settled the question (it resolved `false`) or threw; the poller is finished by then. */
  onSettled?: () => void;
  /** True while the tab is visible. Defaults to `document.visibilityState === "visible"` (true when there is no document). */
  isVisible?: () => boolean;
  now?: () => number;
}

export interface WaitPoller {
  /** Starts the clock (once). When the tab is hidden it waits for `visibilityChanged()`. */
  start(): void;
  /** Ends it for good: clears the timer; a retry still in flight is ignored when it answers. Safe to call any number of times. */
  stop(): void;
  /** Tell the poller the tab was hidden or shown (it asks `isVisible`). */
  visibilityChanged(): void;
}

const defaultVisible = (): boolean => (typeof document === "undefined" ? true : document.visibilityState === "visible");

export function createWaitPoller(opts: WaitPollerOptions): WaitPoller {
  const now = opts.now ?? Date.now;
  const isVisible = opts.isVisible ?? defaultVisible;
  let started = false;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let startedAt = 0;
  let attempt = 0;
  let nextDueAt = 0;
  let inFlight = false;

  const finish = () => {
    finished = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  function schedule(): void {
    if (finished || timer !== undefined) return; // never a second timer
    timer = setTimeout(beat, BEAT_MS);
  }

  function giveUp(): void {
    finish();
    opts.onGiveUp();
  }

  function beat(): void {
    timer = undefined;
    if (finished) return;
    if (!isVisible()) return; // hidden: stay stopped until visibilityChanged() says otherwise
    const t = now();
    opts.onProgress?.(t - startedAt);
    if (!inFlight) {
      if (t - startedAt >= WAIT_CAP_MS) return giveUp();
      if (t >= nextDueAt) {
        inFlight = true;
        let asked: Promise<boolean>;
        try {
          asked = Promise.resolve(opts.retry());
        } catch {
          asked = Promise.reject(new Error("retry failed"));
        }
        asked.then(
          (stillWaiting) => settle(stillWaiting),
          () => settle(false),
        );
      }
    }
    schedule();
  }

  function settle(stillWaiting: boolean): void {
    inFlight = false;
    if (finished) return; // stopped meanwhile: the answer is ignored
    if (!stillWaiting) {
      finish();
      opts.onSettled?.();
      return;
    }
    attempt += 1;
    nextDueAt = now() + waitDelayMs(attempt);
    // The next retry would fall after the cap: there is nothing more to wait for, so say so now.
    if (nextDueAt - startedAt > WAIT_CAP_MS) giveUp();
  }

  return {
    start() {
      if (started || finished) return;
      started = true;
      startedAt = now();
      nextDueAt = startedAt + waitDelayMs(0);
      if (isVisible()) schedule();
    },
    stop() {
      finish();
    },
    visibilityChanged() {
      if (!started || finished) return;
      if (isVisible()) schedule();
      else if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
