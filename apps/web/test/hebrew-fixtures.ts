// Test helper: realistic Hebrew PDFs built with pdf-lib + fontkit and the David Libre font Printio already bundles,
// plus helpers to read back what a viewer would extract (pdfjs text per page) and which fonts a page uses.
import fontkit from "@pdf-lib/fontkit";
import { PDFDict, PDFDocument, PDFName, PDFRef, PDFStream, PDFString, degrees, type PDFPage } from "pdf-lib";
import { DAVID_LIBRE_REGULAR_BASE64 } from "@/lib/booklet/fonts/david-libre-regular";

export const FONT_BYTES = Buffer.from(DAVID_LIBRE_REGULAR_BASE64, "base64");

export const HEBREW_LINES = ["שלום עולם", "ברוכים הבאים ללוח הלימוד", "תניא - ליקוטי אמרים פרק א"];
export const MIXED_LINES = ["שלום world 123", "בְּרֵאשִׁית בָּרָא אֱלֹהִים", "Page 7 - דף ז׳ (2026)"];

export interface FixtureOptions {
  /** One entry per page: the lines drawn on it. */
  pages?: string[][];
  /** false = the whole font is embedded (bigger file); default true = subset. */
  subset?: boolean;
  size?: [number, number];
  /** Per-page /Rotate. */
  rotate?: number;
  /** Adds a file attachment and a JavaScript open action, so the sanitizer has something to remove. */
  active?: boolean;
  /** Written with object streams + xref stream (what Chrome/Skia and most HTML-to-PDF tools produce). */
  objectStreams?: boolean;
  /** Moves Resources, MediaBox and Rotate from every page up to the /Pages node (legal PDF, common from generators). */
  inherit?: boolean;
}

export async function makeHebrewPdf(opts: FixtureOptions = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(FONT_BYTES, { subset: opts.subset ?? true });
  const [w, h] = opts.size ?? [612, 792];
  for (const lines of opts.pages ?? [HEBREW_LINES]) {
    const page: PDFPage = doc.addPage([w, h]);
    if (opts.rotate) page.setRotation(degrees(opts.rotate));
    lines.forEach((line, i) => page.drawText(line, { x: 60, y: h - 100 - i * 40, size: 22, font }));
  }
  if (opts.active) {
    await doc.attach(new TextEncoder().encode("hello"), "notes.txt", { mimeType: "text/plain" });
    const js = doc.context.obj({ S: "JavaScript", JS: PDFString.of("app.alert('hi')") });
    doc.catalog.set(PDFName.of("OpenAction"), doc.context.register(js));
  }
  if (opts.inherit) {
    const pages = doc.getPages();
    const parent = pages[0]!.node.Parent();
    if (parent) {
      for (const key of ["Resources", "MediaBox", "Rotate"]) {
        const v = pages[0]!.node.get(PDFName.of(key));
        if (v) parent.set(PDFName.of(key), v);
        for (const p of pages) p.node.delete(PDFName.of(key));
      }
    }
  }
  return doc.save({ useObjectStreams: opts.objectStreams ?? false });
}

// ---- reading back ----------------------------------------------------------------------------------------------

interface PdfjsText {
  getDocument: (src: Record<string, unknown>) => { promise: Promise<{ numPages: number; getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: Array<{ str?: string }> }> }> }>; destroy?: () => Promise<void> };
}
let pdfjs: Promise<PdfjsText> | null = null;
async function load(): Promise<PdfjsText> {
  pdfjs ??= (async () => {
    const worker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
    return (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsText;
  })();
  return pdfjs;
}

/** What pdfjs extracts from each page, as an ordered list of text strings (empty strings dropped). */
export async function pageTexts(bytes: Uint8Array): Promise<string[][]> {
  const lib = await load();
  const task = lib.getDocument({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false, useSystemFonts: false, disableFontFace: true });
  const doc = await task.promise;
  const out: string[][] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      out.push(tc.items.map((i) => i.str ?? "").filter((s) => s.length > 0));
    }
  } finally {
    await task.destroy?.();
  }
  return out;
}

/** Only the characters that are not ASCII (so the ASCII stamp and layout whitespace never matter), joined per page. */
export const nonAscii = (strings: string[]): string => strings.join("").replace(/[\u0000-\u007f\s]/g, "");

/** Every font (BaseFont name) the page uses, including fonts inside form XObjects (what imposition makes of a page). */
export function pageFonts(doc: PDFDocument, pageIndex: number): string[] {
  const names = new Set<string>();
  const seen = new Set<unknown>();
  const lookup = (v: unknown) => (v instanceof PDFRef ? doc.context.lookup(v) : v);
  const walkResources = (resources: unknown) => {
    const res = lookup(resources);
    if (!(res instanceof PDFDict) || seen.has(res)) return;
    seen.add(res);
    const fonts = lookup(res.get(PDFName.of("Font")));
    if (fonts instanceof PDFDict) {
      for (const [, f] of fonts.entries()) {
        const fd = lookup(f);
        if (fd instanceof PDFDict) {
          const base = fd.get(PDFName.of("BaseFont"));
          names.add(base instanceof PDFName ? base.asString() : "(unnamed)");
        }
      }
    }
    const xobjects = lookup(res.get(PDFName.of("XObject")));
    if (xobjects instanceof PDFDict) {
      for (const [, x] of xobjects.entries()) {
        const xo = lookup(x);
        if (xo instanceof PDFStream) walkResources(xo.dict.get(PDFName.of("Resources")));
      }
    }
  };
  const node = doc.getPage(pageIndex).node;
  walkResources(node.Resources());
  return [...names].sort();
}

/** Fonts that came with a ToUnicode map (Type0 fonts), by BaseFont name, anywhere in the document. */
export function fontsWithToUnicode(doc: PDFDocument): string[] {
  const out: string[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict && obj.get(PDFName.of("Type")) === PDFName.of("Font") && obj.has(PDFName.of("ToUnicode"))) {
      const base = obj.get(PDFName.of("BaseFont"));
      if (base instanceof PDFName) out.push(base.asString());
    }
  }
  return out.sort();
}

