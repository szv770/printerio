import "server-only";
import dns from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import type { SourceKind } from "./link";
import { isAllowedHostname, isBlockedAddress } from "./ssrf";

export type FetchFailure = "bad_link" | "blocked" | "timeout" | "not_found" | "not_shared" | "rate_limited" | "http" | "not_pdf" | "too_big" | "network";

export type FetchPdfResult = { ok: true; bytes: Uint8Array; fileName: string | null } | { ok: false; reason: FetchFailure; message: string };

export interface TransportRequest {
  /** The address already checked and chosen; the connection goes to THIS address, so the name cannot change under us. */
  ip: string;
  hostname: string;
  path: string;
  headers: Record<string, string>;
  timeoutMs: number;
}
export interface TransportResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  destroy(): void;
}
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;
export type Resolver = (hostname: string) => Promise<string[]>;

export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_REDIRECTS = 5;

/** Looks a name up, trying once more if the resolver says "try again" or times out (a flaky network or resolver). */
export async function resolveWithRetry(lookup: (hostname: string) => Promise<string[]>, hostname: string): Promise<string[]> {
  try {
    return await lookup(hostname);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "EAI_AGAIN" || code === "ETIMEOUT" || code === "ETIMEDOUT") return lookup(hostname);
    throw err;
  }
}

const defaultResolve: Resolver = (hostname) => resolveWithRetry(async (h) => (await dns.lookup(h, { all: true })).map((a) => a.address), hostname);

/** Real transport: HTTPS to the chosen IP, with the real hostname for the certificate check (SNI) and the Host header. */
const defaultTransport: Transport = ({ ip, hostname, path, headers, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const req = httpsRequest({ host: ip, port: 443, servername: hostname, method: "GET", path, headers, timeout: timeoutMs }, (res) => {
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: res,
        destroy: () => res.destroy(),
      });
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end();
  });

const fail = (reason: FetchFailure, message: string): FetchPdfResult => ({ ok: false, reason, message });

function headerValue(h: TransportResponse["headers"], name: string): string | undefined {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
}

/** A safe file name from Content-Disposition, or from the end of the address; always ends in .pdf. */
export function fileNameFrom(contentDisposition: string | undefined, url: URL): string | null {
  let name: string | null = null;
  if (contentDisposition) {
    const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(contentDisposition);
    if (star) {
      try {
        name = decodeURIComponent(star[1]!.trim());
      } catch {
        name = null;
      }
    }
    if (!name) {
      const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(contentDisposition);
      if (plain) name = plain[1]!.trim();
    }
  }
  if (!name) {
    const last = decodeURIComponentSafe(url.pathname.split("/").filter(Boolean).pop() ?? "");
    if (/\.pdf$/i.test(last)) name = last;
  }
  if (!name) return null;
  const cleaned = name.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!cleaned) return null;
  return /\.pdf$/i.test(cleaned) ? cleaned : `${cleaned}.pdf`;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function looksLikePdf(bytes: Uint8Array): boolean {
  // The PDF header may be preceded by a little junk, but must be inside the first 1024 bytes.
  const limit = Math.min(bytes.length, 1024);
  const marker = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
  outer: for (let i = 0; i + marker.length <= limit; i++) {
    for (let j = 0; j < marker.length; j++) if (bytes[i + j] !== marker[j]) continue outer;
    return true;
  }
  return false;
}

function looksLikeHtml(bytes: Uint8Array): boolean {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html") || head.startsWith("<?xml") || head.startsWith("<head") || head.startsWith("<body");
}

const GOOGLE_HINT = "Google sent a sign-in or permission page instead of the file. Share the file with \"Anyone with the link\" and try again.";

/**
 * Fetches a PDF from a link for "print from a link". The safety rules, in order, for every hop (the first address and
 * every redirect): https and an ordinary public hostname; every address the name resolves to must be public (one bad
 * answer refuses the lot); the connection is made to the checked address itself; the answer must be a real PDF
 * (checked by its first bytes, never by what the server claims); size and time are capped.
 */
