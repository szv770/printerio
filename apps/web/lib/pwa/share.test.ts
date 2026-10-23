import { describe, expect, it } from "vitest";
import { buildShareRedirect, checkSharedFile, isValidShareId, shareNotice } from "./share";

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
  it("rejects anything that is neither a PDF type nor a .pdf name", () => {
    expect(checkSharedFile({ name: "photo.jpg", size: 1000, type: "image/jpeg" }, LIMIT)).toEqual({ ok: false, reason: "notpdf" });
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
    expect(shareNotice("notpdf", LIMIT)).toBe("Printio only prints PDFs. Open it and choose Print > Save as PDF first.");
    expect(shareNotice("notready", LIMIT)).toBe("Open Printio once, then share again.");
    expect(shareNotice("empty", LIMIT)).toMatch(/empty/i);
    expect(shareNotice("many", LIMIT)).toMatch(/one PDF/i);
  });
  it("returns null for unknown codes", () => {
    expect(shareNotice("whatever", LIMIT)).toBeNull();
    expect(shareNotice(null, LIMIT)).toBeNull();
  });
});
