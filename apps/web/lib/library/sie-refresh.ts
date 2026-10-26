import "server-only";
import { parse } from "node-html-parser";
import type { SieEntry } from "./sie-weekly";

/**
 * "Check for new weeks": reads Sichos In English's weekly page (https://shop.sie.org/pages/weekly, a public page the owner
 * has permission to use), finds weeks Printio does not have yet, and for each new file reads its first pages to learn which
 * Likkutei Sichos volume and page it is and where its real content starts (SIE files open with a cover, a blank page and
 * one or two dedication pages). Pure logic with injected fetchers so it is tested without the network.
 */

export const SIE_WEEKLY_PAGE = "https://shop.sie.org/pages/weekly";
const DRIVE_FILE = /^https:\/\/drive\.google\.com\/file\/d\/[A-Za-z0-9_-]{20,}\/view$/;
const SPONSOR_START = /^(dedicated|sponsored|in honor|in loving|in memory|in zechus|לע"נ|לעילוי)/i;
const MAX_FRONT_PAGES = 8;
const MAX_BACK_PAGES = 6;
/** SIE's back matter: a blank page, a "CREDITS: Copyright by Sichos in English" page, a blank back cover. */
const CREDITS_START = /^credits\b/i;

export interface ParsedSie {
  chelek: string;
  sefer: string;
  title: string;
  url: string;
  /** No file yet ("coming soon"). */
  soon: boolean;
}

const clean = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** Reads the weekly page. Anything it does not recognise gives an empty list, never an error. */
export function parseSieWeeklyPage(html: string): ParsedSie[] {
  const root = parse(html);
  const out: ParsedSie[] = [];
  for (const c of root.querySelectorAll(".chelek-section")) {
    // The header's own text, without a badge like "Coming soon".
    const headerNode = c.querySelector(".chelek-header");
    const chelek = clean(headerNode?.childNodes.find((n) => n.nodeType === 3)?.text).replace(/^chelek\s+/i, "");
    const sectionSoon = c.classList.contains("chelek-section--coming-soon");
    for (const s of c.querySelectorAll(".sefer-section")) {
      const sefer = clean(s.querySelector(".sefer-header")?.text).replace(/^sefer\s+/i, "");
      for (const w of s.querySelectorAll(".sicha-wrapper")) {
        const title = clean(w.querySelector(".sicha-title")?.text);
        const href = w.querySelector("a.sicha-btn--download")?.getAttribute("href")?.trim() ?? "";
        const hasFile = DRIVE_FILE.test(href);
        const soon = sectionSoon || !!w.querySelector(".sicha-item")?.classList.contains("sicha-item--coming-soon") || !hasFile;
        if (chelek && sefer && title) out.push({ chelek, sefer, title, url: hasFile ? href : "", soon });
      }
    }
  }
  return out;
}

export interface SieAnalysis {
  volume?: number;
  page?: number;
  /** First page of the real content (1-based). */
  from: number;
  /** Last page of the real content: the blank page, the copyright credits page and the back cover after it are left out. */
  to: number;
  pageCount: number;
}

/** Reads a SIE file's first pages. Null when it is not a readable PDF. */
export async function analyzeSiePdf(bytes: Uint8Array): Promise<SieAnalysis | null> {
  let doc: { numPages: number; getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }> };
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    doc = (await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0 } as never).promise) as unknown as typeof doc;
  } catch {
    return null;
  }
  const textOf = async (n: number) => {
    const tc = await (await doc.getPage(n)).getTextContent();
    return (tc.items as { str?: string }[]).map((i) => i.str ?? "").join(" ").replace(/\s+/g, " ").trim();
  };

  const first = await textOf(1);
  const m = /VOLUME\s+(\d{1,2})\s*,?\s*P{1,2}\.?\s*(\d{1,4})/i.exec(first);

  let from = 1;
  for (let n = 1; n <= Math.min(MAX_FRONT_PAGES, doc.numPages - 1); n++) {
    const text = n === 1 ? first : await textOf(n);
    const blank = text.length < 40;
    // SIE's cover is a short title page (its wording varies, and some covers are letter-spaced), so a short first page is the cover.
    const cover = n === 1 && text.length < 400 && !/[a-z]{3,}/.test(text); // a title page in capitals, not a page of sentences
    const sponsor = SPONSOR_START.test(text) && text.length < 1500;
    if (blank || cover || sponsor) from = n + 1;
    else break;
  }
  // From the end: drop blank pages and the credits page (the back cover is blank), but never past the start of the content.
  let to = doc.numPages;
  for (let n = doc.numPages; n > from && n > doc.numPages - MAX_BACK_PAGES; n--) {
    const text = await textOf(n);
    if (text.length < 40 || CREDITS_START.test(text)) to = n - 1;
    else break;
  }
  return { ...(m ? { volume: Number(m[1]), page: Number(m[2]) } : {}), from, to, pageCount: doc.numPages };
}

export interface RefreshDeps {
  fetchPage: () => Promise<string>;
  fetchPdf: (url: string) => Promise<{ ok: true; bytes: Uint8Array } | { ok: false; message: string }>;
  /** Files Printio already has (the saved copy plus everything added before). */
  known: Set<string>;
  save: (rows: SieEntry[]) => Promise<void>;
  /** At most this many new files per press (each is a download and a read); press again for the rest. */
  maxNew?: number;
}

export interface RefreshResult {
  /** Published weeks on the SIE page. */
  found: number;
  added: number;
  remaining: number;
  failed: { title: string; reason: string }[];
  /** Set when the page could not be read at all. */
  problem?: string;
}

export async function refreshSie(deps: RefreshDeps): Promise<RefreshResult> {
  let html: string;
  try {
    html = await deps.fetchPage();
  } catch {
    return { found: 0, added: 0, remaining: 0, failed: [], problem: "Printio could not reach the Sichos In English page right now. Try again in a minute." };
  }
  const published = parseSieWeeklyPage(html).filter((r) => !r.soon);
  if (published.length === 0) {
    return { found: 0, added: 0, remaining: 0, failed: [], problem: "The Sichos In English page looks different today, so Printio cannot read it. Tell the Printio team." };
  }
  const fresh = published.filter((r) => !deps.known.has(r.url));
  const batch = fresh.slice(0, deps.maxNew ?? 4);
  const rows: SieEntry[] = [];
  const failed: RefreshResult["failed"] = [];
  for (const r of batch) {
    const file = await deps.fetchPdf(r.url);
    if (!file.ok) {
      failed.push({ title: r.title, reason: file.message });
      continue;
    }
    const a = await analyzeSiePdf(file.bytes);
    if (!a) {
      failed.push({ title: r.title, reason: "The file could not be read as a PDF." });
      continue;
    }
    rows.push({ chelek: r.chelek, sefer: r.sefer, title: r.title, url: r.url, ...(a.volume !== undefined ? { volume: a.volume, page: a.page } : {}), from: a.from, to: a.to, pageCount: a.pageCount });
  }
  if (rows.length > 0) await deps.save(rows);
  return { found: published.length, added: rows.length, remaining: fresh.length - batch.length, failed };
}
