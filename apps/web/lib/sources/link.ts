import { isAllowedHostname } from "./ssrf";

/** What kind of link it was, which decides how the file is fetched and how errors are explained. */
export type SourceKind = "drive" | "docs" | "dropbox" | "onedrive" | "image" | "direct";

/** Why a link was refused, in the person's terms; the screen uses it for a short heading. */
export type LinkProblem = "invalid" | "needs_signin" | "folder" | "not_supported";

export type NormalizedLink =
  /** `url` is what gets fetched; `original` is the link as pasted (cleaned of surrounding text), used only to remember it in the browser. */
  | { ok: true; kind: SourceKind; url: URL; original: URL }
  | { ok: false; message: string; problem: LinkProblem };

const MAX_LENGTH = 2000;
const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;

const fail = (message: string, problem: LinkProblem = "invalid"): NormalizedLink => ({ ok: false, message, problem });
const IMAGE_PATH = /\.(jpe?g|png)$/i;

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
  if (url.username || url.password) return fail("That link contains a sign-in or password. Use a link anyone can open without signing in.", "needs_signin");
  if (url.port && url.port !== "443") return fail("That link uses a port Printio does not use. Use a normal link to a PDF.");
  const host = url.hostname.toLowerCase();
  if (!isAllowedHostname(host)) return fail("Printio cannot fetch from that address. Use a link to a public website.");

  // The address Google's PDF viewer shows while you read a Drive file: it only works inside your own signed-in browser.
  if (host.endsWith(".googleusercontent.com") && url.pathname.startsWith("/viewer/")) {
    return fail("That is a temporary viewer address that only works in your own browser. In Google Drive, open the file, press Share, choose \"Anyone with the link\", copy that link and paste it here.", "needs_signin");
  }

  if (host === "drive.google.com" || host === "drive.usercontent.google.com") {
    if (/^\/drive\/(u\/\d+\/)?folders\//.test(url.pathname)) return fail("That is a Google Drive folder. Open the file itself and copy its link.", "folder");
    const id = driveFileId(url);
    if (!id) return fail("That Google Drive link has no file in it. Open the file and copy its share link.", "not_supported");
    const direct = new URL("https://drive.usercontent.google.com/download");
    direct.searchParams.set("id", id);
    direct.searchParams.set("export", "download");
    direct.searchParams.set("confirm", "t");
    const key = url.searchParams.get("resourcekey");
    if (key) direct.searchParams.set("resourcekey", key);
    return { ok: true, kind: "drive", url: direct, original: url };
  }

  if (host === "docs.google.com") {
    const m = /^\/(document|presentation)\/d\/([A-Za-z0-9_-]{10,200})/.exec(url.pathname);
    if (m) {
      const out = new URL(`https://docs.google.com/${m[1]}/d/${m[2]}/${m[1] === "document" ? "export" : "export/pdf"}`);
      if (m[1] === "document") out.searchParams.set("format", "pdf");
      const key = url.searchParams.get("resourcekey");
      if (key) out.searchParams.set("resourcekey", key); // older shared documents only open with their key
      return { ok: true, kind: "docs", url: out, original: url };
    }
    return fail("Printio can open Google Docs and Slides links, or a PDF in Drive. Copy the share link of the file.", "not_supported");
  }

  if (host === "dropbox.com" || host === "www.dropbox.com") return dropboxLink(url);
  if (host === "1drv.ms" || host === "onedrive.live.com") return onedriveLink(url, host);
  if (isWorkOneDrive(host)) {
    return fail("That is a OneDrive or SharePoint link for work or school, which usually needs a sign-in. Download the file and upload it here, or share it from Google Drive or Dropbox with a link anyone can open.", "needs_signin");
  }

  // A link straight to a photo. Only the shape is judged here; the bytes must still be a real JPEG or PNG when fetched.
  if (IMAGE_PATH.test(url.pathname)) return { ok: true, kind: "image", url, original: url };

  return { ok: true, kind: "direct", url, original: url };
}

/**
 * Dropbox share links (/s/<id>/<name> and /scl/fi/<id>/<name>?rlkey=...) become the direct-download form (dl=1). Dropbox
 * answers that with a redirect to dl.dropboxusercontent.com, which the fetcher re-checks like any other hop. Only the
 * parameters the download needs are kept (rlkey is the link's own key; the others are tracking or display options).
 */
