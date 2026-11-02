import { dailyFeedUrl, parseDailyFeed, type DailyDay } from "./feed";

const MAX_FEED_BYTES = 200 * 1024;

/**
 * Chabad.org's feed for one date: an ordinary request to a public feed, with a size and time limit. Null when it cannot be read
 * or is not the date asked for. `cacheSeconds` lets the web server reuse an answer instead of asking the site on every click.
 */
export async function fetchDailyFeed(date: string, cacheSeconds = 0): Promise<DailyDay | null> {
  try {
    const res = await fetch(dailyFeedUrl(date), {
      headers: { "user-agent": "Printio/1.0 (daily study list)", accept: "application/rss+xml, text/xml" },
      signal: AbortSignal.timeout(15_000),
      ...(cacheSeconds > 0 ? { next: { revalidate: cacheSeconds } } : { cache: "no-store" as const }),
    });
    if (!res.ok || !/xml/i.test(res.headers.get("content-type") ?? "")) return null;
    const xml = await res.text();
    if (xml.length > MAX_FEED_BYTES) return null;
    const day = parseDailyFeed(xml);
    return day.date === date ? day : null;
  } catch {
    return null;
  }
}
