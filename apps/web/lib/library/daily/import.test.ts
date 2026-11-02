import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDailyFeed } from "./feed";
import { detectStudy, prepareImport } from "./import";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");
const day = parseDailyFeed(fixture("dailystudy-rss-2026-11-01.xml"));

describe("detectStudy", () => {
  it("tells the four studies apart by the page's own heading", () => {
    expect(detectStudy(fixture("study-tanya.html"))).toBe("tanya");
    expect(detectStudy(fixture("study-chumash.html"))).toBe("chumash");
    expect(detectStudy(fixture("study-rambam1.html"))).toBe("rambam1");
    expect(detectStudy(fixture("study-rambam3.html"))).toBe("rambam3");
  });
  it("returns null for any other page", () => {
    expect(detectStudy("<html><body><h1>Something else</h1></body></html>")).toBeNull();
  });
});

describe("prepareImport", () => {
  it("makes a row for each study when the page matches that day's feed", () => {
    for (const [file, study] of [["study-tanya.html", "tanya"], ["study-chumash.html", "chumash"], ["study-rambam1.html", "rambam1"], ["study-rambam3.html", "rambam3"]] as const) {
      const r = prepareImport(fixture(file), day);
      expect(r.ok, `${study}: ${r.ok ? "" : r.message}`).toBe(true);
      if (r.ok) {
        expect(r.row.study).toBe(study);
        expect(r.row.study_date).toBe("2026-11-01");
        expect(r.row.source_url).toMatch(/^https:\/\/www\.chabad\.org\/dailystudy\//);
        expect(r.row.sections.length).toBeGreaterThan(0);
      }
    }
  });
  it("refuses a page from a different day than the chosen date", () => {
    const other = fixture("study-tanya.html").replace("Iggeret HaKodesh, middle of Epistle 29", "Likkutei Amarim, Chapter 5");
    const r = prepareImport(other, day);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/different day/i);
  });
  it("refuses Cloudflare's check page and tells the person to open the page themselves", () => {
    const r = prepareImport("<html><head><title>Just a moment...</title></head></html>", day);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/check/i);
  });
  it("refuses a page that is not one of the studies", () => {
    const r = prepareImport("<html><body><h1>Hello</h1></body></html>", day);
    expect(r.ok).toBe(false);
  });
  it("refuses a study page with no readable text", () => {
    const r = prepareImport("<html><body><h1>Daily Tanya</h1><h2>Iggeret HaKodesh, middle of Epistle 29</h2></body></html>", day);
    expect(r.ok).toBe(false);
  });
});