function dropboxLink(url: URL): NormalizedLink {
  const path = url.pathname;
  if (/^\/(sh|scl\/fo)(\/|$)/.test(path)) return fail("That is a Dropbox folder. Open the file itself, press Share, and copy its link.", "folder");
  if (/^\/s\/[A-Za-z0-9]+\/[^/]+$/.test(path) || /^\/scl\/fi\/[A-Za-z0-9]+\/[^/]+$/.test(path)) {
    const out = new URL(`https://www.dropbox.com${path}`);
    const key = url.searchParams.get("rlkey");
    if (key) out.searchParams.set("rlkey", key);
    out.searchParams.set("dl", "1");
    return { ok: true, kind: "dropbox", url: out, original: url };
  }
  return fail("That Dropbox link is not a shared file. In Dropbox, open the file, press Share, choose \"Anyone with the link\" and paste that link here.", "not_supported");
}

/** Work and school OneDrive (name-my.sharepoint.com) and SharePoint sites: almost always behind a sign-in. */
function isWorkOneDrive(host: string): boolean {
  return host.endsWith(".sharepoint.com") || host.endsWith(".sharepoint.cn") || host.endsWith(".sharepoint.us");
}

/** What the "ithint" of a OneDrive link says the item is ("file,pdf", "folder", "file,docx"). */
function onedriveItemProblem(url: URL): NormalizedLink | null {
  const hint = (url.searchParams.get("ithint") ?? "").toLowerCase();
  if (!hint) return null;
  if (hint.startsWith("folder")) return fail("That is a OneDrive folder. Open the file itself, press Share, and copy its link.", "folder");
  const type = hint.split(",")[1] ?? "";
  if (type && !["pdf", "jpg", "jpeg", "png"].includes(type)) return fail("Printio can only fetch a PDF or a JPEG/PNG photo from OneDrive. Save that file as a PDF first, or upload it here.", "not_supported");
  return null;
}

/** The 1drv.ms short-link kinds: /b/ is a PDF (or other "browser" file), /i/ an image, /f/ a folder, /w /x /p /o Office files. */
const ONEDRIVE_SHORT = /^\/([a-z])\/((?:c\/[0-9a-f]+\/)?[A-Za-z0-9!_-]+)\/?$/i;

/**
 * Consumer OneDrive share links (1drv.ms short links, onedrive.live.com links with a key) turn into Microsoft's public
 * "shares" download address: api.onedrive.com/v1.0/shares/u!<the link, base64url>/root/content. It needs no sign-in for a
 * link anyone can open and answers with a redirect to the file. Anything else on those hosts (a signed-in viewer page,
 * a link with no key) is refused, because it cannot be turned into a download without a login.
 */
function onedriveLink(url: URL, host: string): NormalizedLink {
  const needsKey = fail("That OneDrive link is a viewer page that needs a sign-in. In OneDrive, open the file, press Share, choose \"Anyone with the link can view\", and paste that link here.", "needs_signin");
  const itemProblem = onedriveItemProblem(url);
  if (itemProblem) return itemProblem;

  let share: URL | null = null;
  if (host === "1drv.ms") {
    const m = ONEDRIVE_SHORT.exec(url.pathname);
    if (!m) return needsKey;
    const letter = m[1]!.toLowerCase();
    if (letter === "f") return fail("That is a OneDrive folder. Open the file itself, press Share, and copy its link.", "folder");
    if (!["b", "i", "u"].includes(letter)) return fail("Printio can only fetch a PDF or a JPEG/PNG photo from OneDrive. Save that file as a PDF first, or upload it here.", "not_supported");
    share = new URL(`https://1drv.ms${url.pathname}`);
  } else if (url.pathname === "/redir" && url.searchParams.get("resid") && url.searchParams.get("authkey")) {
    share = new URL("https://onedrive.live.com/redir");
    share.searchParams.set("resid", url.searchParams.get("resid")!);
    share.searchParams.set("authkey", url.searchParams.get("authkey")!);
  } else if (url.pathname === "/" && url.searchParams.get("redeem")) {
    share = decodeRedeem(url.searchParams.get("redeem")!);
  }
  if (!share) return needsKey;
  const encoded = btoa(share.toString()).replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
  return { ok: true, kind: "onedrive", url: new URL(`https://api.onedrive.com/v1.0/shares/u!${encoded}/root/content`), original: url };
}

/** onedrive.live.com/?redeem=<base64 of the real share link>: only a 1drv.ms or onedrive.live.com address inside is accepted. */
function decodeRedeem(value: string): URL | null {
  try {
    const inner = new URL(new TextDecoder().decode(Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));
    if (inner.protocol !== "https:" || inner.username || inner.password || inner.port) return null;
    if (inner.hostname !== "1drv.ms" && inner.hostname !== "onedrive.live.com") return null;
    return inner;
  } catch {
    return null;
  }
}

function driveFileId(url: URL): string | null {
  const fromPath = /^\/file\/d\/([^/]+)/.exec(url.pathname)?.[1];
  const id = fromPath ?? url.searchParams.get("id");
  return id && DRIVE_ID.test(id) ? id : null;
}
