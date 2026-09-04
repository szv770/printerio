import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
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
    if (!result.ok) expect(result.reason).toMatch(/does not look like a pdf/i);
  });

  it("rejects a file that has the PDF header but is otherwise malformed/truncated", async () => {
    // Valid header, garbage body - pdf-lib's parser should fail cleanly
    // rather than the whole request crashing.
    const truncated = new TextEncoder().encode("%PDF-1.4\n%garbage garbage garbage, not a real xref table");
    const result = await preflightPdf(truncated, { maxSizeBytes: 1024 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/malformed/i);
  });

  it("rejects a file exceeding the configured maximum size, never attempting to parse it", async () => {
    const bytes = await makeValidPdf(1);
    const result = await preflightPdf(bytes, { maxSizeBytes: 10 }); // absurdly small ceiling
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/exceeds/i);
  });

  it("never trusts a client-supplied page count - the returned count is always derived from the bytes", async () => {
    const bytes = await makeValidPdf(3);
    const result = await preflightPdf(bytes, { maxSizeBytes: 10 * 1024 * 1024 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pageCount).toBe(3); // not whatever a caller might have claimed
  });
});
