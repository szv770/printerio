"use client";

import { useState } from "react";
import { detailsToggleLabel } from "./detailsToggle";

/** Technical details of one log entry, hidden until asked for. */
export function ActivityDetails({ items }: { items: { label: string; value: string }[] }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return <span className="text-[var(--color-faint)]">None</span>;
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="group">
      <summary className="inline-flex min-h-11 cursor-pointer items-center text-[13px] font-medium text-[var(--color-primary)] hover:underline md:min-h-0">
        {detailsToggleLabel(open)}
      </summary>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-left text-[13px]">
        {items.map((d) => (
          <div key={d.label} className="contents">
            <dt className="text-[var(--color-muted)]">{d.label}</dt>
            <dd className="min-w-0 break-words text-[var(--color-text-2)]">{d.value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
