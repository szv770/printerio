import { describe, expect, it } from "vitest";
import { buildShareRedirect, checkSharedFile, isValidShareId, shareNotice, sniffSharedType } from "./share";

const MB = 1024 * 1024;
const LIMIT = 50 * MB;

describe("checkSharedFile", () => {
  it("accepts a PDF by mime type", () => {
    expect(checkSharedFile({ name: "quiz.pdf", size: 1000, type: "application/pdf" }, LIMIT)).toEqual({ ok: true });
  });
  it("accepts a .pdf name when the mime type is missing or generic (Android often sends octet-stream)", () => {
    expect(checkSharedFile({ name: "Quiz.PDF", size: 1000, type: "" }, LIMIT)).toEqual({ ok: true });
    expect(checkSharedFile({ name: "quiz.pdf", size: 1000, type: "application/octet-stream" }, LIMIT)).toEqual({ ok: true });
  });
  it("accepts JPEG and PNG photos by mime type or name", () => {
    expect(checkSharedFile({ name: "a", size: 1000, type: "image/jpeg" }, LIMIT)).toEqual({ ok: true });
    expect(checkSharedFile({ name: "a", size: 1000, type: "image/png" }, LIMIT)).toEqual({ ok: true });
    for (const n of ["a.jpg", "A.JPEG", "a.png"]) expect(checkSharedFile({ name: n, size: 1000, type: "" }, LIMIT)).toEqual({ ok: true });
  });
  it("rejects other types", () => {
    expect(checkSharedFile({ name: "photo.gif", size: 1000, type: "image/gif" }, LIMIT)).toEqual({ ok: false, reason: "notpdf" });
    expect(checkSharedFile({ name: "photo.heic", size: 1000, type: "image/heic" }, LIMIT)).toEqual({ ok: false, reason: "notpdf" });
    expect(checkSharedFile({ name: "notes.docx", size: 1000, type: "" }, LIMIT)).toEqual({ ok: false, reason: "notpdf" });
    expect(checkSharedFile({ name: "pdf", size: 1000, type: "text/plain" }, LIMIT)).toEqual({ ok: false, reason: "notpdf" });
  });
  it("rejects an empty file", () => {
    expect(checkSharedFile({ name: "a.pdf", size: 0, type: "application/pdf" }, LIMIT)).toEqual({ ok: false, reason: "empty" });
  });
  it("allows exactly the limit and rejects one byte more", () => {
    expect(checkSharedFile({ name: "a.pdf", size: LIMIT, type: "application/pdf" }, LIMIT)).toEqual({ ok: true });
    expect(checkSharedFile({ name: "a.pdf", size: LIMIT + 1, type: "application/pdf" }, LIMIT)).toEqual({ ok: false, reason: "toolarge" });
  });
  it("reports the type problem before the size problem", () => {
    expect(checkSharedFile({ name: "a.mov", size: LIMIT * 2, type: "video/mp4" }, LIMIT)).toEqual({ ok: false, reason: "notpdf" });
  });
});

describe("sniffSharedType", () => {
  it("recognises PDF, JPEG and PNG by their first bytes", () => {
    expect(sniffSharedType(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]))).toBe("application/pdf");
    expect(sniffSharedType(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0]))).toBe("image/jpeg");
    expect(sniffSharedType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
  });
  it("refuses everything else, including too-short and near-miss headers", () => {
    expect(sniffSharedType(new Uint8Array([]))).toBeNull();
    expect(sniffSharedType(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeNull(); // "%PDF" without "-"
    expect(sniffSharedType(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(sniffSharedType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a]))).toBeNull();
    expect(sniffSharedType(new TextEncoder().encode("GIF89a...."))).toBeNull();
    expect(sniffSharedType(new TextEncoder().encode("MZ\x90\x00"))).toBeNull();
  });
});

describe("buildShareRedirect", () => {
  it("sends a stored file to the print page by id", () => {
    expect(buildShareRedirect({ ok: true, id: "abc-123" })).toBe("/print?shared=abc-123");
  });
  it("sends a problem to the print page by reason", () => {
    expect(buildShareRedirect({ ok: false, reason: "toolarge" })).toBe("/print?share=toolarge");
    expect(buildShareRedirect({ ok: false, reason: "notpdf" })).toBe("/print?share=notpdf");
    expect(buildShareRedirect({ ok: false, reason: "notready" })).toBe("/print?share=notready");
  });
  it("never lets an odd id break out of the query string", () => {
    expect(buildShareRedirect({ ok: true, id: "a&b=c d" })).toBe("/print?shared=a%26b%3Dc%20d");
  });
});

describe("isValidShareId", () => {
  it("accepts uuid-like ids only", () => {
    expect(isValidShareId("3f2b8c1e-5a77-4d3e-9a10-0b6f1c2d3e4f")).toBe(true);
    expect(isValidShareId("")).toBe(false);
    expect(isValidShareId("../x")).toBe(false);
    expect(isValidShareId("a".repeat(65))).toBe(false);
  });
});

describe("shareNotice", () => {
  it("explains each problem in plain words", () => {
    expect(shareNotice("toolarge", 50 * MB)).toBe("That file is too big to share into Printio (limit 50 MB). Choose it on this page instead.");
    expect(shareNotice("notpdf", LIMIT)).toBe("Printio can print PDFs and photos (JPEG or PNG). For anything else, open it and choose Print > Save as PDF first.");
    expect(shareNotice("notready", LIMIT)).toBe("Open Printio once, then share again.");
    expect(shareNotice("empty", LIMIT)).toMatch(/empty/i);
    expect(shareNotice("many", LIMIT)).toMatch(/one file/i);
  });
  it("returns null for unknown codes", () => {
    expect(shareNotice("whatever", LIMIT)).toBeNull();
    expect(shareNotice(null, LIMIT)).toBeNull();
  });
});
