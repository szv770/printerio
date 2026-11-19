import { describe, expect, it } from "vitest";
import {
  detectUploadKind,
  isImageKind,
  precheckUploadHeader,
  CLIENT_PREVIEW_MAX_BYTES,
  DEFAULT_MAX_UPLOAD_BYTES,
  formatFileSize,
  precheckPdfHeader,
  precheckSelectedFile,
  shouldPreviewInBrowser,
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

  it("formats multi-gigabyte totals in gigabytes (the admin storage page adds many files up)", () => {
    expect(formatFileSize(3 * 1024 * MB)).toBe("3.0 GB");
    expect(formatFileSize(1536 * MB)).toBe("1.5 GB");
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

describe("shouldPreviewInBrowser", () => {
  it("previews an ordinary document", () => {
    expect(shouldPreviewInBrowser(2 * MB)).toBe(true);
  });

  it("previews right up to the threshold", () => {
    expect(shouldPreviewInBrowser(CLIENT_PREVIEW_MAX_BYTES)).toBe(true);
  });

  it("skips a large scan - the parse+render is what kills a phone tab, not the upload", () => {
    expect(shouldPreviewInBrowser(CLIENT_PREVIEW_MAX_BYTES + 1)).toBe(false);
    expect(shouldPreviewInBrowser(45 * MB)).toBe(false);
  });

  it("skips a zero-length or nonsense size rather than trying to parse it", () => {
    expect(shouldPreviewInBrowser(0)).toBe(false);
    expect(shouldPreviewInBrowser(Number.NaN)).toBe(false);
  });
});

describe("photos (JPEG / PNG) next to PDFs", () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const PDF = new TextEncoder().encode("%PDF-1.7");

  it("accepts a JPEG or PNG by name or type, within the same size limit", () => {
    expect(precheckSelectedFile({ name: "photo.JPG", size: 2 * MB, type: "image/jpeg" }, DEFAULT_MAX_UPLOAD_BYTES)).toEqual({ ok: true });
    expect(precheckSelectedFile({ name: "scan.png", size: 2 * MB, type: "image/png" }, DEFAULT_MAX_UPLOAD_BYTES)).toEqual({ ok: true });
    expect(precheckSelectedFile({ name: "photo.jpeg", size: 90 * MB, type: "image/jpeg" }, 50 * MB).ok).toBe(false);
    expect(precheckSelectedFile({ name: "pic.gif", size: MB, type: "image/gif" }, DEFAULT_MAX_UPLOAD_BYTES).ok).toBe(false);
  });

  it("decides by magic bytes, whatever the name or MIME type says (a shared file arrives typed application/pdf)", () => {
    expect(detectUploadKind(PDF)).toBe("pdf");
    expect(detectUploadKind(JPEG)).toBe("jpeg");
    expect(detectUploadKind(PNG)).toBe("png");
    expect(detectUploadKind(new TextEncoder().encode("PK\u0003\u0004zip"))).toBeNull();
    expect(precheckUploadHeader(JPEG)).toEqual({ ok: true, kind: "jpeg" });
    const bad = precheckUploadHeader(new Uint8Array([1, 2, 3, 4, 5]));
    expect(bad.ok).toBe(false);
  });

  it("a shared photo goes through the same checks as a picked one: the handoff's forced PDF type changes nothing", () => {
    // SharedFileHandoff builds File(blob, name, { type: "application/pdf" }) and fires the input's change event.
    expect(precheckSelectedFile({ name: "IMG_1.jpg", size: MB, type: "application/pdf" }, DEFAULT_MAX_UPLOAD_BYTES)).toEqual({ ok: true });
    const kind = precheckUploadHeader(JPEG);
    expect(kind.ok && isImageKind(kind.kind)).toBe(true);
  });
});
