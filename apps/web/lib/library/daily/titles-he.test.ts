import { describe, expect, it } from "vitest";
import { OFFERED_STUDIES } from "./studies";
import { PARSHIYOS, STUDY_LABELS_HE, hebrewDate, hebrewNumeral, hebrewPortionName } from "./titles-he";

describe("STUDY_LABELS_HE", () => {
  it("names every offered study in Hebrew, and the two Rambam variants differ", () => {
    for (const s of OFFERED_STUDIES) expect(STUDY_LABELS_HE[s]).toMatch(/^[א-ת״ -]+$/);
    expect(STUDY_LABELS_HE.rambam1).toBe("רמב״ם - פרק אחד");
    expect(STUDY_LABELS_HE.rambam3).toBe("רמב״ם - שלשה פרקים");
    expect(new Set(OFFERED_STUDIES.map((s) => STUDY_LABELS_HE[s])).size).toBe(OFFERED_STUDIES.length);
  });
});

describe("hebrewNumeral", () => {
  it("writes days and years the way print does", () => {
    expect(hebrewNumeral(1)).toBe("א׳");
    expect(hebrewNumeral(4)).toBe("ד׳");
    expect(hebrewNumeral(14)).toBe("י״ד");
    expect(hebrewNumeral(15)).toBe("ט״ו");
    expect(hebrewNumeral(16)).toBe("ט״ז");
    expect(hebrewNumeral(30)).toBe("ל׳");
    expect(hebrewNumeral(787)).toBe("תשפ״ז");
    expect(hebrewNumeral(784)).toBe("תשפ״ד");
    expect(hebrewNumeral(500)).toBe("ת״ק");
    expect(() => hebrewNumeral(0)).toThrow();
  });
});

