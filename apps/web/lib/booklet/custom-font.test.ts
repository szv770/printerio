import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fakeSupabase, failure, ok } from "@/test/fake-supabase";
import { DAVID_LIBRE_BOLD_BASE64 } from "./fonts/david-libre-bold";
import { EZRA_SIL_REGULAR_BASE64 } from "./fonts/ezra-sil-regular";
import { DAVID_LIBRE_REGULAR_BASE64 } from "./fonts/david-libre-regular";
import { MAX_FONT_BYTES, fontDisplayName, hebrewCoverage, inspectFont, loadOrgFontBytes, sanitizeFontName } from "./custom-font";

const bytesOf = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));
const ezra = bytesOf(EZRA_SIL_REGULAR_BASE64);
const david = bytesOf(DAVID_LIBRE_REGULAR_BASE64);

describe("inspectFont", () => {
  it("accepts Ezra SIL and reports vowels and cantillation marks", () => {
    expect(inspectFont(ezra)).toEqual({ ok: true, name: "Ezra SIL", hasHebrew: true, hasVowels: true, hasCantillation: true });
  });

  it("accepts David Libre: vowels but no cantillation marks", () => {
    expect(inspectFont(david)).toEqual({ ok: true, name: "David Libre", hasHebrew: true, hasVowels: true, hasCantillation: false });
  });

  it("rejects a real font that has no Hebrew letters", () => {
    // Liberation Sans ships with pdfjs-dist (a Latin/Greek/Cyrillic font): a genuine TrueType file with no Hebrew.
    const pdfjsDir = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
    const latin = new Uint8Array(readFileSync(path.join(pdfjsDir, "standard_fonts", "LiberationSans-Regular.ttf")));
    const r = inspectFont(latin);
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/no Hebrew letters/i) });
  });

  it("uses the file name (without extension) when the font has no family name", () => {
    expect(sanitizeFontName("", "My Font.ttf")).toBe("My Font");
    expect(sanitizeFontName(null, "")).toBe("Uploaded font");
  });

  it("cleans a display name: control characters out, trimmed, at most 80 characters", () => {
    expect(sanitizeFontName("  SBL\u0000 Hebrew\n\u202e ")).toBe("SBL Hebrew");
    expect(sanitizeFontName("x".repeat(200))).toHaveLength(80);
  });

  it("gives Regular and Bold of one family different names, so both can be uploaded", () => {
    const regular = inspectFont(david);
    const bold = inspectFont(bytesOf(DAVID_LIBRE_BOLD_BASE64));
    expect(regular.ok && bold.ok).toBe(true);
    if (regular.ok && bold.ok) {
      expect(regular.name).toBe("David Libre");
      expect(bold.name).toBe("David Libre Bold");
    }
  });

  it("adds a non-Regular subfamily to the family name, but not twice", () => {
    expect(fontDisplayName({ familyName: "OT Siddur Classic", subfamilyName: "Regular" })).toBe("OT Siddur Classic");
    expect(fontDisplayName({ familyName: "OT Sid Daled", subfamilyName: "Bold" })).toBe("OT Sid Daled Bold");
    expect(fontDisplayName({ familyName: "OT Sid Daled Bold", subfamilyName: "Bold" })).toBe("OT Sid Daled Bold");
    expect(fontDisplayName({ familyName: "SBL Hebrew", subfamilyName: null })).toBe("SBL Hebrew");
    expect(fontDisplayName({ familyName: null, subfamilyName: "Bold", fullName: "Some Font Bold" })).toBe("Some Font Bold");
    expect(fontDisplayName({}, "file name.otf")).toBe("file name");
  });

  it("counts vowels as covered without U+05BA (holam haser for vav), but not without another vowel", () => {
    const letters = Array.from({ length: 0x05ea - 0x05d0 + 1 }, (_, i) => 0x05d0 + i);
    const vowels = Array.from({ length: 0x05bc - 0x05b0 + 1 }, (_, i) => 0x05b0 + i);
    const cover = (cps: number[]) => hebrewCoverage((cp) => cps.includes(cp));
    expect(cover([...letters, ...vowels.filter((c) => c !== 0x05ba)]).hasVowels).toBe(true);
    expect(cover([...letters, ...vowels]).hasVowels).toBe(true);
    expect(cover([...letters, ...vowels.filter((c) => c !== 0x05b8)]).hasVowels).toBe(false);
    expect(cover([...letters, ...vowels.filter((c) => c !== 0x05bc)]).hasVowels).toBe(false);
    expect(cover(letters).hasVowels).toBe(false);
  });

  it("rejects garbage bytes in plain language", () => {
    const r = inspectFont(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/\.ttf or \.otf/i);
  });

  it("rejects an empty file", () => {
    expect(inspectFont(new Uint8Array(0)).ok).toBe(false);
  });

  it("rejects a truncated font", () => {
    for (const cut of [3000, Math.floor(ezra.length / 2), ezra.length - 200]) {
      const r = inspectFont(ezra.slice(0, cut));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/damaged|cut off|incomplete|read/i);
    }
  });

  it("rejects a WOFF or WOFF2 file and says to upload the .ttf or .otf", () => {
    for (const magic of ["wOFF", "wOF2"]) {
      const woff = new Uint8Array(200);
      woff.set(new TextEncoder().encode(magic));
      const r = inspectFont(woff);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/WOFF/);
      if (!r.ok) expect(r.message).toMatch(/\.ttf or \.otf/);
    }
  });

  it("rejects a .ttc font collection", () => {
    const ttc = new Uint8Array(200);
    ttc.set(new TextEncoder().encode("ttcf"));
    const r = inspectFont(ttc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/collection/i);
  });

  it("rejects an oversized file before parsing it", () => {
    const big = new Uint8Array(MAX_FONT_BYTES + 1);
    big.set(ezra);
    const r = inspectFont(big);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/8 MB/);
  });

  it("accepts a file exactly at the size limit boundary check (limit is inclusive)", () => {
    expect(MAX_FONT_BYTES).toBe(8 * 1024 * 1024);
    const r = inspectFont(ezra);
    expect(r.ok).toBe(true);
  });
});

