import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseShiurPage, shiurUrl } from "./source";

const html = readFileSync(join(__dirname, "fixtures", "shiur-2026-11-02.html"), "utf8");
const day = parseShiurPage(html);
const study = (k: string) => day?.studies.find((s) => s.study === k);

describe("parseShiurPage", () => {
  it("finds the date and the five studies the library offers", () => {
    expect(day?.date).toBe("2026-11-02");
    expect(day?.studies.map((s) => s.study)).toEqual(["chumash", "tanya", "hayomyom", "rambam3", "rambam1"]);
  });

  it("reads the Chumash portion, each verse's number, Hebrew and English, and Rashi after it", () => {
    const c = study("chumash");
    expect(c?.portion).toBe("Parshat Chayei Sarah, 2nd Portion (Bereshit (Genesis) 23:17-24:9)");
    const blocks = c?.sections.flatMap((s) => s.blocks) ?? [];
    expect(blocks[0]).toMatchObject({ kind: "verse", num: "יז" });
    expect(blocks[0]?.en).toMatch(/^Ephron’s Field of Machpelah/);
    expect(blocks[0]?.he).toMatch(/[א-ת]/);
    expect(blocks[0]?.he).not.toContain("יז");
    expect(blocks[1]).toMatchObject({ kind: "rashi" });
    expect(blocks[1]?.leadEn).toMatch(/Ephron’s field/);
    expect(blocks[1]?.en).toMatch(/It had a rise in status/);
    expect(blocks[1]?.leadHe).toMatch(/[א-ת]/);
  });

  it("reads Tanya and Hayom Yom as Hebrew/English rows", () => {
    const t = study("tanya");
    expect(t?.portion).toBe("Iggeret HaKodesh, middle of Epistle 29");
    expect(t?.sections[0]?.blocks[0]?.en).toMatch(/^This is the meaning of the statement/);
    expect(t?.sections[0]?.blocks[0]?.he).toMatch(/^וְזֶהוּ/);
    const h = study("hayomyom");
    expect(h?.sections.flatMap((s) => s.blocks).some((b) => /Torah lessons/.test(b.en))).toBe(true);
  });

  it("splits Rambam into chapters, each with numbered halachos", () => {
    const r = study("rambam3");
    expect(r?.sections.length).toBe(3);
    expect(r?.sections.map((s) => s.heading)).toEqual(["Chapter 1", "Chapter 2", "Chapter 3"]);
    expect(r?.portion).toMatch(/^Zechiyah uMattanah - Chapter 1/);
    expect(r?.sections.some((s) => s.blocks.some((b) => /^[א-ת]/.test(b.num ?? "")))).toBe(true);
    // the number is taken out of the Hebrew text, not left in front of it
    const numbered = r?.sections.flatMap((s) => s.blocks).find((b) => b.num);
    expect(numbered?.he.startsWith(numbered.num ?? "?")).toBe(false);
    expect(r?.sections[0]?.blocks.some((b) => b.en.length > 20)).toBe(true);
    expect(study("rambam1")?.portion).toMatch(/^Issurei Biah - Chapter 14/);
  });

  it("returns text only: no markup, no page markers, no empty blocks", () => {
    for (const s of day?.studies ?? []) {
      for (const b of s.sections.flatMap((x) => x.blocks)) {
        expect(`${b.he}${b.en}${b.leadHe ?? ""}${b.leadEn ?? ""}`).not.toMatch(/[<>]|CHITASPAGE/);
        expect(b.he || b.en).toBeTruthy();
      }
    }
  });

  it("never keeps scripts or event handlers from the page", () => {
    const evil = `<main><div class="content"><section class="shiur-day"><section class="section-card"><span class="pdf-page-marker">CHITASPAGE__tanya_2026_11_02__</span><h2>Tanya</h2><div class="two-column-row bilingual-row"><div class="hebrew-text" dir="rtl">שלום<script>alert(1)</script></div><div class="english-text">Hi <b onclick="x()">there</b></div></div></section></section></div></main>`;
    const b = parseShiurPage(evil)?.studies[0]?.sections[0]?.blocks[0];
    expect(b?.en).toBe("Hi there");
    expect(b?.he).toBe("שלום");
  });

  it("gives null for a page that is not the booklet (an error page, the check page, anything else)", () => {
    expect(parseShiurPage("<html><body>404</body></html>")).toBeNull();
    expect(parseShiurPage("<html><title>Just a moment...</title></html>")).toBeNull();
  });
});

describe("shiurUrl", () => {
  it("asks for one day, half-size, all five studies", () => {
    const u = new URL(shiurUrl("2026-11-02"));
    expect(u.origin + u.pathname).toBe("https://chitas-site.vercel.app/shiur");
    expect(u.searchParams.get("from")).toBe("2026-11-02");
    expect(u.searchParams.get("to")).toBe("2026-11-02");
    for (const k of ["chumash", "tanya", "hayomYom", "rambam3", "rambam1"]) expect(u.searchParams.get(k)).toBe("1");
    expect(u.searchParams.get("sotah")).toBeNull();
  });
  it("rejects a bad date", () => {
    expect(() => shiurUrl("11/2/2026")).toThrow();
  });
});
