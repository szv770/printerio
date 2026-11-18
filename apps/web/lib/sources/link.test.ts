import { describe, expect, it } from "vitest";
import { normalizeSourceLink } from "./link";

const ok = (input: string) => {
  const r = normalizeSourceLink(input);
  if (!r.ok) throw new Error(`expected ok for ${input}: ${r.message}`);
  return r;
};

describe("Google Drive links all become one direct-download address", () => {
  const ID = "1Q6o-wEkpAsvRQIaJqSqcCOkBZhQAAdYI";
  const want = `https://drive.usercontent.google.com/download?id=${ID}&export=download&confirm=t`;
  it.each([
    `https://drive.google.com/file/d/${ID}/view?usp=sharing`,
    `https://drive.google.com/file/d/${ID}/view?usp=drivesdk`,
    `https://drive.google.com/file/d/${ID}/edit`,
    `https://drive.google.com/open?id=${ID}`,
    `https://drive.google.com/uc?id=${ID}&export=download`,
    `https://drive.google.com/uc?export=download&id=${ID}`,
    `https://drive.usercontent.google.com/download?id=${ID}&export=download`,
    `  https://drive.google.com/file/d/${ID}/view  `,
    `drive.google.com/file/d/${ID}/view`,
  ])("%s", (input) => {
    const r = ok(input);
    expect(r.url.toString()).toBe(want);
    expect(r.kind).toBe("drive");
  });

  it("works when the link is inside a pasted message", () => {
    expect(ok(`Here it is: https://drive.google.com/file/d/${ID}/view?usp=sharing thanks!`).url.toString()).toBe(want);
  });

  it("keeps a resource key (older shared files need it)", () => {
    const r = ok(`https://drive.google.com/file/d/${ID}/view?usp=drive_link&resourcekey=0-Z87Erti6MoyLG97S_Fmt5A`);
    expect(r.url.searchParams.get("resourcekey")).toBe("0-Z87Erti6MoyLG97S_Fmt5A");
  });

  it("refuses a Drive FOLDER with a message that says what to do", () => {
    const r = normalizeSourceLink("https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/folder/i);
  });

  it("explains Google's temporary viewer address instead of fetching it", () => {
    const r = normalizeSourceLink("https://doc-0g-0s-apps-viewer.googleusercontent.com/viewer/secure/pdf/abc/def/1792990500000/drive/066/ACF?authuser=0&print=true");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/temporary viewer address.*Anyone with the link/i);
  });
});

describe("Google Docs and Slides export as PDF", () => {
  it("document link becomes a PDF export", () => {
    const r = ok("https://docs.google.com/document/d/0B_WSU737WJ1fMmZHRGdZdlpyMm8/edit?resourcekey=0-_9-vGCV4kE0OgeUqM4qVZg");
    expect(r.kind).toBe("docs");
    expect(r.url.toString()).toBe("https://docs.google.com/document/d/0B_WSU737WJ1fMmZHRGdZdlpyMm8/export?format=pdf&resourcekey=0-_9-vGCV4kE0OgeUqM4qVZg");
  });
  it("keeps the resource key on the export (legacy shared documents need it)", () => {
    const doc = ok("https://docs.google.com/document/d/0B_WSU737WJ1fMmZHRGdZdlpyMm8/edit?resourcekey=0-_9-vGCV4kE0OgeUqM4qVZg");
    expect(doc.url.searchParams.get("resourcekey")).toBe("0-_9-vGCV4kE0OgeUqM4qVZg");
    expect(doc.url.searchParams.get("format")).toBe("pdf");
    const slides = ok("https://docs.google.com/presentation/d/1abcDEF_ghi-JKL/edit?resourcekey=0-abc_DEF");
    expect(slides.url.searchParams.get("resourcekey")).toBe("0-abc_DEF");
  });
  it("presentation link becomes a PDF export", () => {
    const r = ok("https://docs.google.com/presentation/d/1abcDEF_ghi-JKL/edit#slide=id.p");
    expect(r.url.toString()).toBe("https://docs.google.com/presentation/d/1abcDEF_ghi-JKL/export/pdf");
  });
});

describe("any other https link is used as it is", () => {
  it("keeps the address and calls it direct", () => {
    const r = ok("https://www.hebrewbooks.org/pdfpager.aspx?req=14391&pgnum=5");
    expect(r.kind).toBe("direct");
    expect(r.url.toString()).toBe("https://www.hebrewbooks.org/pdfpager.aspx?req=14391&pgnum=5");
  });
  it("adds https when it is missing", () => {
    expect(ok("example.org/files/booklet.pdf").url.toString()).toBe("https://example.org/files/booklet.pdf");
  });
});

describe("refused, with a plain reason", () => {
  const bad: Array<[string, RegExp]> = [
    ["", /paste a link/i],
    ["hello there", /link/i],
    ["http://example.org/a.pdf", /https/i],
    ["ftp://example.org/a.pdf", /https/i],
    ["javascript:alert(1)", /link|https/i],
    ["file:///C:/secret.pdf", /https/i],
    ["https://user:pass@example.org/a.pdf", /sign-in|password|login/i],
    ["https://example.org:8443/a.pdf", /port|address/i],
    ["https://127.0.0.1/a.pdf", /address/i],
    ["https://localhost/a.pdf", /address/i],
    ["https://printer.local/a.pdf", /address/i],
    ["https://[::1]/a.pdf", /address/i],
    ["https://169.254.169.254/latest/meta-data", /address/i],
  ];
  it.each(bad)("%s", (input, why) => {
    const r = normalizeSourceLink(input);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(why);
  });
  it("refuses very long input", () => {
    expect(normalizeSourceLink(`https://example.org/${"a".repeat(5000)}`).ok).toBe(false);
  });
});
