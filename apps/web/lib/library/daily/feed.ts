/**
 * Chabad.org's Daily Study RSS feed: says which portion applies on a date. It carries no text; the text comes from the pages the
 * items link to (see docs/daily-study.md). The feed is plain XML meant for programs and answers ordinary requests; the site's article
 * pages sit behind Cloudflare's check, which we never try to get past.
 */
export type DailyStudy = "chumash" | "tehillim" | "tanya" | "hayomyom" | "mitzvah" | "rambam1" | "rambam3";

export interface DailyItem {
  study: DailyStudy;
  title: string;
  /** What is learned that day, e.g. "Issurei Biah - Chapter 13". */
  portion: string;
  /** The page with the text. */
  url: string;
}

export interface DailyDay {
  /** ISO date, e.g. 2026-11-01. */
  date: string;
  hebrewDate: string;
  items: DailyItem[];
}

const FEED = "https://www.chabad.org/tools/rss/dailystudy_rss.xml";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Title as the feed words it -> the study the library knows. Hebrew-only Tehillim and the others are not offered. */
function studyFor(title: string): DailyStudy | null {
  if (/^Daily Chumash with Rashi/i.test(title)) return "chumash";
  if (/^Daily Tehilim - Psalms$/i.test(title)) return "tehillim";
  if (/^Daily Tanya/i.test(title)) return "tanya";
  if (/^Hayom Yom/i.test(title)) return "hayomyom";
  if (/^Daily Mitzvah/i.test(title)) return "mitzvah";
  if (/^Daily Rambam - 1 Chapter/i.test(title)) return "rambam1";
  if (/^Daily Rambam - 3 Chapter/i.test(title)) return "rambam3";
  return null;
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, name: string): string {
  return decode(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block)?.[1] ?? "");
}

/** ISO date -> the M/D/YYYY the feed and the study pages use. */
export function formatFeedDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error("Date must look like 2026-11-08.");
  return `${Number(m[2])}/${Number(m[3])}/${m[1]}`;
}

export function dailyFeedUrl(iso?: string): string {
  return iso ? `${FEED}?tdate=${formatFeedDate(iso)}` : FEED;
}

function safeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.hostname !== "www.chabad.org") return null;
    if (/mode/i.test(u.search)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function parseDailyFeed(xml: string): DailyDay {
  const head = xml.split(/<item>/)[0] ?? "";
  const title = /^Chabad\.org Daily Study - (\w+) (\d{1,2}), (\d{4}) - (.+)$/.exec(tag(head, "title"));
  const month = title ? MONTHS.indexOf(title[1]) : -1;
  if (!title || month < 0 || !/<rss[\s>]/.test(xml)) throw new Error("This is not the Chabad.org Daily Study feed.");
  const date = `${title[3]}-${String(month + 1).padStart(2, "0")}-${String(Number(title[2])).padStart(2, "0")}`;
  const items: DailyItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1] ?? "";
    const itemTitle = tag(block, "title");
    const study = studyFor(itemTitle);
    const url = safeUrl(tag(block, "link"));
    if (!study || !url || items.some((i) => i.study === study)) continue;
    const portion = tag(block, "description").replace(/^Today's (Lessons?|Psalms|Tehillim):\s*/i, "");
    items.push({ study, title: itemTitle, portion, url });
  }
  return { date, hebrewDate: (title[4] ?? "").trim(), items };
}
