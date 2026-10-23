import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import { containsPjlEscape } from "@printio/shared";
import { findActiveContent } from "./active-content";
import { preflightPdf } from "./preflight";

async function makeValidPdf(pageCount: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage([612, 792]); // US Letter
  return doc.save();
}

describe("preflightPdf", () => {
  it("accepts a well-formed PDF and returns the real page count", async () => {
    const bytes = await makeValidPdf(12);
    const result = await preflightPdf(bytes, { maxSizeBytes: 10 * 1024 * 1024 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pageCount).toBe(12);
      expect(result.fileSizeBytes).toBe(bytes.byteLength);
    }
  });

  it("rejects an empty file", async () => {
    const result = await preflightPdf(new Uint8Array(0), { maxSizeBytes: 1024 });
    expect(result.ok).toBe(false);
  });

  it("rejects a file missing the %PDF- header without attempting a full parse", async () => {
    const notAPdf = new TextEncoder().encode("this is definitely not a pdf file, just plain text");
    const result = await preflightPdf(notAPdf, { maxSizeBytes: 1024 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/doesn.t look like a pdf/i);
  });

  it("rejects a file that has the PDF header but is otherwise malformed/truncated", async () => {
    // Valid header, garbage body - pdf-lib's parser should fail cleanly
    // rather than the whole request crashing.
    const truncated = new TextEncoder().encode("%PDF-1.4\n%garbage garbage garbage, not a real xref table");
    const result = await preflightPdf(truncated, { maxSizeBytes: 1024 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/couldn.t read this pdf/i);
  });

  it("rejects a file exceeding the configured maximum size, never attempting to parse it", async () => {
    const bytes = await makeValidPdf(1);
    const result = await preflightPdf(bytes, { maxSizeBytes: 10 }); // absurdly small ceiling
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/exceeds/i);
  });

  it("accepts a PDF that declares embedded JavaScript, handing back a sanitized copy without it", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    doc.catalog.set(
      PDFName.of("OpenAction"),
      doc.context.obj({ Type: "Action", S: "JavaScript", JS: PDFString.of("app.alert('x')") }),
    );
    const result = await preflightPdf(await doc.save(), { maxSizeBytes: 10 * 1024 * 1024 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sanitizedBytes).toBeInstanceOf(Uint8Array);
    expect(findActiveContent(await PDFDocument.load(result.sanitizedBytes!))).toEqual([]);
  });

  it("accepts a valid PDF carrying a file attachment, handing back a sanitized copy without it", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    await doc.attach(new Uint8Array([1, 2, 3]), "payload.bin", { mimeType: "application/octet-stream" });
    const result = await preflightPdf(await doc.save(), { maxSizeBytes: 10 * 1024 * 1024 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pageCount).toBe(1);
    expect(findActiveContent(await PDFDocument.load(result.sanitizedBytes!))).toEqual([]);
  });

  it("gives no sanitizedBytes for a clean PDF", async () => {
    const result = await preflightPdf(await makeValidPdf(2), { maxSizeBytes: 10 * 1024 * 1024 });
    expect(result.ok && result.sanitizedBytes).toBeFalsy();
  });

  it("still rejects an encrypted PDF, in plain words", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    // pdf-lib cannot write encrypted files, so mark a plain one as encrypted in its trailer.
    const plain = Buffer.from(await doc.save({ useObjectStreams: false })).toString("latin1");
    const marked = plain.replace(/trailer\s*<</, "trailer << /Encrypt << /Filter /Standard /V 1 /R 2 >>");
    expect(marked).not.toBe(plain);
    const result = await preflightPdf(new Uint8Array(Buffer.from(marked, "latin1")), { maxSizeBytes: 10 * 1024 * 1024 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("This PDF is password-protected. Remove the password, or print it to a new PDF, and try again.");
  });

  it("never trusts a client-supplied page count - the returned count is always derived from the bytes", async () => {
    const bytes = await makeValidPdf(3);
    const result = await preflightPdf(bytes, { maxSizeBytes: 10 * 1024 * 1024 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pageCount).toBe(3); // not whatever a caller might have claimed
  });

  describe("printer control codes (PJL escape)", () => {
    const MSG = "This PDF contains printer control codes, so it can't be printed. Open it, choose Print, then Save as PDF, and upload that copy.";
    const uel = (s = "") => new TextEncoder().encode("\x1b%-12345X@PJL " + s);
    async function withTrailing(extra: Uint8Array, at: "end" | "middle"): Promise<Uint8Array> {
      const base = await makeValidPdf(2);
      const out = new Uint8Array(base.length + extra.length);
      if (at === "end") {
        out.set(base, 0);
        out.set(extra, base.length);
      } else {
        const cut = Math.floor(base.length / 2);
        out.set(base.subarray(0, cut), 0);
        out.set(extra, cut);
        out.set(base.subarray(cut), cut + extra.length);
      }
      return out;
    }

    it("rejects a PDF with the escape sequence after %%EOF, with the plain message", async () => {
      const result = await preflightPdf(await withTrailing(uel("INFO ID"), "end"), { maxSizeBytes: 10 * 1024 * 1024 });
      expect(result).toEqual({ ok: false, reason: MSG });
    });

    it("rejects it in the middle of the file and straight after the header", async () => {
      expect(await preflightPdf(await withTrailing(uel(), "middle"), { maxSizeBytes: 10 * 1024 * 1024 })).toEqual({ ok: false, reason: MSG });
      const base = await makeValidPdf(1);
      const head = new Uint8Array([...base.subarray(0, 5), ...uel(), ...base.subarray(5)]);
      expect(await preflightPdf(head, { maxSizeBytes: 10 * 1024 * 1024 })).toEqual({ ok: false, reason: MSG });
    });

    it("rejects a lowercase variant and ESC followed by @PJL", async () => {
      const lower = new TextEncoder().encode("\x1b%-12345x");
      expect(await preflightPdf(await withTrailing(lower, "end"), { maxSizeBytes: 10 * 1024 * 1024 })).toEqual({ ok: false, reason: MSG });
      const esc = new TextEncoder().encode("\x1b@PJL ECHO");
      expect(await preflightPdf(await withTrailing(esc, "end"), { maxSizeBytes: 10 * 1024 * 1024 })).toEqual({ ok: false, reason: MSG });
    });

    it("an attachment carrying it is compressed by pdf-lib (not raw bytes) and is stripped by the sanitizer, so the copy that prints is clean", async () => {
      const doc = await PDFDocument.create();
      doc.addPage([612, 792]);
      await doc.attach(uel("INFO ID"), "payload.bin", { mimeType: "application/octet-stream" });
      const result = await preflightPdf(await doc.save({ useObjectStreams: false }), { maxSizeBytes: 10 * 1024 * 1024 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.sanitizedBytes).toBeInstanceOf(Uint8Array);
        expect(containsPjlEscape(result.sanitizedBytes!)).toBe(false);
      }
    });

    it("leaves a clean PDF alone", async () => {
      expect((await preflightPdf(await makeValidPdf(2), { maxSizeBytes: 10 * 1024 * 1024 })).ok).toBe(true);
    });
  });

  describe("page-count cap", () => {
    it("rejects a PDF over the cap with a plain message", async () => {
      const result = await preflightPdf(await makeValidPdf(6), { maxSizeBytes: 10 * 1024 * 1024, maxPages: 5 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("This PDF has 6 pages, which is more than the 5-page limit. Split it into smaller files and upload them separately.");
    });
    it("accepts exactly the cap", async () => {
      expect((await preflightPdf(await makeValidPdf(5), { maxSizeBytes: 10 * 1024 * 1024, maxPages: 5 })).ok).toBe(true);
    });
    it("defaults to 500 pages", async () => {
      expect((await preflightPdf(await makeValidPdf(500), { maxSizeBytes: 50 * 1024 * 1024 })).ok).toBe(true);
      const r = await preflightPdf(await makeValidPdf(501), { maxSizeBytes: 50 * 1024 * 1024 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/501 pages.*500-page limit/);
    }, 30000);
  });
});
