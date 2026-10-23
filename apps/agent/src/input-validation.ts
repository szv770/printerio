// Validation of every cloud-supplied string that reaches a file path, a process argument or a download (F10).
// The cloud is trusted over TLS, but if the web app or its database were compromised the agent must not become a
// LAN foothold (fetch internal URLs, fill the disk, write outside its folder, smuggle printer commands).
import net from "node:net";

/** Largest document the agent will download (the web app's upload limit is far below this). */
export const MAX_DOWNLOAD_BYTES = 120 * 1024 * 1024;

const BACKSLASH = String.fromCharCode(92);

/** Job ids become part of a local file name: UUIDs (and the short ids used in tests), never path syntax. */
export function isSafeJobId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

/** A single safe path segment from a cloud-supplied file name. Never empty, never "..", never a Windows device name. */
export function sanitizeLocalFileName(fileName: unknown): string {
  const raw = typeof fileName === "string" ? fileName : "";
  const last = raw.split("/").flatMap((p) => p.split(BACKSLASH)).pop() ?? "";
  let base = last.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
  base = base.replace(/\.+$/, "");
  if (!base || /^\.+$/.test(base)) return "job.pdf";
  if (RESERVED.test(base)) base = `_${base}`;
  return base;
}

/** Windows queue names go to SumatraPDF as one argv entry after -print-to: no option lookalikes, no control characters. */
export function validateQueueName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  const t = name.trim();
  if (!t || t.length > 256) return false;
  if (t.startsWith("-")) return false;
  return !/[\x00-\x1f\x7f]/.test(name);
}

export interface DownloadUrlPolicy {
  /** If set, only these hosts (exact, or a parent domain such as "supabase.co") may be fetched. */
  allowedHosts?: string[];
  /** Tests/dev only: allow http and loopback/private hosts. */
  allowLocal?: boolean;
}

export function parseAllowedDownloadHosts(value: string | undefined): string[] | undefined {
  const list = (value ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

export function validateDownloadUrl(raw: unknown, policy: DownloadUrlPolicy = {}): { ok: true; url: URL } | { ok: false; reason: string } {
  if (typeof raw !== "string" || !raw) return { ok: false, reason: "no download URL" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "download URL is not a valid URL" };
  }
  const local = policy.allowLocal === true;
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return { ok: false, reason: "download URL must be https" };
  if (url.username || url.password) return { ok: false, reason: "download URL must not carry credentials" };
  // WHATWG parsing already normalises decimal/hex/octal IPv4 forms ("2130706433", "0x7f.1") to dotted quads.
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!local) {
    if (net.isIP(host)) return { ok: false, reason: "download URL must use a host name, not an IP address" };
    if (!host.includes(".") || /(^|\.)(localhost|local|internal|lan|home|corp|intranet)$/.test(host)) {
      return { ok: false, reason: "download URL host is not a public internet host" };
    }
  }
  const allowed = policy.allowedHosts;
  if (allowed && !allowed.some((a) => host === a || host.endsWith(`.${a}`))) {
    return { ok: false, reason: "download URL host is not on this server's allowed list (PRINTIO_DOWNLOAD_ALLOWED_HOSTS)" };
  }
  return { ok: true, url };
}
