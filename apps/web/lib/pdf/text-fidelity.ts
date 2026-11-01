import "server-only";
import { bookletPageOrder } from "./imposition";

/**
 * Safeguard: the PDF Printio prints must say the same thing as the PDF the member sent.
 *
 * Every step that rewrites a file (sanitize, page range, booklet imposition, stamp) is meant to leave text alone,
 * and tests prove it for the cases we know. This check does not depend on knowing the cause: after the derived file
 * is built it reads the text of the original and of the derived file with pdfjs (the same reader a viewer uses) and
 * compares, per page, the NON-LATIN characters (Hebrew, Arabic, Cyrillic, ...). Our own stamp is ASCII, so it never
 * counts; imposition only moves, scales and crops whole pages, so each booklet sheet side must hold exactly the
 * characters of its two source pages (the page mapping is the one imposition itself uses).
 *
 * Cheap on purpose: it does nothing unless the original has non-Latin text, only reads text (no rendering), is
 * skipped for files over MAX_BYTES, and stops when its time budget is spent. It FAILS OPEN: anything unexpected
 * (an error, a timeout, a page-count surprise) returns "skipped", never "changed", so the check itself can never
 * block a job.
 */

export const TEXT_CHECK_BUDGET_MS = 4_000;
/** Larger files skip the check (the pdfjs parse alone costs seconds of CPU on a billed serverless function). */
export const TEXT_CHECK_MAX_BYTES = 8 * 1024 * 1024;
const MAX_PAGES = 300;

/** What the member is told, and what is stored as the held reason. */
export const TEXT_CHANGED_MESSAGE =
  "Printio could not prepare this file without changing its text. Nothing was printed. Try printing it again as a different PDF, or tell an admin.";

export type TextFidelityResult =
  | { status: "ok" }
  | { status: "skipped"; reason: string }
  /** `page` is the 1-based page of the DERIVED file whose text differs. */
  | { status: "changed"; page: number };

interface PdfjsText {
  getDocument: (src: Record<string, unknown>) => {
    promise: Promise<{ numPages: number; getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: Array<{ str?: string }> }>; cleanup: () => void }> }>;
    destroy?: () => Promise<void>;
  };
}

let pdfjsPromise: Promise<PdfjsText> | null = null;
async function loadPdfjs(): Promise<PdfjsText> {
  pdfjsPromise ??= (async () => {
    const worker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
    return (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsText;
  })();
  return pdfjsPromise;
}

const NON_LATIN_LETTER = /[\p{L}\p{M}]/u;
const LATIN = /\p{Script=Latin}/u;

/** The non-Latin letters and marks of a string, sorted: order- and bidi-independent, so layout and reading order never matter. */
function nonLatinChars(text: string): string {
  const out: string[] = [];
  for (const ch of text) if (NON_LATIN_LETTER.test(ch) && !LATIN.test(ch)) out.push(ch);
  return out.sort().join("");
}

class Skip extends Error {}

/** One entry per page: its non-Latin characters. Throws Skip when over budget, too big or too long. */
async function pageChars(pdfjs: PdfjsText, bytes: Uint8Array, deadline: number): Promise<string[]> {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false, useSystemFonts: false, disableFontFace: true, stopAtErrors: false });
  try {
    const doc = await task.promise;
    if (doc.numPages > MAX_PAGES) throw new Skip("too many pages");
    const out: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      if (Date.now() > deadline) throw new Skip("time budget spent");
      const page = await doc.getPage(n);
      try {
        const tc = await page.getTextContent();
        out.push(nonLatinChars(tc.items.map((i) => i.str ?? "").join("")));
      } finally {
        page.cleanup();
      }
    }
    return out;
  } finally {
    try {
      await task.destroy?.();
    } catch {
      /* nothing to free */
    }
  }
}

export interface TextFidelityInput {
  /** The upload exactly as received. */
  original: Uint8Array;
  /** The file that would print. */
  derived: Uint8Array;
  /** 1-based pages of `original` that the derived file was built from, in order (the page range); null = all pages. */
  sourcePages: readonly number[] | null;
  /** The derived file is an imposed booklet (two source pages per sheet side). */
  booklet: boolean;
  budgetMs?: number;
}

export async function checkTextFidelity(input: TextFidelityInput): Promise<TextFidelityResult> {
  const { original, derived, sourcePages, booklet } = input;
  if (original.byteLength > TEXT_CHECK_MAX_BYTES || derived.byteLength > TEXT_CHECK_MAX_BYTES) return { status: "skipped", reason: "file too large to check" };
  const deadline = Date.now() + (input.budgetMs ?? TEXT_CHECK_BUDGET_MS);
  try {
    const pdfjs = await loadPdfjs();
    const originalChars = await pageChars(pdfjs, original, deadline);
    if (originalChars.every((c) => c === "")) return { status: "skipped", reason: "no non-Latin text" };

    // The text each derived page must carry, from the original's pages.
    const sources = sourcePages ? sourcePages.map((p) => originalChars[p - 1] ?? "") : originalChars;
    let expected: string[];
    if (booklet) {
      const padded = [...sources];
      while (padded.length % 4 !== 0 || padded.length === 0) padded.push("");
      expected = bookletPageOrder(padded.length)
        .flatMap((s) => [s.front, s.back])
        .map(([l, r]) => [...(padded[l - 1]! + padded[r - 1]!)].sort().join(""));
    } else {
      expected = sources;
    }

    const got = await pageChars(pdfjs, derived, deadline);
    if (got.length !== expected.length) return { status: "skipped", reason: `page count differs (${got.length} vs ${expected.length})` };
    for (let i = 0; i < expected.length; i++) if (got[i] !== expected[i]) return { status: "changed", page: i + 1 };
    return { status: "ok" };
  } catch (err) {
    return { status: "skipped", reason: err instanceof Error ? err.message : String(err) };
  }
}
