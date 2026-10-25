/**
 * Client-side PDF page rendering onto a <canvas>, via pdfjs-dist.
 *
 * Shared by the submitter's own preview of the file they just picked
 * (app/(dashboard)/print/PrintForm.tsx, from a local File) and by an
 * approver's preview of a pending job (app/admin/approvals/ApprovalQueue.tsx,
 * from bytes fetched over a short-lived signed URL) so there is one renderer,
 * one worker-configuration line, and one error policy rather than two
 * near-copies that can drift.
 *
 * pdfjs-dist is imported dynamically so its ~1MB never lands in the initial
 * bundle for a page nobody has asked for a preview on yet, and every failure
 * (malformed PDF, worker load failure, no 2D context) is swallowed into a
 * `false` return: a preview is a nicety, never a gate. The authoritative
 * validation is always the server's own preflight (lib/pdf/preflight.ts).
 */

import { pdfjsAssetOptions } from "./pdfjs-options";

export interface RenderPdfPageOptions {
  /** Longest the rendered page may be across, in CSS pixels. */
  maxWidthPx: number;
  /** 1-based page number. Defaults to the first page. */
  pageNumber?: number;
}

export async function renderPdfPageToCanvas(
  data: ArrayBuffer | Uint8Array,
  canvas: HTMLCanvasElement,
  options: RenderPdfPageOptions,
): Promise<boolean> {
  try {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

    const pdf = await pdfjs.getDocument({ data, ...pdfjsAssetOptions() }).promise;
    const pageNumber = Math.min(Math.max(1, options.pageNumber ?? 1), pdf.numPages);
    const page = await pdf.getPage(pageNumber);
    const unscaledViewport = page.getViewport({ scale: 1 });
    const scale = options.maxWidthPx / unscaledViewport.width;
    const viewport = page.getViewport({ scale });

    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const context = canvas.getContext("2d");
    if (!context) return false;
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    return true;
  } catch {
    return false;
  }
}
