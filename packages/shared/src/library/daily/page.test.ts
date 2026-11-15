import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isCheckPage, parseStudyPage } from "./page";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");
/** Hebrew letters only (no vowel or cantillation marks), so the test does not depend on how marks are ordered. */
const bare = (s: string | undefined) => (s ?? "").replace(/[֑-ׇ]/g, "");
const allText = (p: ReturnType<typeof parseStudyPage>) => p.sections.flatMap((s) => s.blocks).map((b) => `${b.he} ${b.en}`).join(" ");

describe("Chumash with Rashi", () => {
  const p = parseStudyPage(fixture("study-chumash.html"), "chumash");
  it("reads the portion and the chapter heading", () => {
    expect(p.portion).toBe("Parshat Chayei Sarah, 1st Portion (Bereshit (Genesis) 23:1-23:16)");
    expect(p.sections[0]?.heading).toBe("Bereshit (Genesis) Chapter 23");
  });
  it("gives each verse in Hebrew and English with its number, then Rashi on it", () => {
    const [v1, r1] = p.sections[0]?.blocks ?? [];
    expect(v1).toMatchObject({ kind: "verse", num: "1" });
    expect(v1?.en).toMatch(/^And the life of Sarah was one hundred years/);
    expect(bare(v1?.he)).toMatch(/^ויהיו חיי שרה/);
    expect(r1?.kind).toBe("rashi");
    expect(r1?.leadEn).toMatch(/^And the life of Sarah/);
    expect(r1?.en).toMatch(/every digit is to be expounded/);
    expect(r1?.he.length).toBeGreaterThan(10);
  });
});

describe("Tanya", () => {
  const p = parseStudyPage(fixture("study-tanya.html"), "tanya");
  it("reads the lesson and has Hebrew text", () => {
    expect(p.portion).toBe("Iggeret HaKodesh, middle of Epistle 29");
    expect(p.sections.flatMap((s) => s.blocks).length).toBeGreaterThan(0);
    expect(allText(p)).toMatch(/[א-ת]/);
  });
  it("leaves out footnotes", () => {
    expect(allText(p)).not.toMatch(/footnote/i);
  });
});

describe("Rambam", () => {
  const one = parseStudyPage(fixture("study-rambam1.html"), "rambam1");
  const three = parseStudyPage(fixture("study-rambam3.html"), "rambam3");
  it("reads a verse without its footnote number and keeps the Hebrew", () => {
    const first = one.sections[0]?.blocks[0];
    expect(first?.num).toBe("1");
    expect(first?.en).toContain("covenant with God with three acts");
    expect(bare(first?.he)).toMatch(/^בשלושה דברים נכנסו ישראל/);
  });
  it("one chapter is one section, three chapters are three, and quiz questions are dropped", () => {
    expect(one.sections.map((s) => s.heading)).toEqual(["Issurei Biah - Chapter 13"]);
    expect(three.sections.map((s) => s.heading)).toEqual(["Mechirah - Chapter 28", "Mechirah - Chapter 29", "Mechirah - Chapter 30"]);
    expect(allText(three)).not.toMatch(/Quiz Yourself/i);
  });
});

describe("safety", () => {
  it("never keeps scripts, links or markup, only text", () => {
    const evil = `<html><body><h2>Chapter 1</h2><div class="article-body"><div class="verse-wrapper"><span class="text-with-annotation co_verse"><a class="versenum">1</a>Hello <script>alert(1)</script><b onclick="x()">there</b></span><span class="alternate_he">שלום</span></div></div></body></html>`;
    const b = parseStudyPage(evil, "rambam1").sections[0]?.blocks[0];
    expect(b?.en).toBe("Hello there");
    expect(b?.he).toBe("שלום");
  });
  it("gives no sections for a page it does not recognise, never an error", () => {
    expect(parseStudyPage("<html><body>nothing</body></html>", "tanya").sections).toEqual([]);
  });
  it("recognises Cloudflare's check page", () => {
    expect(isCheckPage("<html><head><title>Just a moment...</title></head><body></body></html>")).toBe(true);
    expect(isCheckPage(fixture("study-tanya.html"))).toBe(false);
  });
});
