import { describe, expect, it, vi } from "vitest";
import { checkTextFidelity } from "@printio/pdf/text-fidelity";
import { padAndImposeBooklet } from "@printio/pdf/booklet-build";
import { pageTexts } from "@/test/hebrew-fixtures";
import { buildFilledPdf, type Language } from "./fill";
import { coverDates, mergeDays, type DayRow, type DayText } from "./merge";
import { datesBetween } from "./studies";

vi.setConfig({ testTimeout: 60_000 });
vi.mock("server-only", () => ({}));

const HE = "בְּרֵאשִׁ֖ית בָּרָ֣א אֱלֹהִ֑ים אֵ֥ת הַשָּׁמַ֖יִם וְאֵ֥ת הָאָֽרֶץ׃ וְהָאָ֗רֶץ הָיְתָ֥ה תֹ֙הוּ֙ וָבֹ֔הוּ וְחֹ֖שֶׁךְ עַל־פְּנֵ֣י תְה֑וֹם";
const study = (name: string, portion: string, mark: string): DayRow => ({
  study: name,
  portion,
  sections: [
    {
      heading: "",
      blocks: [
        ...Array.from({ length: 6 }, (_, i) => ({ kind: "verse" as const, num: String(i + 1), he: `${HE} ${mark}`, en: `In the beginning, ${mark}, God created the heavens and the earth, and the earth was without form.` })),
        { kind: "rashi" as const, leadHe: "בראשית", he: `אמר רבי יצחק ${mark}`, leadEn: "In the beginning", en: `Rabbi Yitzchak said, ${mark}.` },
      ],
    },
  ],
});
// 2026-11-02 is a Monday.
const MON = "2026-11-02";
const TUE = "2026-11-03";
const WED = "2026-11-04";
const day = (date: string, mark: string, studies = ["chumash", "tanya", "hayomyom", "rambam3", "rambam1"]): DayText => ({
  date,
  rows: studies.map((s) => study(s, s === "chumash" ? "Parshat Chayei Sarah, 2nd Portion" : `${s} portion ${mark}`, `${mark}${s}`)),
});
const all = ["chumash", "tanya", "hayomyom", "rambam3", "rambam1"] as const;

