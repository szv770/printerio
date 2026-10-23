import { afterEach, describe, expect, it, vi } from "vitest";
import { buildContentSecurityPolicy, buildSecurityHeaders } from "./security-headers";

const SUPABASE = "https://abcdefgh.supabase.co";
const byKey = (h: Array<{ key: string; value: string }>) => Object.fromEntries(h.map((x) => [x.key, x.value]));

describe("buildSecurityHeaders", () => {
  it("sets the fixed hardening headers", () => {
    const h = byKey(buildSecurityHeaders({ supabaseUrl: SUPABASE }));
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["X-Frame-Options"]).toBe("DENY");
    for (const feature of ["camera", "microphone", "geolocation", "payment", "usb", "bluetooth", "serial", "midi", "magnetometer", "gyroscope", "accelerometer", "display-capture", "interest-cohort"]) {
      expect(h["Permissions-Policy"], feature).toContain(`${feature}=()`);
    }
  });

  it("sends the CSP as Report-Only and never as an enforced header (observe first)", () => {
    const keys = buildSecurityHeaders({ supabaseUrl: SUPABASE }).map((x) => x.key);
    expect(keys).toContain("Content-Security-Policy-Report-Only");
    expect(keys).not.toContain("Content-Security-Policy");
  });

  it("does not set Strict-Transport-Security (the host already sends it; includeSubDomains here would reach the IPP gateway hosts)", () => {
    expect(buildSecurityHeaders({ supabaseUrl: SUPABASE }).map((x) => x.key)).not.toContain("Strict-Transport-Security");
  });
});

describe("buildContentSecurityPolicy", () => {
  const csp = buildContentSecurityPolicy({ supabaseUrl: SUPABASE });
  const directive = (name: string) => csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(name + " ") || d === name);

  it("locks framing, plugins, base and form targets", () => {
    expect(directive("frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive("object-src")).toBe("object-src 'none'");
    expect(directive("base-uri")).toBe("base-uri 'self'");
    expect(directive("form-action")).toBe("form-action 'self'");
    expect(directive("default-src")).toBe("default-src 'self'");
  });

  it("allows what the app really loads: blob:/data: images, pdf.js worker from self/blob:, Supabase over https and wss", () => {
    expect(directive("img-src")).toBe("img-src 'self' blob: data:");
    expect(directive("worker-src")).toBe("worker-src 'self' blob:");
    expect(directive("connect-src")).toBe(`connect-src 'self' ${SUPABASE} wss://abcdefgh.supabase.co`);
    expect(directive("font-src")).toContain("'self'");
    expect(directive("script-src")).toContain("'unsafe-inline'"); // Next's inline bootstrap; nonces are a later step
    expect(directive("script-src")).not.toContain("'unsafe-eval'");
    expect(directive("script-src")).not.toMatch(/https?:/);
  });

  it("falls back to 'self' only when no Supabase URL is configured, and ignores a malformed one", () => {
    expect(buildContentSecurityPolicy({ supabaseUrl: undefined })).toContain("connect-src 'self';");
    expect(buildContentSecurityPolicy({ supabaseUrl: "not a url" })).toContain("connect-src 'self';");
    expect(buildContentSecurityPolicy({ supabaseUrl: "javascript:alert(1)" })).toContain("connect-src 'self';");
  });

  it("allows eval only in development (React Refresh)", () => {
    expect(buildContentSecurityPolicy({ supabaseUrl: SUPABASE, dev: true })).toContain("'unsafe-eval'");
  });
});

describe("next.config headers()", () => {
  it("applies the security headers to every route", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE);
    const mod = await import("../next.config");
    const rules = await mod.default.headers!();
    const all = rules.find((r) => r.source === "/(.*)");
    expect(all).toBeDefined();
    const h = byKey(all!.headers);
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Content-Security-Policy-Report-Only"]).toContain("frame-ancestors 'none'");
    expect(h["Content-Security-Policy-Report-Only"]).toContain(SUPABASE);
  });
  afterEach(() => vi.unstubAllEnvs());
});