export async function fetchPdf(
  start: URL,
  kind: SourceKind,
  opts: { maxBytes?: number; timeoutMs?: number; resolve?: Resolver; transport?: Transport } = {},
): Promise<FetchPdfResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const resolve = opts.resolve ?? defaultResolve;
  const transport = opts.transport ?? defaultTransport;
  const deadline = Date.now() + timeoutMs;
  const google = kind === "drive" || kind === "docs";

  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password) return fail("bad_link", "That link is not allowed. Use a normal https link to a PDF.");
    const hostname = url.hostname.toLowerCase();
    if (!isAllowedHostname(hostname)) return fail("blocked", "Printio cannot fetch from that address.");

    let addresses: string[];
    try {
      addresses = await resolve(hostname);
    } catch {
      return fail("network", "Printio could not find that website. Check the link.");
    }
    if (addresses.length === 0) return fail("network", "Printio could not find that website. Check the link.");
    if (addresses.some(isBlockedAddress)) return fail("blocked", "Printio cannot fetch from that address.");

    const remaining = deadline - Date.now();
    if (remaining <= 0) return fail("timeout", "The website took too long to answer. Try again.");

    let res: TransportResponse;
    try {
      res = await Promise.race([
        transport({
          ip: addresses[0]!,
          hostname,
          path: `${url.pathname}${url.search}`,
          headers: { Host: hostname, "User-Agent": "Printio/1.0 (print from a link)", Accept: "application/pdf,*/*;q=0.5", "Accept-Encoding": "identity" },
          timeoutMs: remaining,
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })), remaining)),
      ]);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ETIMEDOUT" || (err as Error).message === "timeout") return fail("timeout", "The website took too long to answer. Try again.");
      return fail("network", "Printio could not reach that website. Try again.");
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      res.destroy();
      const location = headerValue(res.headers, "location");
      if (!location) return fail("http", "The website sent Printio somewhere it could not follow.");
      try {
        url = new URL(location, url);
      } catch {
        return fail("http", "The website sent Printio somewhere it could not follow.");
      }
      continue;
    }

    if (res.status !== 200) {
      res.destroy();
      if (res.status === 401 || res.status === 403) return fail("not_shared", google ? GOOGLE_HINT : "That file is not public. Use a link anyone can open without signing in.");
      if (res.status === 404 || res.status === 410) return fail("not_found", "That link does not lead to a file any more. Check the link.");
      if (res.status === 429) return fail("rate_limited", google ? "Google is limiting downloads of this file right now. Try again in a little while." : "The website is limiting requests. Try again in a little while.");
      return fail("http", `The website answered with an error (${res.status}). Try again later.`);
    }

    const declared = Number(headerValue(res.headers, "content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      res.destroy();
      return fail("too_big", `That file is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB limit.`);
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for await (const chunk of res.body) {
        total += chunk.byteLength;
        if (total > maxBytes) {
          res.destroy();
          return fail("too_big", `That file is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB limit.`);
        }
        chunks.push(chunk);
        if (Date.now() > deadline) {
          res.destroy();
          return fail("timeout", "The download took too long. Try again.");
        }
      }
    } catch {
      return fail("network", "The download was interrupted. Try again.");
    }

    const bytes = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.byteLength;
    }
    if (bytes.length === 0) return fail("not_pdf", "That link gave an empty file.");
    if (!looksLikePdf(bytes)) {
      if (looksLikeHtml(bytes)) return fail("not_pdf", google ? GOOGLE_HINT : "That link opens a web page, not a PDF. Open the PDF itself and copy its link.");
      return fail("not_pdf", "That link is not a PDF.");
    }
    return { ok: true, bytes, fileName: fileNameFrom(headerValue(res.headers, "content-disposition"), url) };
  }
  return fail("http", "The link sent Printio around in circles. Check the link.");
}
