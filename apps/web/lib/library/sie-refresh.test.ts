import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";

vi.setConfig({ testTimeout: 30_000 });
vi.mock("server-only", () => ({}));
import { analyzeSiePdf, parseSieWeeklyPage, refreshSie } from "./sie-refresh";

const fixture = readFileSync(join(__dirname, "fixtures", "sie-weekly-page.html"), "utf8");

describe("parseSieWeeklyPage (a copy of shop.sie.org/pages/weekly)", () => {
  const rows = parseSieWeeklyPage(fixture);

  it("reads the volume, the book, the title and the Drive file of each week", () => {
    const published = rows.filter((r) => !r.soon);
    expect(published.map((r) => [r.chelek, r.sefer, r.title])).toEqual([
      ["Alef", "Bereishis", "Bereishis"],
      ["Alef", "Bereishis", "Noach"],
      ["Alef", "Shmos", "Yud Shvat"],
    ]);
    expect(published[0]!.url).toBe("https://drive.google.com/file/d/1I-mPynOpu1dMkcfo3LG49MYeXYh4whoo/view");
  });

  it("marks weeks that are 'coming soon' (no file yet), including a whole coming-soon volume", () => {
    expect(rows.filter((r) => r.soon).map((r) => r.title)).toEqual(["Chayei Sarah", "Bereishis"]);
    expect(rows.find((r) => r.chelek === "Hey")?.soon).toBe(true);
  });

  it("keeps only Google Drive file links, and returns nothing for a page it does not recognise", () => {
    const odd = '<div class="chelek-section"><button class="chelek-header">Chelek Alef</button><div class="sefer-section"><button class="sefer-header">Sefer Shmos</button><div class="sicha-wrapper"><div class="sicha-item"><span class="sicha-title">X</span><a class="sicha-btn--download" href="https://evil.example/x.pdf">d</a></div></div></div></div>';
    expect(parseSieWeeklyPage(odd).filter((r) => !r.soon)).toEqual([]);
    expect(parseSieWeeklyPage("<p>hello</p>")).toEqual([]);
  });
});

/** A PDF shaped like SIE's: cover, blank page, dedication page(s), then the content. */
async function siePdf(opts: { dedications?: number; introMentionsDedicated?: boolean; volume?: number; page?: number; backMatter?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const text = (t: string) => doc.addPage([612, 792]).drawText(t, { x: 40, y: 700, size: 12, font });
  const vol = opts.volume ?? 2;
  const pg = opts.page ?? 33;
  const cover = doc.addPage([612, 792]);
  cover.drawText(`LIKKUTEI SICHOS, VOLUME ${vol}, P. *****`, { x: 40, y: 700, size: 12, font });
  cover.drawText(`INSIGHTS INTO THE WEEKLY PARSHA BY THE LUBAVITCHER REBBE`, { x: 40, y: 680, size: 10, font });
  cover.drawText(`NOACH VOLUME ${vol}, P. ${pg}-${pg + 3}`, { x: 40, y: 660, size: 12, font });
  doc.addPage([612, 792]); // blank
  for (let i = 0; i < (opts.dedications ?? 1); i++) text("Dedicated to the memory of someone dear, whose life was a blessing to everyone around them.");
  text(opts.introMentionsDedicated ? "4 Introduction Many people who were dedicated to the study of Torah found that the weekly portion gave them strength." : "4 Introduction A short introduction to the sicha.");
  text("5 PARSHAS NOACH The sicha begins here and continues with enough words to be clearly a real page of content.");
  text("6 More of the sicha, again with enough words on the page that nobody could mistake it for a blank page.");
  if (opts.backMatter ?? true) {
    doc.addPage([612, 792]); // blank
    text("CREDITS: Copyright by Sichos in English Rabbi Eliyahu Touger Translators Rabbi Sholom Ber Wineberg.");
    doc.addPage([612, 792]); // back cover
  }
  return doc.save();
}

describe("analyzeSiePdf (which Likkutei Sichos sicha it is, and where the real content starts)", () => {
  it("reads the volume and page, skips the cover, blank page and dedication, and counts the pages", async () => {
    expect(await analyzeSiePdf(await siePdf())).toEqual({ volume: 2, page: 33, from: 4, to: 6, pageCount: 9 });
  });
  it("recognises a cover whose title is letter-spaced (some SIE covers are), as a short first page", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([612, 792]).drawText("I N S I G H T S I N T O T H E W E E K L Y P A R S H A B Y T H E R E B B E", { x: 20, y: 700, size: 8, font });
    doc.addPage([612, 792]);
    const ded = doc.addPage([612, 792]);
    ded.drawText("Dedicated to the memory of someone dear, whose life was a blessing to everyone around them.", { x: 40, y: 700, size: 8, font });
    doc.addPage([612, 792]).drawText("4 Introduction A short introduction to the sicha, with plenty of words so it is clearly a real page of content.", { x: 40, y: 700, size: 8, font });
    doc.addPage([612, 792]).drawText("5 PARSHAS NOACH The sicha begins here and continues with enough words to be clearly a real page of content.", { x: 40, y: 700, size: 8, font });
    expect((await analyzeSiePdf(await doc.save()))?.from).toBe(4);
  });
  it("skips every dedication page when there are two", async () => {
    expect(await analyzeSiePdf(await siePdf({ dedications: 2, volume: 3, page: 217 }))).toMatchObject({ volume: 3, page: 217, from: 5, to: 7 });
  });
  it("drops the back matter too: the blank page, the copyright credits page and the back cover", async () => {
    expect((await analyzeSiePdf(await siePdf()))?.to).toBe(6);
    expect((await analyzeSiePdf(await siePdf({ backMatter: false })))?.to).toBe(6); // a file with no back matter keeps all its pages
  });
  it("does not mistake an introduction that merely mentions 'dedicated' for a dedication page", async () => {
    expect((await analyzeSiePdf(await siePdf({ introMentionsDedicated: true })))?.from).toBe(4);
  });
  it("returns the pages it could read even when the source line is missing, and null for a file that is not a PDF", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const t of ["PARSHAS NOACH. The sicha begins here and goes on for a while so that it is clearly real content.", "More of the sicha, with enough words on the page to be clearly real content as well."]) {
      doc.addPage([612, 792]).drawText(t, { x: 40, y: 700, size: 12, font });
    }
    expect(await analyzeSiePdf(await doc.save())).toEqual({ from: 1, to: 2, pageCount: 2 });
    expect(await analyzeSiePdf(new TextEncoder().encode("not a pdf"))).toBeNull();
  });
});

