import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseEntryPage, parseLikkutSichos, parseListPage } from "./mafteiach-parse";

// Trimmed copies of the real mafteiach.app pages (see fixtures/), so these tests break if the parser stops matching them.
const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");

describe("parseLikkutSichos (a Likkutei Sichos volume page)", () => {
  const page = parseLikkutSichos(fixture("likkutei-volume.html"));

  it("lists the volumes with their Hebrew letters, and which one is open", () => {
    expect(page.volumes).toEqual([
      { n: 1, label: "א" },
      { n: 2, label: "ב" },
      { n: 3, label: "ג" },
    ]);
    expect(page.current).toBe(1);
  });

  it("groups the sichos under their parsha", () => {
    expect(page.parshiyos.map((p) => p.name)).toEqual(["בראשית", "נח", "לך לך"]);
    expect(page.parshiyos.every((p) => p.entries.length === 1)).toBe(true);
  });

  it("gives each sicha its reference, summary and the Drive links the site offers (Hebrew and translated), not the internal summary page", () => {
    const first = page.parshiyos[0]!.entries[0]!;
    expect(first.label).toBe("ח\"א ע' 1 (בראשית)");
    expect(first.summary).toMatch(/^בריאה יש מאין/);
    expect(first.links).toEqual([
      { label: "שיחה", url: "https://drive.google.com/file/d/1euyJgTsrrLkr8b0mIAtxr5vb_PrKM3ln/view?usp=drivesdk" },
      { label: "מתורגם", url: "https://drive.google.com/file/d/11FZ50P-0mNZksFO-Xj89uA7vIO76BFzm/view?usp=drivesdk" },
    ]);
  });

  it("returns an empty page, not an error, for markup it does not recognise", () => {
    expect(parseLikkutSichos("<html><body>nothing here</body></html>")).toEqual({ volumes: [], current: null, parshiyos: [] });
  });
});

describe("parseListPage (a year of maamarim or of sichos and farbrengens)", () => {
  it("reads the years and the maamarim, with the path to each one's own page", () => {
    const page = parseListPage(fixture("maamorim-list.html"));
    expect(page.years).toEqual([
      { year: "5711", label: "תשי\"א", current: true },
      { year: "5712", label: "תשי\"ב", current: false },
      { year: "5713", label: "תשי\"ג", current: false },
    ]);
    const first = page.entries[0]!;
    expect(first).toMatchObject({ kind: "maamor", id: "1", path: "/maamorim/1", heading: "יו\"ד שבט", title: "באתי לגני" });
    expect(first.note).toBe("[המשך: א]");
    expect(first.series).toBe("קונטרס: מאמר יו\"ד שבט ה'תשי\"א");
  });

  it("reads a farbrengen entry, whose own page is addressed by date", () => {
    const page = parseListPage(fixture("farbrengen-entry.html"));
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({ kind: "farbrengen", id: "5711-01-01", path: "/all/5711-01-01", title: "יום א' דר\"ה, בעת ההליכה לתשליך" });
  });

  it("returns nothing for markup it does not recognise", () => {
    expect(parseListPage("<p>hi</p>")).toEqual({ years: [], entries: [] });
  });
});

describe("parseEntryPage (what one maamar or farbrengen offers)", () => {
  it("lists each edition with its links: the Hebrew edition, the older unedited one, the notes", () => {
    const sections = parseEntryPage(fixture("maamor-entry.html"));
    const flat = sections.flatMap((s) => s.groups.map((g) => ({ section: s.title, group: g.label, links: g.links.map((l) => l.url) })));
    expect(flat).toEqual([
      { section: "הנחות", group: "מוגה", links: ["https://drive.google.com/open?id=1dcUlOogSCT2_fZXgGTQb9nzaMsZLaO9n"] },
      { section: "הנחות", group: "בלתי מוגה - מהדורה ישנה", links: [expect.stringMatching(/^https:\/\/docs\.google\.com\/document\/d\/0B_WSU737WJ1fMmZHRGdZdlpyMm8/)] },
      {
        section: "הגהות",
        group: "",
        links: [
          "https://drive.google.com/file/d/1-0QomRWF3o-LUOwMnTQC8aRkl0bLVTxD/view?usp=drivesdk",
          "https://drive.google.com/file/d/1uVzlvGhLlA2eXGRpTZsrHACTPl9OwWRw/view?usp=sharing",
        ],
      },
    ]);
  });

  it("keeps the label of each link", () => {
    const labels = parseEntryPage(fixture("farbrengen-entry.html")).flatMap((s) => s.groups.flatMap((g) => g.links.map((l) => l.label)));
    expect(labels).toEqual(["שיחו\"ק", "תו\"מ התוועדויות", "Proceeding Together Vol. 3"]);
  });

  it("skips sections with no files (disabled buttons and summary text), and links that are not Google Drive or Docs files", () => {
    const sections = parseEntryPage('<div class="farbrengen-detail-content"><h4>x</h4><a href="https://evil.example/a.pdf">a</a><a href="javascript:alert(1)">b</a></div><div class="farbrengen-detail-content"><h4>y</h4><p>text only</p></div>');
    expect(sections).toEqual([]);
  });

  it("returns nothing for markup it does not recognise", () => {
    expect(parseEntryPage("<p>hi</p>")).toEqual([]);
  });
});