describe("hebrewDate", () => {
  // Each expectation is anchored on a date that is published independently (holidays), then counted by hand:
  // Hanukkah 5787 starts 25 Kislev = 2026-12-05, so 2026-11-14 (21 days earlier) is 4 Kislev.
  it("2026-11-14 is 4 Kislev 5787", () => {
    expect(hebrewDate("2026-11-14")).toBe("ד׳ כסלו תשפ״ז");
    expect(hebrewDate("2026-12-05")).toBe("כ״ה כסלו תשפ״ז");
  });

  it("first of Tishrei is Rosh Hashanah (2026-09-12); the 15th is Sukkot; Yom Kippur is the 10th", () => {
    expect(hebrewDate("2026-09-12")).toBe("א׳ תשרי תשפ״ז");
    expect(hebrewDate("2026-09-21")).toBe("י׳ תשרי תשפ״ז");
    expect(hebrewDate("2026-09-26")).toBe("ט״ו תשרי תשפ״ז");
    expect(hebrewDate("2026-09-11")).toBe("כ״ט אלול תשפ״ו");
  });

  it("a 30-day month: Tishrei 30 (Rosh Chodesh Cheshvan, first day) and the next day is 1 Cheshvan, spelled חשון", () => {
    expect(hebrewDate("2026-10-11")).toBe("ל׳ תשרי תשפ״ז");
    expect(hebrewDate("2026-10-12")).toBe("א׳ חשון תשפ״ז");
  });

  it("a leap year has Adar I and Adar II (5784: Purim is 14 Adar II = 2024-03-24, Purim Katan 14 Adar I = 2024-02-23)", () => {
    expect(hebrewDate("2024-02-23")).toBe("י״ד אדר א׳ תשפ״ד");
    expect(hebrewDate("2024-03-10")).toBe("ל׳ אדר א׳ תשפ״ד");
    expect(hebrewDate("2024-03-11")).toBe("א׳ אדר ב׳ תשפ״ד");
    expect(hebrewDate("2024-03-24")).toBe("י״ד אדר ב׳ תשפ״ד");
    // 5787 is a leap year too: Purim is 2027-03-23.
    expect(hebrewDate("2027-03-23")).toBe("י״ד אדר ב׳ תשפ״ז");
  });

  it("a common year has a single plain Adar (5786, Purim 2026-03-03) and Pesach is 15 Nisan (2026-04-02)", () => {
    expect(hebrewDate("2026-03-03")).toBe("י״ד אדר תשפ״ו");
    expect(hebrewDate("2026-04-02")).toBe("ט״ו ניסן תשפ״ו");
  });

  it("does not depend on the machine's time zone", () => {
    const before = process.env.TZ;
    try {
      for (const tz of ["Pacific/Kiritimati", "Pacific/Pago_Pago", "UTC"]) {
        process.env.TZ = tz;
        expect(hebrewDate("2026-11-14")).toBe("ד׳ כסלו תשפ״ז");
      }
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  it("never leaves the 'ב' prefix or Arabic digits in the result", () => {
    for (let d = 0; d < 400; d += 3) {
      const iso = new Date(Date.UTC(2026, 8, 1 + d)).toISOString().slice(0, 10);
      expect(hebrewDate(iso)).toMatch(/^[א-ת]+[׳״]?[א-ת]* [א-ת]+(?: [אב]׳)? [א-ת]+[׳״][א-ת]*$|^[א-ת]׳ [א-ת]+(?: [אב]׳)? [א-ת]+״[א-ת]$|^[א-ת״׳]+ [א-ת]+(?: [אב]׳)? [א-ת״׳]+$/);
      expect(hebrewDate(iso)).not.toMatch(/[0-9]|\bב[א-ת]/);
    }
  });

  it("rejects something that is not an ISO date", () => {
    expect(() => hebrewDate("14/11/2026")).toThrow();
    expect(() => hebrewDate("2026-13-40")).toThrow();
  });
});

describe("hebrewPortionName", () => {
  it("reads the portion line of the daily source", () => {
    expect(hebrewPortionName("chumash", "Parshat Chayei Sarah, 2nd Portion (Bereshit (Genesis) 23:17-24:9)")).toBe("פרשת חיי שרה");
    expect(hebrewPortionName("chumash", "Parshat Chayei Sarah, 1st Portion (Bereshit (Genesis) 23:1-23:16) with Rashi")).toBe("פרשת חיי שרה");
    expect(hebrewPortionName("chumash", "Parshas Vayera")).toBe("פרשת וירא");
  });

  it("knows all 54 parshiyos, each by every spelling listed, in any case and punctuation", () => {
    expect(PARSHIYOS).toHaveLength(54);
    expect(new Set(PARSHIYOS.map((p) => p.he)).size).toBe(54);
    for (const p of PARSHIYOS) {
      for (const en of p.en) {
        expect(hebrewPortionName("chumash", `Parshat ${en}, 1st Portion (Somewhere 1:1-2:3)`)).toBe(`פרשת ${p.he}`);
        expect(hebrewPortionName("chumash", `  PARSHAS  ${en.toUpperCase()}  `)).toBe(`פרשת ${p.he}`);
        expect(hebrewPortionName("chumash", en.toLowerCase())).toBe(`פרשת ${p.he}`);
      }
    }
  });

  it("no spelling belongs to two parshiyos", () => {
    const seen = new Map<string, string>();
    for (const p of PARSHIYOS) {
      for (const en of p.en) {
        const k = en.toLowerCase().replace(/[^a-z]/g, "");
        expect(seen.get(k) ?? p.he).toBe(p.he);
        seen.set(k, p.he);
      }
    }
  });

  it("accepts both the Hebcal-style and the Chabad spelling of the same parsha", () => {
    expect(hebrewPortionName("chumash", "Parshat Bereshit")).toBe("פרשת בראשית");
    expect(hebrewPortionName("chumash", "Parshas Bereishis")).toBe("פרשת בראשית");
    expect(hebrewPortionName("chumash", "Parshat Toldot")).toBe(hebrewPortionName("chumash", "Parshas Toldos"));
    expect(hebrewPortionName("chumash", "Parshat Lech-Lecha")).toBe("פרשת לך לך");
  });

  it("joins a double parsha with a maqaf", () => {
    expect(hebrewPortionName("chumash", "Parshat Vayakhel-Pekudei, 1st Portion")).toBe("פרשת ויקהל־פקודי");
    expect(hebrewPortionName("chumash", "Parshas Matot and Masei")).toBe("פרשת מטות־מסעי");
  });

  it("returns null for an unknown name, an empty line, a holiday reading or another study", () => {
    expect(hebrewPortionName("chumash", "Parshat Nowhere, 1st Portion")).toBeNull();
    expect(hebrewPortionName("chumash", "Simchat Torah")).toBeNull();
    expect(hebrewPortionName("chumash", "")).toBeNull();
    expect(hebrewPortionName("chumash", null)).toBeNull();
    expect(hebrewPortionName("chumash", "Parshat Vayakhel-Nowhere")).toBeNull();
    expect(hebrewPortionName("tanya", "Parshat Chayei Sarah")).toBeNull();
    expect(hebrewPortionName("rambam1", "Issurei Biah - Chapter 14 | Shiur 273")).toBeNull();
    expect(hebrewPortionName("hayomyom", "Iggeret HaKodesh, middle of Epistle 29")).toBeNull();
  });
});
