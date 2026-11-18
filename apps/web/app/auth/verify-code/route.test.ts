import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyOtp = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { verifyOtp } }) }));

const rpc = vi.fn();
vi.mock("@/lib/supabase/service-role", () => ({ createServiceRoleClient: () => ({ rpc }) }));

const finishSignIn = vi.fn();
vi.mock("@/lib/auth/finish-sign-in", () => ({ finishSignIn: (...a: unknown[]) => finishSignIn(...a) }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { POST } from "./route";

const ORIGIN = "https://printio.test";
const user = { id: "u1", email: "a@school.org" };

function call(body: unknown, headers: Record<string, string> = { origin: ORIGIN }) {
  return POST(
    new Request(`${ORIGIN}/auth/verify-code`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: true, error: null });
  verifyOtp.mockResolvedValue({ data: { user }, error: null });
  finishSignIn.mockResolvedValue(new Response(null, { status: 307, headers: { location: `${ORIGIN}/` } }));
});

describe("POST /auth/verify-code", () => {
  it("verifies the emailed code on the server, finishes sign-in and returns where to go", async () => {
    const res = await call({ email: " A@School.org ", code: "123456" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redirect: "/" });
    expect(verifyOtp).toHaveBeenCalledWith({ email: "a@school.org", token: "123456", type: "email" });
    expect(finishSignIn).toHaveBeenCalledTimes(1);
  });

  it("passes a plausible invite code along and ignores an implausible one", async () => {
    await call({ email: "a@school.org", code: "123456", invite: "a1b2c3d4e5f6" });
    expect(finishSignIn.mock.calls[0]?.[3]).toMatchObject({ code: "a1b2c3d4e5f6" });
    finishSignIn.mockClear();
    await call({ email: "a@school.org", code: "123456", invite: "bad code!" });
    expect(finishSignIn.mock.calls[0]?.[3]).toBeUndefined();
  });

  it("rejects malformed input without touching Supabase", async () => {
    expect((await call({ email: "nope", code: "123456" })).status).toBe(400);
    expect((await call({ email: "a@school.org", code: "12ab56" })).status).toBe(400);
    expect((await call("not json")).status).toBe(400);
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request", async () => {
    const res = await call({ email: "a@school.org", code: "123456" }, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("is rate limited per email and per IP, before the code is checked", async () => {
    rpc.mockResolvedValueOnce({ data: false, error: null });
    const res = await call({ email: "a@school.org", code: "123456" });
    expect(res.status).toBe(429);
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("answers a wrong or expired code with one plain message (nothing about whether the email exists)", async () => {
    verifyOtp.mockResolvedValue({ data: { user: null }, error: { message: "Token has expired or is invalid" } });
    const res = await call({ email: "a@school.org", code: "000000" });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/didn't work|expired/i);
    expect(finishSignIn).not.toHaveBeenCalled();
  });
});
