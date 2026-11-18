import type { OfferedStudy } from "./studies";

/**
 * Hebrew titles for the daily study booklet: the study names, the Hebrew date, and the Hebrew name of the week's parsha.
 * Pure functions, no network. Nothing here is invented: where the source shows no usable portion name the title is just the
 * study name (hebrewPortionName returns null).
 */

/** The study name as printed in a Hebrew title. Gershayim (U+05F4) in "Rambam", as in print. */
export const STUDY_LABELS_HE: Record<OfferedStudy, string> = {
  chumash: "חומש",
  tanya: "תניא",
  hayomyom: "היום יום",
  rambam3: "רמב״ם - שלשה פרקים",
  rambam1: "רמב״ם - פרק אחד",
};

/** The study names in the front page's list of what is inside, in Hebrew. */
export const CONTENTS_LABELS_HE: Record<OfferedStudy, string> = {
  chumash: "חומש עם רש״י",
  tanya: "תניא",
  hayomyom: "היום יום",
  rambam3: "רמב״ם (ג׳ פרקים)",
  rambam1: "רמב״ם (פרק אחד)",
};

const WEEKDAYS_HE = ["יום ראשון", "יום שני", "יום שלישי", "יום רביעי", "יום חמישי", "יום שישי", "שבת קודש"];

/** "יום שני" for an ISO date (the civil day, like hebrewDate: it flips at midnight, not at sunset). */
export function hebrewWeekday(isoDate: string): string {
  const date = new Date(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new RangeError(`Not a real date: ${isoDate}`);
  return WEEKDAYS_HE[date.getUTCDay()]!;
}

// ---------------------------------------------------------------------------------------------------------------------
// Hebrew date
// ---------------------------------------------------------------------------------------------------------------------

const GERESH = "׳"; // U+05F3
const GERSHAYIM = "״"; // U+05F4

/** Hebrew numerals for 1..999 ("י״ד", "תשפ״ז"), with 15 and 16 written ט״ו and ט״ז, and a geresh after a single letter. */
export function hebrewNumeral(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 999) throw new RangeError(`Cannot write ${n} as a Hebrew numeral`);
  const hundreds = ["", "ק", "ר", "ש", "ת", "תק", "תר", "תש", "תת", "תתק"];
  const tens = ["", "י", "כ", "ל", "מ", "נ", "ס", "ע", "פ", "צ"];
  const units = ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט"];
  const rest = n % 100;
  let letters = hundreds[Math.floor(n / 100)]!;
  if (rest === 15) letters += "טו";
  else if (rest === 16) letters += "טז";
  else {
    letters += tens[Math.floor(rest / 10)]! + units[rest % 10]!;
  }
  return letters.length === 1 ? letters + GERESH : letters.slice(0, -1) + GERSHAYIM + letters.slice(-1);
}

/** Intl spells a few month names the long way; Chabad print uses the short forms. */
const MONTH_NAMES: Record<string, string> = { חשוון: "חשון", סיוון: "סיון" };

/**
 * "י״ד חשון תשפ״ז" for an ISO date ("2026-11-14" gives "ד׳ כסלו תשפ״ז"), from the machine's Hebrew calendar data
 * (Intl 'he-u-ca-hebrew'), read in UTC so the answer does not depend on the machine's time zone. The date flips at midnight,
 * not at sunset. Adar of a leap year reads "אדר א׳" / "אדר ב׳". The thousands of the year are left out, as is usual.
 */
