import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dailyFeedUrl, parseDailyFeed, formatFeedDate } from "./feed";

const xml = readFileSync(join(__dirname, "fixtures", "dailystudy-rss-2026-11-01.xml"), "utf8");

describe("parseDailyFeed", () => {
  const day = parseDailyFeed(xml);
  it("reads the date and the Hebrew date from the feed title", () => {
    expect(day.date).toBe("2026-11-01");
    expect(day.hebrewDate).toBe("Cheshvan 21, 5787");
  });
  it("finds the four studies the library offers, with their portion text", () => {
    const by = Object.fromEntries(day.items.map((i) => [i.study, i]));
    expect(by.chumash?.portion).toBe("Parshat Chayei Sarah, 1st Portion (Bereshit (Genesis) 23:1-23:16) with Rashi");
    expect(by.tanya?.portion).toBe("Iggeret HaKodesh, middle of Epistle 29");
    expect(by.rambam1?.portion).toBe("Issurei Biah - Chapter 13");
    expect(by.rambam3?.portion).toBe("Mechirah - Chapter 28, Mechirah - Chapter 29, Mechirah - Chapter 30");
  });
  it("decodes entities in urls and text", () => {
    const rambam = day.items.find((i) => i.study === "rambam3");
    expect(rambam?.url).toBe("https://www.chabad.org/dailystudy/rambam.asp?tdate=11/1/2026&rambamChapters=3");
  });
  it("keeps only chabad.org https links and drops anything else", () => {
    const evil = xml.replaceAll("https://www.chabad.org/dailystudy/tanya.asp", "https://evil.example/dailystudy/tanya.asp");
    expect(parseDailyFeed(evil).items.find((i) => i.study === "tanya")).toBeUndefined();
  });
  it("never uses a mode parameter (robots.txt disallows it)", () => {
    expect(day.items.every((i) => !/mode/i.test(i.url))).toBe(true);
  });
  it("throws on a page that is not the feed (for example the Cloudflare check)", () => {
    expect(() => parseDailyFeed("<html><title>Just a moment...</title></html>")).toThrow(/feed/i);
  });
});

describe("feed urls", () => {
  it("formats a date the way the feed wants it and builds the url", () => {
    expect(formatFeedDate("2026-11-08")).toBe("11/8/2026");
    expect(dailyFeedUrl("2026-11-08")).toBe("https://www.chabad.org/tools/rss/dailystudy_rss.xml?tdate=11/8/2026");
    expect(dailyFeedUrl()).toBe("https://www.chabad.org/tools/rss/dailystudy_rss.xml");
  });
  it("rejects a bad date", () => {
    expect(() => formatFeedDate("11/8/2026")).toThrow();
  });
});
