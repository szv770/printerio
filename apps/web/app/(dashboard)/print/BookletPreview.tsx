"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Spinner } from "@/components/ui";
import { pdfjsAssetOptions } from "@/lib/pdf/pdfjs-options";

export interface BookletPreviewData {
  pdfBase64: string;
  bindingSide: "left" | "right";
  sheets: number;
  blankPagesAdded: number;
}

const RENDER_WIDTH_CSS_PX = 560;

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Shows the imposed booklet exactly as the printer will get it: one slide per sheet side (front, back), a dashed
 * line where it folds. Drawn to canvases with pdfjs-dist (Android Chrome cannot show a PDF inside the page), loaded
 * only once a preview has been asked for. Slides swipe on a phone (scroll snap); the arrows are for a mouse.
 * The PDF already has left or right binding applied, so what is drawn is what is printed; the caption just says it.
 */
export function BookletPreview({ data }: { data: BookletPreviewData }) {
  const canvases = useRef<Array<HTMLCanvasElement | null>>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const [sides, setSides] = useState(data.sheets * 2);
  const [rendered, setRendered] = useState(0);
  const [failed, setFailed] = useState(false);
  const [someBlank, setSomeBlank] = useState(false);
  // The real sheet shape (Letter landscape for a regular booklet, 11x17 landscape for the large one), known after page 1.
  const [ratio, setRatio] = useState(792 / 612);
  const [current, setCurrent] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        const pdf = await pdfjs.getDocument({ data: base64ToBytes(data.pdfBase64), ...pdfjsAssetOptions() }).promise;
        if (cancelled) return;
        setSides(pdf.numPages);
        // Wait a frame so the canvases for the real page count exist.
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        for (let n = 1; n <= pdf.numPages; n++) {
          if (cancelled) return;
          const canvas = canvases.current[n - 1];
          // A missing canvas used to end the loop silently and leave the spinner covering the page (it looked white).
          if (!canvas) throw new Error("preview canvas missing");
          // One page that cannot be drawn (an image format this browser lacks) must not blank the others.
          try {
            const page = await pdf.getPage(n);
            const base = page.getViewport({ scale: 1 });
            if (n === 1) setRatio(base.width / base.height);
            const viewport = page.getViewport({ scale: (RENDER_WIDTH_CSS_PX / base.width) * dpr });
            canvas.width = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("no 2d context");
            await page.render({ canvas, canvasContext: ctx, viewport }).promise;
          } catch {
            if (!cancelled) setSomeBlank(true);
          }
          if (!cancelled) setRendered(n);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data.pdfBase64]);

  function go(delta: number) {
    const el = scroller.current;
    if (!el) return;
    const slide = el.firstElementChild as HTMLElement | null;
    el.scrollBy({ left: delta * ((slide?.offsetWidth ?? el.clientWidth) + 12), behavior: "smooth" });
  }

  function onScroll() {
    const el = scroller.current;
    const slide = el?.firstElementChild as HTMLElement | null;
    if (!el || !slide) return;
    setCurrent(Math.round(el.scrollLeft / (slide.offsetWidth + 12)));
  }

  const right = data.bindingSide === "right";

  return (
    <div className="mt-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3" data-testid="booklet-preview">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{right ? "Right binding" : "Left binding"}</p>
        <div className="flex items-center gap-1">
          <span className="mr-1 text-xs tabular-nums text-[var(--color-muted)]">
            {Math.min(current + 1, sides)} of {sides}
          </span>
          <button
            type="button"
            aria-label="Previous sheet side"
            onClick={() => go(-1)}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] focus-visible:outline-none focus-visible:shadow-[var(--ring)]"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Next sheet side"
            onClick={() => go(1)}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] focus-visible:outline-none focus-visible:shadow-[var(--ring)]"
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
      <p className="mt-0.5 text-xs text-[var(--color-muted)]">
        {data.sheets} {data.sheets === 1 ? "sheet" : "sheets"}, printed on both sides, folded on the dashed line.
        {right ? " Pages run right to left." : ""}
        {data.blankPagesAdded > 0 ? ` Includes ${data.blankPagesAdded} blank ${data.blankPagesAdded === 1 ? "page" : "pages"} at the end.` : ""}
      </p>

      <div
        ref={scroller}
        onScroll={onScroll}
        tabIndex={0}
        aria-label="Booklet sheets, swipe sideways to see each side"
        className="mt-3 flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 focus-visible:outline-none focus-visible:shadow-[var(--ring)]"
      >
        {Array.from({ length: sides }, (_, i) => (
          <figure key={i} className="w-[92%] max-w-[600px] shrink-0 snap-center sm:w-[560px]">
            <div className="relative overflow-hidden rounded-md bg-white shadow-[var(--shadow-card)] ring-1 ring-black/10">
              <canvas
                ref={(el) => {
                  canvases.current[i] = el;
                }}
                className="block h-auto w-full"
                style={{ aspectRatio: String(ratio) }}
              />
              <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-1/2 border-l border-dashed border-black/40" />
              {rendered <= i && !failed && (
                <div className="absolute inset-0 flex items-center justify-center bg-white/70">
                  <Spinner />
                </div>
              )}
            </div>
            <figcaption className="mt-1 text-xs text-[var(--color-muted)]">
              Sheet {Math.floor(i / 2) + 1}, {i % 2 === 0 ? "front" : "back"}
            </figcaption>
          </figure>
        ))}
      </div>
      {failed && <p className="mt-2 text-sm text-[var(--color-danger)]">The preview could not be drawn in this browser. Printing is not affected.</p>}
      {!failed && someBlank && (
        <p className="mt-2 text-sm text-[var(--color-warning-ink)]">Some pages could not be drawn here, so they may look blank. The booklet itself is still built and will print normally.</p>
      )}
    </div>
  );
}
