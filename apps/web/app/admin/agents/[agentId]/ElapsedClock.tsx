"use client";

import { useEffect, useState } from "react";
import { formatElapsed } from "@/lib/update-progress";

/** "Time so far 0:42", ticking every second so a slow step never looks frozen. Renders nothing until mounted. */
export function ElapsedClock({ since, now }: { since: string | null; now?: number }) {
  const start = since ? Date.parse(since) : Number.NaN;
  const [tick, setTick] = useState<number | null>(now ?? null);
  useEffect(() => {
    if (now !== undefined) return;
    const update = () => setTick(Date.now());
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [now]);
  if (!Number.isFinite(start) || tick === null) return null;
  return (
    <span className="tabular-nums">
      Time so far <span className="font-semibold text-[var(--color-text)]">{formatElapsed(tick - start)}</span>
    </span>
  );
}