describe("mergeDays: what goes in the booklet, in what order", () => {
  it("one day: the studies in the printing order, no day headings, one line of contents for the day", () => {
    const res = mergeDays({ days: [day(MON, "a")], studies: ["rambam1", "chumash", "tanya"], arrange: "study", skipMissing: false });
    if (!res.ok) throw new Error(res.message);
    expect(res.items.map((i) => i.title.split(" - ")[0])).toEqual(["Chumash with Rashi", "Tanya", "Rambam (1 chapter)"]);
    expect(res.items[0]!.titleHe).toBe("חומש - פרשת חיי שרה");
    expect(res.items.some((i) => i.groupTitle || i.groupTitleHe)).toBe(false);
    expect(res.contents).toEqual([{ label: "Monday", text: "Chumash with Rashi, Tanya, Rambam (1 perek)", labelHe: "יום שני", textHe: "חומש עם רש״י, תניא, רמב״ם (פרק אחד)" }]);
    expect(res.dates).toEqual([MON]);
    expect(res.skipped).toEqual([]);
  });

  it("by day: day 1's studies, then day 2's; each day under its own heading; one contents row per day", () => {
    const res = mergeDays({ days: [day(MON, "a"), day(TUE, "b")], studies: ["tanya", "chumash"], arrange: "day", skipMissing: false });
    if (!res.ok) throw new Error(res.message);
    expect(res.items.map((i) => `${i.footer} | ${i.title.split(" - ")[0]}`)).toEqual([
      "Monday, November 2, 2026 | Chumash with Rashi",
      "Monday, November 2, 2026 | Tanya",
      "Tuesday, November 3, 2026 | Chumash with Rashi",
      "Tuesday, November 3, 2026 | Tanya",
    ]);
    expect(res.items.map((i) => i.groupTitle)).toEqual(["Monday, November 2, 2026", undefined, "Tuesday, November 3, 2026", undefined]);
    expect(res.items[0]!.groupTitleHe).toBe("יום שני, כ״ב חשון תשפ״ז");
    expect(res.contents.map((c) => `${c.label}: ${c.text}`)).toEqual(["Monday: Chumash with Rashi, Tanya", "Tuesday: Chumash with Rashi, Tanya"]);
    expect(res.contents.map((c) => `${c.labelHe}: ${c.textHe}`)).toEqual(["יום שני: חומש עם רש״י, תניא", "יום שלישי: חומש עם רש״י, תניא"]);
  });

  it("by study: every day's Chumash, then every day's Tanya; each study under its own heading; the contents match", () => {
    const res = mergeDays({ days: [day(MON, "a"), day(TUE, "b"), day(WED, "c")], studies: ["tanya", "chumash"], arrange: "study", skipMissing: false });
    if (!res.ok) throw new Error(res.message);
    expect(res.items.map((i) => i.title.split(" - ")[0])).toEqual(["Monday, November 2", "Tuesday, November 3", "Wednesday, November 4", "Monday, November 2", "Tuesday, November 3", "Wednesday, November 4"]);
    expect(res.items.map((i) => i.groupTitle)).toEqual(["Chumash with Rashi", undefined, undefined, "Tanya", undefined, undefined]);
    expect(res.items[0]!.groupTitleHe).toBe("חומש");
    expect(res.items[0]!.titleHe).toBe("יום שני, כ״ב חשון תשפ״ז - פרשת חיי שרה");
    expect(res.items[3]!.sections[0]!.blocks[0]!.he).toContain("atanya");
    expect(res.contents.map((c) => `${c.label}: ${c.text}`)).toEqual(["Chumash with Rashi: Monday, Tuesday, Wednesday", "Tanya: Monday, Tuesday, Wednesday"]);
    expect(res.contents[1]).toMatchObject({ labelHe: "תניא", textHe: "יום שני, יום שלישי, יום רביעי" });
  });

  it("lists only the studies that are really in the booklet", () => {
    const res = mergeDays({ days: [day(MON, "a"), day(TUE, "b", ["chumash", "rambam1"])], studies: ["chumash", "tanya", "rambam1"], arrange: "day", skipMissing: true });
    if (!res.ok) throw new Error(res.message);
    expect(res.contents.map((c) => `${c.label}: ${c.text}`)).toEqual(["Monday: Chumash with Rashi, Tanya, Rambam (1 perek)", "Tuesday: Chumash with Rashi, Rambam (1 perek)"]);
    expect(res.contents.every((c) => !/\d{2,}|\.\./.test(c.text))).toBe(true);
    expect(res.skipped).toEqual(["Tanya on Tuesday, November 3, 2026"]);
  });
});

