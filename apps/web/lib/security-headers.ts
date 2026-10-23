/**
 * Security response headers for every route (security review F7). Built here, as plain functions, so next.config.ts
 * stays small and the values can be unit-tested.
 *
 * The Content-Security-Policy is deliberately REPORT-ONLY for now: it never blocks anything, it only makes the
 * browser console (DevTools -> Console, "[Report Only]") show what an enforced policy would have blocked. Look at
 * every page once (print form, booklet preview, jobs, admin) and only then consider enforcing it. A full
 * nonce-based script policy is a later step; until then Next's inline bootstrap needs 'unsafe-inline'.
 *
 * Strict-Transport-Security is NOT set here: the host (Vercel) already sends it, and an includeSubDomains value set
 * from the app would also reach the other szvtech.org hosts (the print-dialog gateway tunnels).
 */

export interface SecurityHeaderOptions {
  /** NEXT_PUBLIC_SUPABASE_URL: the one external origin the browser talks to (auth, realtime). */
  supabaseUrl?: string;
  /** Development adds 'unsafe-eval' (React Refresh needs it). Never true in production builds. */
  dev?: boolean;
}

export interface HeaderEntry {
  key: string;
  value: string;
}

/** The Supabase origin as https + wss (or http + ws for a local stack); nothing for a missing or malformed URL. */
function supabaseOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return [];
    return [u.origin, `${u.protocol === "https:" ? "wss" : "ws"}://${u.host}`];
  } catch {
    return [];
  }
}

export function buildContentSecurityPolicy(opts: SecurityHeaderOptions): string {
  const connect = ["'self'", ...supabaseOrigins(opts.supabaseUrl)];
  const scripts = ["'self'", "'unsafe-inline'", ...(opts.dev ? ["'unsafe-eval'"] : [])];
  return [
    "default-src 'self'",
    `script-src ${scripts.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    // Thumbnails and the booklet preview are drawn to canvases / blob: and data: URLs.
    "img-src 'self' blob: data:",
    // Inter comes from next/font (self-hosted).
    "font-src 'self' data:",
    // pdf.js worker: a file from this origin, or a blob: URL it creates.
    "worker-src 'self' blob:",
    `connect-src ${connect.join(" ")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function buildSecurityHeaders(opts: SecurityHeaderOptions): HeaderEntry[] {
  return [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Frame-Options", value: "DENY" },
    {
      key: "Permissions-Policy",
      value: [
        "camera",
        "microphone",
        "geolocation",
        "payment",
        "usb",
        "bluetooth",
        "serial",
        "midi",
        "magnetometer",
        "gyroscope",
        "accelerometer",
        "display-capture",
        "interest-cohort",
      ]
        .map((f) => `${f}=()`)
        .join(", "),
    },
    { key: "Content-Security-Policy-Report-Only", value: buildContentSecurityPolicy(opts) },
  ];
}
