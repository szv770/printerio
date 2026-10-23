/** The small slice of `document` the helper needs, so tests can drive visibility without a DOM. */
export interface VisibilitySource {
  readonly visibilityState: "visible" | "hidden" | string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/**
 * Calls `callback` every `everyMs` while the tab is visible. Paused while hidden; refreshes once as soon as the tab
 * becomes visible again. Returns a function that removes the timer and the listener. A throwing callback never
 * breaks the schedule.
 */
export function startVisibleInterval(callback: () => void, everyMs: number, doc: VisibilitySource): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const safe = () => {
    try {
      callback();
    } catch {
      // a failed refresh must not stop the next one
    }
  };
  const start = () => {
    if (timer === null) timer = setInterval(safe, everyMs);
  };
  const stop = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
  const onVisibility = () => {
    if (doc.visibilityState === "visible") {
      safe();
      start();
    } else {
      stop();
    }
  };
  if (doc.visibilityState === "visible") start();
  doc.addEventListener("visibilitychange", onVisibility);
  return () => {
    doc.removeEventListener("visibilitychange", onVisibility);
    stop();
  };
}
