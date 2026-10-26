"use client";

import { useState } from "react";
import styles from "./landing.module.css";

/**
 * Shows what a booklet sheet really is: two pages side by side (the outer sheet carries the last and first page),
 * folded in the middle. Switch between reading left to right and right to left: the pages swap sides and the booklet
 * opens from the other edge, which is exactly what the left and right binding choice does in Printio.
 */
export function BookletDemo() {
  const [closed, setClosed] = useState(false);
  const [rtl, setRtl] = useState(false);

  // Outer sheet of an 8 page booklet: the first page and the last page.
  const leftPage = rtl ? 1 : 8;
  const rightPage = rtl ? 8 : 1;

  return (
    <div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Booklet options">
        <button type="button" className={styles.toggle} aria-pressed={!rtl} onClick={() => setRtl(false)}>
          English, left edge
        </button>
        <button type="button" className={styles.toggle} aria-pressed={rtl} onClick={() => setRtl(true)}>
          Hebrew, right edge
        </button>
        <button type="button" className={styles.toggle} aria-pressed={closed} onClick={() => setClosed((v) => !v)}>
          {closed ? "Open the sheet" : "Fold it"}
        </button>
      </div>
      <div className={styles.book}>
        <div className={styles.spread} data-closed={closed} data-rtl={rtl}>
          <div className={`${styles.pageFace} ${styles.foldLeft}`}>
            <span>{leftPage}</span>
          </div>
          <div className={`${styles.pageFace} ${styles.foldRight}`}>
            <span>{rightPage}</span>
          </div>
        </div>
      </div>
      <p className="text-sm text-[var(--color-muted)]" aria-live="polite">
        {closed
          ? rtl
            ? "Page 1 is the cover, and the booklet opens from the right."
            : "Page 1 is the cover, and the booklet opens from the left."
          : "The outer sheet carries the last page and the first. Printio arranges every sheet for you."}
      </p>
    </div>
  );
}
