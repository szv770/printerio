import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { checkPdfInflation } from "./inflate-guard";

/** A PDF-shaped file with one compressed stream whose dictionary says what kind of stream it is. */
function withStream(dict: string, data: Buffer): Uint8Array {
  const head = Buffer.from(`%PDF-1.7\n1 0 obj\n<< ${dict} /Filter /FlateDecode /Length ${data.length} >>\nstream\n`, "latin1");
  const tail = Buffer.from("\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1");
  return Buffer.concat([head, data, tail]);
}

const SMALL = { maxStreamBytes: 1024 * 1024, maxTotalBytes: 2 * 1024 * 1024 };

describe("checkPdfInflation", () => {
  it("lets an ordinary PDF through", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    expect(checkPdfInflation(await doc.save({ useObjectStreams: true }))).toEqual({ ok: true });
  });

  it("refuses an object stream that is tiny on disk but huge once expanded (a decompression bomb)", () => {
    const bomb = deflateSync(Buffer.alloc(8 * 1024 * 1024)); // 8 MB of zeros compresses to about 8 KB
    expect(bomb.length).toBeLessThan(20_000);
    const res = checkPdfInflation(withStream("/Type /ObjStm /N 1 /First 5", bomb), SMALL);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.reason).toMatch(/too large when opened/i);
  });

  it("also catches a bomb whose type is written with a hex escape, and a cross-reference stream", () => {
    const bomb = deflateSync(Buffer.alloc(8 * 1024 * 1024));
    expect(checkPdfInflation(withStream("/Type /Obj#53tm", bomb), SMALL).ok).toBe(false);
    expect(checkPdfInflation(withStream("/Type /XRef", bomb), SMALL).ok).toBe(false);
  });

  it("refuses many moderately large object streams that add up past the total allowance", () => {
    const one = deflateSync(Buffer.alloc(600 * 1024));
    const file = Buffer.concat([1, 2, 3, 4].map(() => Buffer.from(withStream("/Type /ObjStm", one))));
    expect(checkPdfInflation(file, SMALL).ok).toBe(false);
  });

  it("leaves image and content streams alone (they are not expanded while opening)", () => {
    const big = deflateSync(Buffer.alloc(8 * 1024 * 1024));
    expect(checkPdfInflation(withStream("/Type /XObject /Subtype /Image", big), SMALL)).toEqual({ ok: true });
  });

  it("does not choke on garbage, truncated streams or a stream that is not compressed data", () => {
    expect(checkPdfInflation(Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /ObjStm >>\nstream\nnot compressed at all\nendstream\n"), SMALL)).toEqual({ ok: true });
    expect(checkPdfInflation(Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /ObjStm >>\nstream\n"), SMALL)).toEqual({ ok: true });
    expect(checkPdfInflation(new Uint8Array(0), SMALL)).toEqual({ ok: true });
  });
});