describe("mergeDays: days that are not available", () => {
  const days = [day(MON, "a"), { date: TUE, rows: null }, day(WED, "c"), { date: "2026-11-05", rows: null }];

  it("stops and says exactly which days, and how to go on without them", () => {
    const res = mergeDays({ days, studies: [...all], arrange: "day", skipMissing: false });
    expect(res).toEqual({ ok: false, message: 'Not available: Tuesday, November 3, 2026; Thursday, November 5, 2026. Tick "Skip days that are not available" to make the booklet without them.' });
  });

  it("with the skip option the booklet is made without them, and says what was left out", () => {
    const res = mergeDays({ days, studies: [...all], arrange: "day", skipMissing: true });
    if (!res.ok) throw new Error(res.message);
    expect(res.dates).toEqual([MON, WED]);
    expect(res.skipped).toEqual(["Tuesday, November 3, 2026", "Thursday, November 5, 2026"]);
    expect(res.contents.map((c) => c.label)).toEqual(["Monday", "Wednesday"]);
    expect(coverDates(res.dates)).toEqual({ dateEn: "Monday, November 2, 2026 - Wednesday, November 4, 2026", dateHe: "כ״ב חשון תשפ״ז - כ״ד חשון תשפ״ז" });
  });

  it("a study missing from one day is named too; skipping every day gives a plain message", () => {
    const partial = mergeDays({ days: [day(MON, "a"), day(TUE, "b", ["chumash"])], studies: ["chumash", "tanya"], arrange: "study", skipMissing: false });
    expect(partial).toEqual({ ok: false, message: 'Not available: Tanya on Tuesday, November 3, 2026. Tick "Skip days that are not available" to make the booklet without it.' });
    const none = mergeDays({ days: [{ date: MON, rows: null }, { date: TUE, rows: null }], studies: ["tanya"], arrange: "day", skipMissing: true });
    expect(none).toEqual({ ok: false, message: "None of those days is available yet." });
  });

  it("one day keeps the old message for a study the source did not give", () => {
    const res = mergeDays({ days: [day(MON, "a", ["chumash"])], studies: ["chumash", "tanya", "rambam1"], arrange: "day", skipMissing: false });
    expect(res).toEqual({ ok: false, message: "Tanya and Rambam (1 chapter) are not in the source for that day." });
  });

  it("a range is at most 7 days and never backwards", () => {
    expect(datesBetween(MON, MON)).toEqual([MON]);
    expect(datesBetween("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(datesBetween(MON, "2026-11-08")).toHaveLength(7);
    expect(datesBetween(MON, "2026-11-09")).toBeNull();
    expect(datesBetween(TUE, MON)).toBeNull();
  });
});

describe("a booklet of several days still passes Printio's own checks", () => {
  const build = async (language: Language, arrange: "day" | "study") => {
    const merged = mergeDays({ days: datesBetween(MON, WED)!.map((d, i) => day(d, `d${i}`, ["chumash", "tanya"])), studies: ["chumash", "tanya"], arrange, skipMissing: false });
    if (!merged.ok) throw new Error(merged.message);
    const when = coverDates(merged.dates);
    const built = await buildFilledPdf({
      title: "Daily Study",
      titleHe: "לימוד יומי",
      items: merged.items,
      language,
      columns: "auto",
      page: { width: 396, height: 612 },
      margin: 28,
      credit: "Thank you.",
      cover: { ...when, contents: merged.contents },
      footer: { text: when.dateEn, textHe: when.dateHe },
    });
    return { merged, built };
  };

  it.each([
    ["he", "day"],
    ["both", "day"],
    ["both", "study"],
  ] as const)("%s, by %s: a multiple of four pages, and the folded booklet has the same Hebrew text as the PDF it was made from", async (language, arrange) => {
    const { built } = await build(language, arrange);
    expect(built.pages % 4).toBe(0);
    expect(built.pages).toBe(built.targetPages);
    const folded = await padAndImposeBooklet(built.bytes, { paperSize: "letter", bindingSide: language === "he" ? "right" : "left", fit: "fill" });
    const result = await checkTextFidelity({ original: built.bytes, derived: folded.bytes, sourcePages: null, booklet: true });
    expect(result).toEqual({ status: "ok" });
  });

  it("draws every day's Hebrew exactly as saved (every vowel and trop mark), in the order of the arrangement", async () => {
    for (const arrange of ["day", "study"] as const) {
      const { merged, built } = await build("both", arrange);
      const drawn = built.plan.pages.flat().filter((o) => o.role === "body" && o.dir === "rtl").map((o) => o.logical).join(" ").replace(/\s+/g, " ");
      let from = 0;
      for (const item of merged.items) {
        for (const b of item.sections.flatMap((s) => s.blocks)) {
          const at = drawn.indexOf(b.he.replace(/\s+/g, " "), from);
          expect(at, `${arrange}: ${b.he.slice(-12)}`).toBeGreaterThanOrEqual(from);
          from = at;
        }
      }
      // and what a PDF reader extracts holds every Hebrew letter and mark that was saved
      const count = (s: string) => [...s].filter((c) => /[֑-״]/.test(c)).length;
      const extracted = (await pageTexts(built.bytes)).slice(1).flat().join("");
      const saved = merged.items.flatMap((i) => i.sections.flatMap((s) => s.blocks.map((b) => `${b.leadHe ?? ""}${b.he}`))).join("");
      expect(count(extracted)).toBeGreaterThanOrEqual(count(saved));
    }
  });

  it("the day headings and the footer follow the days", async () => {
    const { built } = await build("both", "day");
    const groups = built.plan.pages.flat().filter((o) => o.role === "heading" && /^(Monday|Tuesday|Wednesday), November \d, 2026$/.test(o.logical)).map((o) => o.logical);
    expect(groups).toEqual(["Monday, November 2, 2026", "Tuesday, November 3, 2026", "Wednesday, November 4, 2026"]);
    const foot = built.plan.pages[1]!.filter((o) => o.role === "footer").map((o) => o.logical);
    expect(foot).toEqual(expect.arrayContaining(["2", "Monday, November 2, 2026", "יום שני, כ״ב חשון תשפ״ז"]));
    const cover = built.plan.pages[0]!.map((o) => o.logical);
    expect(cover).toEqual(expect.arrayContaining(["Monday:", "Tuesday:", "Wednesday:", "יום שני:", "יום שלישי:", "יום רביעי:", "Chumash with Rashi, Tanya"]));
  });
});
