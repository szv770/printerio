import { isAllowedHostname } from "./ssrf";

/** What kind of link it was, which decides how the file is fetched and how errors are explained. */
export type SourceKind = "drive" | "docs" | "direct";

export type NormalizedLink = { ok: true; kind: SourceKind; url: URL } | { ok: false; message: string };

const MAX_LENGTH = 2000;
const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;

const fail = (message: string): NormalizedLink => ({ ok: false, message });

/** The first thing in the text that looks like a link (people paste whole messages). */
function pickLink(text: string): string {
  const withScheme = /https?:\/\/[^\s<>"')]+/i.exec(text);
  if (withScheme) return withScheme[0];
  const trimmed = text.trim();
  // "drive.google.com/file/..." with the scheme left off.
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

/**
 * Turns whatever was pasted into an address we are willing to fetch: https only, an ordinary public hostname, the
 * default port, no login in the address. Google Drive file links (every form of them) become the direct-download
 * address and Google Docs / Slides links become their PDF export. Folders and web pages are refused with a reason.
 * This only checks the SHAPE; the address a name resolves to is checked again at fetch time (lib/sources/fetch-pdf.ts).
 */
export function normalizeSourceLink(input: string): NormalizedLink {
  const text = input.trim();
  if (!text) return fail("Paste a link to a PDF.");
  if (text.length > MAX_LENGTH) return fail("That link is too long. Paste just the link to the PDF.");

  const picked = pickLink(text);
  let url: URL;
  try {
    url = new URL(picked);
  } catch {
    return fail("That does not look like a link. Paste the full link to a PDF.");
  }
  if (url.protocol !== "https:") return fail("Only https links work. Check the link starts with https://");
  if (url.username || url.password) return fail("That link contains a sign-in or password. Use a link anyone can open without signing in.");
  if (url.port && url.port !== "443") return fail("That link uses a port Printio does not use. Use a normal link to a PDF.");
  const host = url.hostname.toLowerCase();
  if (!isAllowedHostname(host)) return fail("Printio cannot fetch from that address. Use a link to a public website.");

  if (host === "drive.google.com" || host === "drive.usercontent.google.com") {
    if (/^\/drive\/(u\/\d+\/)?folders\//.test(url.pathname)) return fail("That is a Google Drive folder. Open the file itself and copy its link.");
    const id = driveFileId(url);
    if (!id) return fail("That Google Drive link has no file in it. Open the file and copy its share link.");
    const direct = new URL("https://drive.usercontent.google.com/download");
    direct.searchParams.set("id", id);
    direct.searchParams.set("export", "download");
    direct.searchParams.set("confirm", "t");
    const key = url.searchParams.get("resourcekey");
    if (key) direct.searchParams.set("resourcekey", key);
    return { ok: true, kind: "drive", url: direct };
  }

  if (host === "docs.google.com") {
    const m = /^\/(document|presentation)\/d\/([A-Za-z0-9_-]{10,200})/.exec(url.pathname);
    if (m) {
      const out = new URL(`https://docs.google.com/${m[1]}/d/${m[2]}/${m[1] === "document" ? "export" : "export/pdf"}`);
      if (m[1] === "document") out.searchParams.set("format", "pdf");
      const key = url.searchParams.get("resourcekey");
      if (key) out.searchParams.set("resourcekey", key); // older shared documents only open with their key
      return { ok: true, kind: "docs", url: out };
    }
    return fail("Printio can open Google Docs and Slides links, or a PDF in Drive. Copy the share link of the file.");
  }

  return { ok: true, kind: "direct", url };
}

function driveFileId(url: URL): string | null {
  const fromPath = /^\/file\/d\/([^/]+)/.exec(url.pathname)?.[1];
  const id = fromPath ?? url.searchParams.get("id");
  return id && DRIVE_ID.test(id) ? id : null;
}