describe("loadOrgFontBytes", () => {
  const row = { name: "Ezra SIL", storage_path: "org/org1/f1.font", organization_id: "org1" };

  it("reads the row for this organization and downloads the bytes from the org-fonts bucket", async () => {
    const fake = fakeSupabase((call) => {
      if (call.table === "org_fonts") return ok(row);
      if (call.op === "download") return ok(new Blob([ezra]));
      return ok();
    });
    const out = await loadOrgFontBytes(fake.client as never, "org1", "f1");
    expect(out?.name).toBe("Ezra SIL");
    expect(out?.bytes.length).toBe(ezra.length);
    const select = fake.calls.find((c) => c.table === "org_fonts")!;
    expect(select.filters).toContainEqual(["eq", "id", "f1"]);
    expect(select.filters).toContainEqual(["eq", "organization_id", "org1"]);
    const dl = fake.calls.find((c) => c.op === "download")!;
    expect(dl.table).toBe("storage:org-fonts");
    expect(dl.values).toBe("org/org1/f1.font");
  });

  it("returns null when the row is missing, belongs to another organization, or has no file", async () => {
    const none = fakeSupabase(() => ok(null));
    expect(await loadOrgFontBytes(none.client as never, "org1", "f1")).toBeNull();
    const other = fakeSupabase(() => ok({ ...row, organization_id: "org2" }));
    expect(await loadOrgFontBytes(other.client as never, "org1", "f1")).toBeNull();
    expect(other.calls.some((c) => c.op === "download")).toBe(false);
    const noPath = fakeSupabase(() => ok({ ...row, storage_path: null }));
    expect(await loadOrgFontBytes(noPath.client as never, "org1", "f1")).toBeNull();
  });

  it("returns null when the download fails", async () => {
    const fake = fakeSupabase((call) => (call.op === "download" ? failure("gone") : ok(row)));
    expect(await loadOrgFontBytes(fake.client as never, "org1", "f1")).toBeNull();
  });
});
