"use client";

import { useCallback, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { bookletSpread, spreadCaption, SPREAD_COUNT } from "@/lib/landing-booklet";
import styles from "./landing.module.css";

const TURN_MS = 800;

function Page({ n }: { n: number | null }) {
  if (n === null) return null;
  return (
    <div className={styles.bkPage}>
      <span className={styles.bkNum}>{n}</span>
    </div>
  );
}

/**
 * An 8 page booklet you can flip through. English opens like any book (spine on the left, cover on the right);
 * Hebrew is the exact mirror (spine on the right, cover on the left), which is what Printio's left and right binding
 * do. The book is laid out once for English and mirrored for Hebrew, with the page numbers flipped back so they read
 * normally. Tap a page, swipe, press the arrow keys or use the buttons.
 */
export function BookletDemo() {
  const [rtl, setRtl] = useState(false);
  const [spread, setSpread] = useState(0);
  const [turn, setTurn] = useState<{ dir: "next" | "prev"; to: number } | null>(null);
  const drag = useRef<number | null>(null);

  const go = useCallback(
    (dir: "next" | "prev") => {
      if (turn) return;
      const to = spread + (dir === "next" ? 1 : -1);
      if (to < 0 || to >= SPREAD_COUNT) return;
      setTurn({ dir, to });
      setTimeout(() => {
        setSpread(to);
        setTurn(null);
      }, TURN_MS);
    },
    [turn, spread],
  );

  const now = bookletSpread(spread);
  const dest = turn ? bookletSpread(turn.to) : null;
  // What sits under and around the page that is turning.
  const leftStatic = turn ? (turn.dir === "next" ? now.left : dest!.left) : now.left;
  const rightStatic = turn ? (turn.dir === "next" ? dest!.right : now.right) : now.right;
  const leafFront = turn ? (turn.dir === "next" ? now.right : dest!.right) : null;
  const leafBack = turn ? (turn.dir === "next" ? dest!.left : now.left) : null;

  const canNext = spread < SPREAD_COUNT - 1;
  const canPrev = spread > 0;
  // Buttons sit where the pages turn: the book is mirrored for Hebrew, so "next" is on the left there.
  const nextOnRight = !rtl;

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const visualRight = e.key === "ArrowRight";
    go(visualRight === nextOnRight ? "next" : "prev");
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Reading direction">
        <button type="button" className={styles.toggle} aria-pressed={!rtl} onClick={() => setRtl(false)}>
          English
        </button>
        <button type="button" className={styles.toggle} aria-pressed={rtl} onClick={() => setRtl(true)}>
          Hebrew
        </button>
      </div>

      <div
        className={styles.bkWrap}
        tabIndex={0}
        role="group"
        aria-label="Booklet. Use the arrow keys, swipe, or tap a page to turn it."
        onKeyDown={onKeyDown}
        onPointerDown={(e) => {
          drag.current = e.clientX;
        }}
        onPointerUp={(e) => {
          if (drag.current === null) return;
          const dx = e.clientX - drag.current;
          drag.current = null;
          if (Math.abs(dx) < 40) return; // a tap: the page's own click handles it
          // Swiping toward the spine side turns forward, the way you would pull a page across.
          const towardLeft = dx < 0;
          go(towardLeft === nextOnRight ? "next" : "prev");
        }}
      >
        <div className={styles.bk} data-rtl={rtl} data-pos={turn ? "open" : spread === 0 ? "cover" : spread === SPREAD_COUNT - 1 ? "back" : "open"}>
          <button type="button" className={`${styles.bkHalf} ${styles.bkLeft}`} aria-label="Previous pages" disabled={!canPrev} onClick={() => go("prev")}>
            <Page n={leftStatic} />
          </button>
          <button type="button" className={`${styles.bkHalf} ${styles.bkRight}`} aria-label="Next pages" disabled={!canNext} onClick={() => go("next")}>
            <Page n={rightStatic} />
          </button>
          {turn && (
            <div className={styles.leaf} data-dir={turn.dir} aria-hidden="true">
              <div className={styles.leafFace}>
                <Page n={leafFront} />
              </div>
              <div className={`${styles.leafFace} ${styles.leafBack}`}>
                <Page n={leafBack} />
              </div>
            </div>
          )}
        </div>
      </div>

      <div className={`mt-2 flex items-center justify-between gap-3 ${nextOnRight ? "" : "flex-row-reverse"}`}>
        <button type="button" className={styles.turnBtn} onClick={() => go("prev")} disabled={!canPrev || !!turn} aria-label="Back">
          {nextOnRight ? <ChevronLeft className="h-5 w-5" aria-hidden="true" /> : <ChevronRight className="h-5 w-5" aria-hidden="true" />}
          Back
        </button>
        <p className="text-center text-sm text-[var(--ink-2)]" aria-live="polite">
          {spreadCaption(spread)}
        </p>
        <button type="button" className={styles.turnBtn} onClick={() => go("next")} disabled={!canNext || !!turn} aria-label="Next">
          Next
          {nextOnRight ? <ChevronRight className="h-5 w-5" aria-hidden="true" /> : <ChevronLeft className="h-5 w-5" aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}