describe("refreshSie (find the new weeks and add them)", () => {
  const A = "https://drive.google.com/file/d/1I-mPynOpu1dMkcfo3LG49MYeXYh4whoo/view";
  const B = "https://drive.google.com/file/d/1CWNav1KEctok2nLBCgRWweEcWmNTC0ob/view";
  const C = "https://drive.google.com/file/d/10UPYgALr8xw4JhQj1pvOsw-lRhnn0CJ9/view";
  const run = async (over: Partial<Parameters<typeof refreshSie>[0]> = {}) => {
    const saved: unknown[] = [];
    const bytes = await siePdf();
    const result = await refreshSie({
      fetchPage: async () => fixture,
      fetchPdf: async () => ({ ok: true, bytes }),
      known: new Set([A]),
      save: async (rows) => void saved.push(...rows),
      ...over,
    });
    return { result, saved };
  };

  it("adds only the weeks it does not already have, skipping 'coming soon', and reads each new file", async () => {
    const { result, saved } = await run();
    expect(result).toMatchObject({ found: 3, added: 2, remaining: 0, failed: [] });
    expect((saved as { url: string }[]).map((r) => r.url).sort()).toEqual([B, C].sort());
    expect(saved[0]).toMatchObject({ chelek: "Alef", volume: 2, page: 33, from: 4, to: 6, pageCount: 9 });
  });

  it("says plainly when there is nothing new", async () => {
    const { result, saved } = await run({ known: new Set([A, B, C]) });
    expect(result).toMatchObject({ added: 0, remaining: 0 });
    expect(saved).toEqual([]);
  });

  it("works through a few at a time and says how many are left", async () => {
    const { result, saved } = await run({ maxNew: 1 });
    expect(result).toMatchObject({ added: 1, remaining: 1 });
    expect(saved).toHaveLength(1);
  });

  it("keeps going when one file cannot be fetched, and names it", async () => {
    const bytes = await siePdf();
    const { result } = await run({ fetchPdf: async (url) => (url === B ? { ok: false, message: "not shared" } : { ok: true, bytes }) });
    expect(result.added).toBe(1);
    expect(result.failed).toEqual([{ title: "Noach", reason: "not shared" }]);
  });

  it("reports a page it cannot read instead of guessing", async () => {
    const { result } = await run({ fetchPage: async () => "<p>maintenance</p>" });
    expect(result).toMatchObject({ found: 0, added: 0 });
    expect(result.problem).toMatch(/looks different/i);
  });
});