export function hebrewDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new RangeError(`Not an ISO date: ${isoDate}`);
  const date = new Date(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new RangeError(`Not a real date: ${isoDate}`);

  const parts = new Intl.DateTimeFormat("he-u-ca-hebrew-nu-latn", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).formatToParts(date);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const day = Number(part("day"));
  const year = Number(part("year"));
  // Intl writes "ב" before the month inside a sentence; the part itself is clean, but strip it if a runtime ever keeps it.
  let month = part("month").replace(/^ב(?=[א-ת])/, "").trim();
  month = MONTH_NAMES[month] ?? month;
  if (!day || !year || !month) throw new Error(`The Hebrew calendar is not available for ${isoDate}`);
  return `${hebrewNumeral(day)} ${month} ${hebrewNumeral(year % 1000)}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Parsha names (Chumash only)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The 54 parshiyos in reading order: the Hebrew name and the English spellings we recognise. The daily source writes
 * Hebcal-style names ("Parshat Chayei Sarah, 2nd Portion (Bereshit (Genesis) 23:17-24:9)"); Chabad's own spellings
 * ("Bereishis", "Toldos") are listed too. Matching ignores case, spaces, hyphens, apostrophes and accents. One place: add a
 * spelling here and nothing else changes.
 */
export const PARSHIYOS: ReadonlyArray<{ he: string; en: readonly string[] }> = [
  { he: "בראשית", en: ["Bereshit", "Bereishis", "Bereishit", "Breishis", "Bereshis", "Beresheet"] },
  { he: "נח", en: ["Noach", "Noah"] },
  { he: "לך לך", en: ["Lech-Lecha", "Lech Lecha", "Lekh Lekha", "Lech Lecho"] },
  { he: "וירא", en: ["Vayera", "Vayeira", "Vayero"] },
  { he: "חיי שרה", en: ["Chayei Sarah", "Chayei Sara", "Chaye Sarah", "Chayey Sarah", "Chayei Sorah", "Chayeh Sarah"] },
  { he: "תולדות", en: ["Toldot", "Toldos", "Toledot", "Toldoth"] },
  { he: "ויצא", en: ["Vayetzei", "Vayeitzei", "Vayetze", "Vayeitzei", "Vayetzey", "Vayetzay"] },
  { he: "וישלח", en: ["Vayishlach", "Vayishlah"] },
  { he: "וישב", en: ["Vayeshev", "Vayeishev", "Vayeshe"] },
  { he: "מקץ", en: ["Miketz", "Mikeitz", "Mikets", "Mikeitz"] },
  { he: "ויגש", en: ["Vayigash", "Vayigas"] },
  { he: "ויחי", en: ["Vayechi", "Vayehi", "Vayechi"] },
  { he: "שמות", en: ["Shemot", "Shemos", "Sh'mot"] },
  { he: "וארא", en: ["Vaera", "Va'eira", "Vaeira", "Va'era"] },
  { he: "בא", en: ["Bo"] },
  { he: "בשלח", en: ["Beshalach", "Beshalah", "B'shalach", "Beshallach"] },
  { he: "יתרו", en: ["Yitro", "Yisro", "Jethro"] },
  { he: "משפטים", en: ["Mishpatim"] },
  { he: "תרומה", en: ["Terumah", "Trumah", "Terumo"] },
  { he: "תצוה", en: ["Tetzaveh", "Tetzave", "Tetzaveh", "Tezaveh"] },
  { he: "כי תשא", en: ["Ki Tisa", "Ki Sisa", "Ki Tissa", "Ki Thisa"] },
  { he: "ויקהל", en: ["Vayakhel", "Vayakhel", "Vayakheil"] },
  { he: "פקודי", en: ["Pekudei", "Pekudey", "Pekudei", "Pikudei"] },
  { he: "ויקרא", en: ["Vayikra", "Vayikro"] },
  { he: "צו", en: ["Tzav", "Tsav", "Tzo"] },
  { he: "שמיני", en: ["Shmini", "Shemini", "Sh'mini"] },
  { he: "תזריע", en: ["Tazria", "Tazriah", "Tazri'a"] },
  { he: "מצורע", en: ["Metzora", "Metzorah", "Metsora"] },
  { he: "אחרי מות", en: ["Achrei Mot", "Acharei Mot", "Acharei Mos", "Achrei Mos", "Aharei Mot", "Acharey Mos"] },
  { he: "קדושים", en: ["Kedoshim", "Kedoshem", "Kdoshim"] },
  { he: "אמור", en: ["Emor"] },
  { he: "בהר", en: ["Behar", "B'har"] },
  { he: "בחוקותי", en: ["Bechukotai", "Bechukosai", "Bechukotay", "Bechukosay", "Bechukotai"] },
  { he: "במדבר", en: ["Bamidbar", "Bemidbar"] },
  { he: "נשא", en: ["Nasso", "Naso", "Nassa"] },
  { he: "בהעלותך", en: ["Beha'alotcha", "Behaalotecha", "Behaaloscha", "Beha'aloscha", "Behaalosecha", "Behaalotcha"] },
  { he: "שלח", en: ["Sh'lach", "Shelach", "Shlach", "Shlach Lecha", "Shelach Lecha"] },
  { he: "קרח", en: ["Korach", "Korah", "Korach"] },
  { he: "חקת", en: ["Chukat", "Chukas", "Chukkat", "Chukath", "Hukkat"] },
  { he: "בלק", en: ["Balak", "Bolok"] },
  { he: "פינחס", en: ["Pinchas", "Pinchos", "Pinhas"] },
  { he: "מטות", en: ["Matot", "Mattos", "Matos", "Mattot"] },
  { he: "מסעי", en: ["Masei", "Massei", "Masey", "Maasei"] },
  { he: "דברים", en: ["Devarim", "Dvarim"] },
  { he: "ואתחנן", en: ["Vaetchanan", "Vaeschanan", "Va'etchanan", "Vaetchanan", "Vaeshchanan"] },
  { he: "עקב", en: ["Eikev", "Ekev", "Eykev"] },
  { he: "ראה", en: ["Re'eh", "Reeh", "Re'e", "Reei"] },
  { he: "שפטים", en: ["Shoftim", "Shoftem"] },
  { he: "כי תצא", en: ["Ki Teitzei", "Ki Tetzei", "Ki Seitzei", "Ki Setzei", "Ki Teitze", "Ki Tetze", "Ki Seitze"] },
  { he: "כי תבוא", en: ["Ki Tavo", "Ki Savo", "Ki Tavou", "Ki Savo"] },
  { he: "נצבים", en: ["Nitzavim", "Nitzavim", "Netzavim", "Nitsavim"] },
  { he: "וילך", en: ["Vayeilech", "Vayelech", "Vayelekh", "Vayeilech"] },
  { he: "האזינו", en: ["Ha'azinu", "Haazinu", "Haazinu", "Ha'azeinu", "Haazeinu"] },
  { he: "וזאת הברכה", en: ["Vezot Haberakhah", "Vezos Haberacha", "V'zot HaBerachah", "Vezot Habracha", "Vezos Habracha", "Vezot Haberacha", "Zot Habracha", "Vezos Haberachah"] },
];

/** Lower-case, accents and everything but a-z removed: "Lech-Lecha", "lech lecha" and "Lech  Lecha" are one key. */
function key(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

const BY_KEY: ReadonlyMap<string, string> = new Map(PARSHIYOS.flatMap((p) => p.en.map((n) => [key(n), p.he] as const)));

const PREFIX = /^\s*(?:parshat|parashat|parshas|parashas|parasha|parashah|parsha|sedra|sidra|weekly portion|portion)\b[\s:.\-–—]*/i;

/** The parsha name part of the source's portion line: "Parshat Chayei Sarah, 2nd Portion (Bereshit (Genesis) 23:17-24:9)" -> "Chayei Sarah". */
function nameOf(englishPortion: string): string {
  return englishPortion
    .split("|")[0]!
    .replace(/\(.*$/s, "")
    .replace(/,.*$/s, "")
    .replace(/\bwith\s+rashi\b/i, "")
    .replace(PREFIX, "")
    .trim();
}

/**
 * "פרשת בראשית" for the Chumash portion line the daily source gives ("Parshat Bereishis, 1st Portion ..."), or null when the study is
 * not the Chumash or the name is not one we know (a holiday reading, a spelling not in PARSHIYOS). Double parshiyos
 * ("Vayakhel-Pekudei") give both names joined by a maqaf.
 */
export function hebrewPortionName(study: string, englishPortion: string | null | undefined): string | null {
  if (study !== "chumash" || !englishPortion) return null;
  const name = nameOf(englishPortion);
  if (!name) return null;
  const whole = BY_KEY.get(key(name));
  if (whole) return `פרשת ${whole}`;
  const pair = name.split(/\s*(?:[-–—/&+]|\band\b)\s*/i).filter(Boolean);
  if (pair.length === 2) {
    const a = BY_KEY.get(key(pair[0]!));
    const b = BY_KEY.get(key(pair[1]!));
    if (a && b) return `פרשת ${a}־${b}`;
  }
  return null;
}
