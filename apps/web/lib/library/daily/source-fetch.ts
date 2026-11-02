import { parseShiurPage, shiurUrl, SHIUR_ORIGIN, type ShiurDay } from "./source";

const MAX_BYTES = 3 * 1024 * 1024;

export type ShiurFetch = { ok: true; day: ShiurDay; url: string } | { ok: false; reason: "unreachable" | "different" };

/**
 * One request for one day's booklet page: what a person opening the page and making a booklet would send. A size and time limit,
 * the page must stay on the source's own address, and it must be the day asked for.
 */
export async function fetchShiurDay(date: string): Promise<ShiurFetch> {
  const url = shiurUrl(date);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "Printio/1.0 (daily study booklet)", accept: "text/html" },
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
    if (!res.ok || (res.url && new URL(res.url).origin !== SHIUR_ORIGIN)) return { ok: false, reason: "unreachable" };
    const html = await res.text();
    if (html.length > MAX_BYTES) return { ok: false, reason: "unreachable" };
    const day = parseShiurPage(html);
    if (!day || day.date !== date) return { ok: false, reason: "different" };
    return { ok: true, day, url };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}
