"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check } from "lucide-react";
import { pagesToRangeText, quickSelection, rangeTextToPages, togglePage, type QuickKind } from "@/lib/page-select";
import { pdfjsAssetOptions } from "@/lib/pdf/pdfjs-options";
import styles from "./page-picker.module.css";

const THUMB_WIDTH_CSS_PX = 112;

const QUICK: { kind: QuickKind; label: string }[] = [
  { kind: "all", label: "All" },
  { kind: "first", label: "First page" },
  { kind: "last3", label: "Last 3" },
  { kind: "odd", label: "Odd" },
  { kind: "even", label: "Even" },
  { kind: "invert", label: "Swap" },
  { kind: "none", label: "Clear" },
];

interface PdfLike {
  numPages: number;
  getPage(n: number): Promise<{
    getViewport(o: { scale: number }): { width: number; height: number };
    render(o: Record<string, unknown>): { promise: Promise<void> };
    cleanup(): void;
  }>;
  destroy(): Promise<void>;
}

/** One page, drawn small the moment it scrolls into view. */
function Thumb({ n, selected, onToggle, load }: { n: number; selected: boolean; onToggle: () => void; load: (n: number, canvas: HTMLCanvasElement) => Promise<void> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const tile = useRef<HTMLButtonElement>(null);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    const el = tile.current;
    if (!el || drawn) return;
    let cancelled = false;
    const start = () => {
      if (cancelled || !canvas.current) return;
      void load(n, canvas.current).then(() => !cancelled && setDrawn(true));
    };
    if (typeof IntersectionObserver === "undefined") {
      start();
      return () => {
        cancelled = true;
      };
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          start();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [n, load, drawn]);

  return (
    <button ref={tile} type="button" aria-pressed={selected} aria-label={`Page ${n}`} className={styles.tile} onClick={onToggle}>
      <canvas ref={canvas} className={styles.canvas} />
      <span className={styles.num}>{n}</span>
      {selected && (
        <span className={styles.check} aria-hidden="true">
          <Check className="h-3.5 w-3.5" />
        </span>
      )}
    </button>
  );
}

/**
 * Tap pages to choose them, like the print page on a phone. The page range text stays the single source of truth: this
 * reads it and writes it (lib/page-select.ts), so typing and tapping always agree. Thumbnails are drawn lazily as they
 * scroll into view, from one copy of the document loaded once.
 */
export function PagePicker({ bytes, totalPages, value, onChange }: { bytes: ArrayBuffer; totalPages: number; value: string; onChange: (text: string) => void }) {
  const selected = useMemo(() => rangeTextToPages(value, totalPages), [value, totalPages]);
  const pdf = useRef<Promise<PdfLike> | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let dead = false;
    pdf.current = (async () => {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
      // pdf.js takes ownership of the buffer it is given: hand it a copy so the Print form keeps its own.
      return (await pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)), ...pdfjsAssetOptions() }).promise) as unknown as PdfLike;
    })();
    pdf.current.catch(() => !dead && setFailed(true));
    return () => {
      dead = true;
      const p = pdf.current;
      pdf.current = null;
      void p?.then((d) => d.destroy()).catch(() => undefined);
    };
  }, [bytes]);

  const load = useMemo(
    () => async (n: number, canvas: HTMLCanvasElement) => {
      try {
        const doc = await pdf.current;
        if (!doc) return;
        const page = await doc.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale: (THUMB_WIDTH_CSS_PX / base.width) * dpr });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        await page.render({ canvas, canvasContext: ctx, viewport }).promise;
        page.cleanup();
      } catch {
        // a page that cannot be drawn stays a plain numbered tile: it can still be tapped
      }
    },
    [],
  );

  // Fast taps can arrive before the form has re-rendered: always build on the latest choice, not the last render's.
  const latest = useRef<number[]>(selected);
  useEffect(() => {
    latest.current = selected;
  }, [selected]);
  const set = (pages: number[]) => {
    latest.current = pages;
    onChange(pagesToRangeText(pages));
  };

  return (
    <div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick choices">
        {QUICK.map((q) => (
          <button key={q.kind} type="button" className={styles.quick} onClick={() => set(quickSelection(q.kind, totalPages, latest.current))}>
            {q.label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-[13px] text-[var(--color-muted)]" aria-live="polite">
        {selected.length === 0 ? "No pages chosen. Tap the pages you want." : `${selected.length} of ${totalPages} pages chosen.`}
      </p>
      <div className={styles.grid} role="group" aria-label="Pages">
        {Array.from({ length: totalPages }, (_, i) => i + 1).map((n) => (
          <Thumb key={`${n}`} n={n} selected={selected.includes(n)} onToggle={() => set(togglePage(latest.current, n, totalPages))} load={load} />
        ))}
      </div>
      {failed && <p className="mt-2 text-sm text-[var(--color-muted)]">Previews could not be drawn here. You can still tap the numbers or type the pages.</p>}
    </div>
  );
}
