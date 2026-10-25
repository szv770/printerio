import { beforeEach, describe, expect, it, vi } from "vitest";

const getCurrentSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({ getCurrentSession: () => getCurrentSession() }));
vi.mock("@/lib/env", () => ({ getGatewayEnv: () => ({ sharedSecret: "x", baseDomain: "szvtech.org" }) }));

import { POST } from "./route";

const HOST = "u-abcdefghijklmnopqrstuvwxyz234567abcdefg.szvtech.org";

function post(fields: Record<string, string>, headers: Record<string, string> = { origin: "https://printio.test" }) {
  const body = new URLSearchParams(fields);
  return POST(new Request("https://printio.test/api/devices/airprint-profile", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body }));
}

beforeEach(() => {
  getCurrentSession.mockResolvedValue({ userId: "u1", membership: { organization_id: "o1" } });
});

describe("POST /api/devices/airprint-profile", () => {
  it("returns an installable profile for a signed-in member, as a download", async () => {
    const res = await post({ hostname: HOST, name: "Printio-MLMI-SZV" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-apple-aspen-config");
    expect(res.headers.get("content-disposition")).toContain('attachment; filename="Printio.mobileconfig"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(text).toContain(HOST);
    expect(text).toContain("com.apple.airprint");
  });
  it("needs a signed-in member of an organization", async () => {
    getCurrentSession.mockResolvedValue(null);
    expect((await post({ hostname: HOST })).status).toBe(401);
    getCurrentSession.mockResolvedValue({ userId: "u1", membership: null });
    expect((await post({ hostname: HOST })).status).toBe(403);
  });
  it("refuses a hostname that is not a device address on our own domain, and cross-site posts", async () => {
    expect((await post({ hostname: "u-abcdefghijklmnopqrstuvwxyz234567abcdefg.evil.example" })).status).toBe(400);
    expect((await post({ hostname: "printio.szvtech.org" })).status).toBe(400);
    expect((await post({ hostname: HOST }, { origin: "https://evil.example" })).status).toBe(403);
  });
  it("falls back to a plain name when none (or a silly one) is given", async () => {
    const text = await (await post({ hostname: HOST, name: "<script>".repeat(30) })).text();
    expect(text).not.toContain("<script>");
  });
});
