"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { commitKeys, dirtyKeys as computeDirtyKeys } from "@/lib/ui/dirty";

/**
 * Tracks a form's current values against the values it last loaded or saved.
 * The comparison itself is pure (lib/ui/dirty.ts, unit tested); this hook is
 * only the React state around it.
 *
 *   const form = useDirtyForm({ name: "A", on: true });
 *   form.set("name", "B");        // form.dirty === true
 *   form.reset();                 // back to the baseline (Discard)
 *   form.commit(["name"]);        // after a save: these keys become the baseline
 */
export function useDirtyForm<T extends Record<string, unknown>>(initial: T) {
  const [baseline, setBaseline] = useState<T>(initial);
  const [values, setValues] = useState<T>(initial);

  const dirtyKeys = useMemo(() => computeDirtyKeys(baseline, values), [baseline, values]);

  const set = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
  }, []);

  const reset = useCallback(() => setValues(baseline), [baseline]);

  const commit = useCallback(
    (keys?: Array<keyof T>) => {
      setBaseline((b) => commitKeys(b, values, keys ?? (Object.keys(values) as Array<keyof T>)));
    },
    [values],
  );

  return { values, baseline, set, setValues, reset, commit, dirtyKeys, dirty: dirtyKeys.length > 0 };
}

/** Asks the browser to confirm before the tab is closed, reloaded or navigated
 *  away by address bar / back button while `when` is true. (Next.js in-app link
 *  clicks are client-side and cannot be intercepted by the browser prompt.) */
export function useBeforeUnload(when: boolean) {
  useEffect(() => {
    if (!when) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [when]);
}
