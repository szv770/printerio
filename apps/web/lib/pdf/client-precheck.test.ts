import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  formatFileSize,
  precheckPdfHeader,
  precheckSelectedFile,
} from "./client-precheck";

const MB = 1024 * 1024;

function pdf(overrides: Partial<{ name: string; size: number; type: string }> = {}) {
  return { name: "essay.pdf", size: 2 * MB, type: "application/pdf", ...overrides };
}

describe("precheckSelectedFile", () => {
  it("accepts an ordinary PDF within the limit", () => {
    expect(precheckSelectedFile(pdf(), DEFAULT_MAX_UPLOAD_BYTES)).toEqual({ ok: true });
  });

  it("rejects an empty file", () => {
    const result = precheckSelectedFile(pdf({ size: 0 }), DEFAULT_MAX_UPLOAD_BYTES);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/empty/i);
  });

  it("rejects a file over the organization's limit, naming both the size and the limit", () => {
    const result = precheckSelectedFile(pdf({ size: 90 * MB }), 50 * MB);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("90.0 MB");
      expect(result.reason).toContain("50 MB");
    }
  });

  it("accepts a file exactly at the limit (the server's own check is `>`, not `>=`)", () => {
    expect(precheckSelectedFile(pdf({ size: 50 * MB }), 50 * MB)).toEqual({ ok: true });
  });

  it("rejects an obviously non-PDF MIME type", () => {
    const result = precheckSelectedFile(
      pdf({ name: "report.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
      DEFAULT_MAX_UPLOAD_BYTES,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/only pdf/i);
  });

  it("accepts a .pdf whose MIME type the browser reported as empty (common on ChromeOS/Android)", () => {
    expect(precheckSelectedFile(pdf({ type: "" }), DEFAULT_MAX_UPLOAD_BYTES)).toEqual({ ok: true });
  });

  it("accepts a .pdf extension even when the reported MIME type is a wrong-but-plausible one", () => {
    expect(precheckSelectedFile(pdf({ name: "Scan.PDF", type: "application/octet-stream" }), DEFAULT_MAX_UPLOAD_BYTES)).toEqual({
      ok: true,
    });
  });

  it("checks size before type, so an oversized file is never mislabelled as the wrong format", () => {
    const result = precheckSelectedFile(pdf({ name: "huge.docx", type: "text/plain", size: 80 * MB }), 50 * MB);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/limit here is/i);
  });
});

describe("precheckPdfHeader", () => {
  it("accepts real PDF magic bytes", () => {
    expect(precheckPdfHeader(new TextEncoder().encode("%PDF-1.7\n..."))).toEqual({ ok: true });
  });

  it("rejects a renamed non-PDF regardless of its filename", () => {
    const result = precheckPdfHeader(new TextEncoder().encode("PKzip-not-a-pdf"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/isn't a pdf/i);
  });

  it("rejects a file too short to carry a header at all", () => {
    expect(precheckPdfHeader(new Uint8Array([0x25, 0x50])).ok).toBe(false);
  });

  it("uses the same %PDF- test the authoritative server preflight uses", () => {
    // Guards against these two drifting apart: a file the client waves
    // through must still be one the server would have accepted on this check.
    expect(precheckPdfHeader(new TextEncoder().encode("%PDF-")).ok).toBe(true);
    expect(precheckPdfHeader(new TextEncoder().encode("%PDF")).ok).toBe(false);
  });
});

describe("formatFileSize", () => {
  it("formats megabytes to one decimal place", () => {
    expect(formatFileSize(2 * MB)).toBe("2.0 MB");
    expect(formatFileSize(Math.round(4.25 * MB))).toBe("4.3 MB");
  });

  it("formats sub-megabyte sizes in kilobytes", () => {
    expect(formatFileSize(512 * 1024)).toBe("512 KB");
    expect(formatFileSize(2048)).toBe("2.0 KB");
  });

  it("returns an empty string rather than nonsense for an unusable size", () => {
    expect(formatFileSize(Number.NaN)).toBe("");
    expect(formatFileSize(-1)).toBe("");
  });
});
