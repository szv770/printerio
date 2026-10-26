"use client";

import { useId, useRef, useState } from "react";
import { FlaskConical } from "lucide-react";
import { FEATURE_GROUPS, FEATURE_ROWS, type FeatureRow } from "@/lib/landing-content";
import styles from "./landing.module.css";

const LABEL: Record<FeatureRow["group"], string> = { Everyone: "For everyone", Admins: "For admins", "Behind the scenes": "Behind the scenes" };

/** "What's inside" as three tabs: one short list at a time instead of one long page of text. */
export function FeatureTabs() {
  const [group, setGroup] = useState<FeatureRow["group"]>("Everyone");
  const id = useId();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  function onKeyDown(e: React.KeyboardEvent, index: number) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = FEATURE_GROUPS[(index + (e.key === "ArrowRight" ? 1 : FEATURE_GROUPS.length - 1)) % FEATURE_GROUPS.length]!;
    setGroup(next);
    refs.current[next]?.focus();
  }

  const rows = FEATURE_ROWS.filter((r) => r.group === group);

  return (
    <div>
      <div role="tablist" aria-label="What's inside" className="flex flex-wrap gap-2">
        {FEATURE_GROUPS.map((g, i) => (
          <button
            key={g}
            ref={(el) => {
              refs.current[g] = el;
            }}
            type="button"
            role="tab"
            id={`${id}-${i}`}
            aria-selected={group === g}
            aria-controls={`${id}-panel`}
            tabIndex={group === g ? 0 : -1}
            className={styles.tab}
            onClick={() => setGroup(g)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {LABEL[g]}
          </button>
        ))}
      </div>
      <ul
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-${FEATURE_GROUPS.indexOf(group)}`}
        key={group}
        className={`${styles.panelIn} mt-5 grid gap-x-10 p-0 md:grid-cols-2`}
      >
        {rows.map((r) => (
          <li key={r.title} className="list-none border-b border-[var(--line)] py-4">
            <p className="flex flex-wrap items-center gap-2 font-semibold">
              {r.title}
              {r.testing && (
                <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-warning-soft)] px-2 py-0.5 text-xs font-semibold text-[var(--color-warning-ink)]">
                  <FlaskConical className="h-3 w-3" aria-hidden="true" />
                  still testing
                </span>
              )}
            </p>
            <p className="mt-1 text-[0.9375rem] leading-6 text-[var(--ink-2)]">{r.detail}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
