import { isLibraryWaiting, type LibraryWaiting } from "./results";
import type { WaitController } from "./wait-controller";

/** What a library screen shows while a page is not there yet (the component that draws it is components/library/WaitNotice.tsx). */
export interface WaitView {
  /** `pending`: the print server was asked and the screen asks again by itself. `offline`: no print server is on; nothing is polled. */
  kind: "pending" | "offline";
  /** The server's own sentence (shown for `offline`). */
  message: string;
  /** The screen stopped asking after about 90 seconds. */
  gaveUp: boolean;
  elapsedMs: number;
}

export type ShowWait = (next: WaitView | null | ((cur: WaitView | null) => WaitView | null)) => void;

export const SOMETHING_WENT_WRONG = "Something went wrong on our side. Try again.";

export interface WatchWaitOptions<T extends { ok: true }> {
  controller: WaitController;
  /** One wait per item: "main" for a volume or year, "entry:<path>" for one opened entry. */
  key: string;
  /** The waiting answer that started this (pending or offline). */
  first: LibraryWaiting;
  /** False once the person has moved on (another tab, another entry): then nothing is shown and nothing is started. */
  isShown: () => boolean;
  /** Ask the same question again. */
  ask: () => Promise<T | { ok: false; message: string }>;
  show: ShowWait;
  onOk: (result: T) => void;
  onFail: (message: string) => void;
}

/**
 * The page is not there yet (the print server was asked): ask again by itself, 5 s, 10 s, then every 15 s apart, for about 90 s,
 * only while the message is on screen and the tab is visible (wait-poller.ts and wait-controller.ts hold those rules). A print server
 * that is offline is shown as it is and never asked again by itself. When an asking comes back with the page, or with an error,
 * it is handed to `onOk` / `onFail` and the waiting message goes; an answer that arrives after the person moved on is dropped.
 */
export function watchLibraryWait<T extends { ok: true }>(o: WatchWaitOptions<T>): void {
  o.controller.stop(o.key);
  if (!o.isShown()) return;
  const offline = (message: string): WaitView => ({ kind: "offline", message, gaveUp: false, elapsedMs: 0 });
  if ("offline" in o.first) return o.show(offline(o.first.message));
  o.show({ kind: "pending", message: o.first.message, gaveUp: false, elapsedMs: 0 });
  o.controller.track(o.key, {
    retry: async (isCurrent) => {
      const res = await o.ask().catch(() => null);
      if (!isCurrent()) return false;
      if (!res) {
        o.show(null);
        o.onFail(SOMETHING_WENT_WRONG);
        return false;
      }
      if (res.ok) {
        o.show(null);
        o.onOk(res);
        return false;
      }
      if (isLibraryWaiting(res)) {
        if ("offline" in res) {
          o.show(offline(res.message));
          return false;
        }
        return true;
      }
      o.show(null);
      o.onFail(res.message);
      return false;
    },
    onProgress: (elapsedMs) => o.show((cur) => (cur && cur.kind === "pending" ? { ...cur, elapsedMs } : cur)),
    onGiveUp: () => o.show((cur) => (cur ? { ...cur, gaveUp: true } : cur)),
  });
}
